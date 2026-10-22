//! Extensions' secrets, kept encrypted: the database holds only what the kernel's own key
//! opens, and that key is a file of its own beside the extensions, readable by the kernel's
//! user only. A copy of the database alone reveals no secret.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use base64::Engine;
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce, aead::Aead};
use serde_json::Value;

/// What an encrypted value starts with; anything else was kept before secrets were encrypted.
const SEALED: &str = "sealed:v1:";

pub struct Vault {
    file: PathBuf,
    cipher: std::sync::OnceLock<ChaCha20Poly1305>,
}

impl Vault {
    /// The vault whose key is `file`, made the first time a secret is kept.
    pub fn at(file: PathBuf) -> Self {
        Self {
            file,
            cipher: std::sync::OnceLock::new(),
        }
    }

    fn cipher(&self) -> Result<&ChaCha20Poly1305> {
        if let Some(cipher) = self.cipher.get() {
            return Ok(cipher);
        }
        let key = load_or_make(&self.file)?;
        let cipher = ChaCha20Poly1305::new_from_slice(&key).context("Invalid vault key")?;
        Ok(self.cipher.get_or_init(|| cipher))
    }

    /// The value, encrypted, as it is stored.
    pub fn seal(&self, value: &Value) -> Result<Value> {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).context("No randomness for a secret")?;
        let sealed = self
            .cipher()?
            .encrypt(&Nonce::from(nonce), value.to_string().as_bytes())
            .map_err(|_| anyhow::anyhow!("A secret could not be encrypted"))?;
        let mut bytes = nonce.to_vec();
        bytes.extend(sealed);
        Ok(Value::String(format!(
            "{SEALED}{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes)
        )))
    }

    /// The value as it was kept; one stored before secrets were encrypted is given as it is.
    pub fn open(&self, stored: Value) -> Result<Value> {
        let Some(sealed) = stored.as_str().and_then(|text| text.strip_prefix(SEALED)) else {
            return Ok(stored);
        };
        let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(sealed)
            .context("A secret is damaged")?;
        if bytes.len() < 12 {
            bail!("A secret is damaged");
        }
        let (nonce, sealed) = bytes.split_at(12);
        let nonce = Nonce::try_from(nonce).context("A secret is damaged")?;
        let plain = self
            .cipher()?
            .decrypt(&nonce, sealed)
            .map_err(|_| anyhow::anyhow!("A secret cannot be opened with this kernel's key"))?;
        Ok(serde_json::from_slice(&plain)?)
    }
}

fn load_or_make(file: &Path) -> Result<Vec<u8>> {
    match std::fs::read(file) {
        Ok(key) if key.len() == 32 => return Ok(key),
        Ok(_) => bail!("The vault key {} is damaged", file.display()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(error).context("The vault key cannot be read");
        }
        Err(_) => {}
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).context("No randomness for the vault key")?;
    // Written whole beside it, then put in place: never half a key.
    let staged = file.with_extension("new");
    write_private(&staged, &key)?;
    std::fs::rename(&staged, file)?;
    Ok(key.to_vec())
}

#[cfg(unix)]
fn write_private(file: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?;
    out.write_all(bytes)?;
    out.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(file: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(file, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_secret_is_kept_sealed_and_only_its_key_opens_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::at(dir.path().join("vault.key"));
        let secret = json!({"refresh_token": "r-1"});
        let sealed = vault.seal(&secret).unwrap();
        assert!(!sealed.to_string().contains("r-1"));
        assert_eq!(vault.open(sealed.clone()).unwrap(), secret);
        // The same key, read again from its file.
        assert_eq!(
            Vault::at(dir.path().join("vault.key"))
                .open(sealed.clone())
                .unwrap(),
            secret
        );
        // Another kernel's key does not.
        let other = Vault::at(dir.path().join("other.key"));
        assert!(other.open(sealed).is_err());
        // What was kept before encryption reads as it was.
        assert_eq!(vault.open(json!("plain")).unwrap(), json!("plain"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("vault.key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
