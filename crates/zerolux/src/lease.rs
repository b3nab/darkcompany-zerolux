//! One running kernel per SQLite workspace, whatever started it (CLI, desktop, a second
//! copy of either): `<database>.lock` next to the file, so every alias of the same data
//! meets the same lease, held until cleanup ends. A PostgreSQL workspace is served by as
//! many kernels as are started for it; each keeps to its own agent sessions.

use std::path::Path;

use anyhow::{Context, Result};

use crate::db::Location;

/// Held for the kernel's lifetime; dropping it releases the workspace.
pub struct Lease(#[allow(dead_code)] Option<std::fs::File>);

impl Lease {
    pub fn acquire(location: &Location) -> Result<Self> {
        match location {
            Location::Sqlite(path) => file(path).map(|file| Self(Some(file))),
            Location::Postgres(_) => Ok(Self(None)),
        }
    }
}

fn file(database: &Path) -> Result<std::fs::File> {
    // The directory exists by now; the database may not yet. Resolve the directory, keep the
    // file name: a symlinked database still maps to one lease.
    let directory = database
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let directory = dunce::canonicalize(directory)
        .with_context(|| format!("Resolve the data directory {}", directory.display()))?;
    let name = database
        .file_name()
        .context("The database path must name a file")?;
    let real = match dunce::canonicalize(database) {
        Ok(real) => real,
        Err(_) => directory.join(name),
    };
    // Hard links are not unified by canonicalize: a database reachable under two names
    // would get two leases. Refuse rather than guess.
    #[cfg(unix)]
    if let Ok(metadata) = std::fs::metadata(&real) {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            metadata.nlink() <= 1,
            "The database {} has more than one hard link; a workspace must have one path",
            real.display()
        );
    }
    let path = real.with_extension("db.lock");
    let mut open = std::fs::OpenOptions::new();
    open.read(true).write(true).create(true).truncate(false);
    // Never follow a symlink planted at the lease path, without a check-then-open race.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        anyhow::ensure!(
            metadata.file_type().is_file(),
            "The kernel lease {} must be a regular file",
            path.display()
        );
    }
    let file = open
        .open(&path)
        .with_context(|| format!("Open the kernel lease {}", path.display()))?;
    fs2::FileExt::try_lock_exclusive(&file).with_context(|| {
        format!(
            "Another ZeroLux kernel already serves {}. Stop it, or point this one at its address instead of its data.",
            database.display()
        )
    })?;
    Ok(file)
}
