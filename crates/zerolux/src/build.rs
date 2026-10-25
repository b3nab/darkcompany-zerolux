//! The identity of this executable, independent of the update channel a person chooses.

use std::sync::LazyLock;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BuildInfo {
    pub version: &'static str,
    pub channel: &'static str,
    pub commit: &'static str,
    pub built_at: String,
    pub dirty: bool,
    pub schema: &'static str,
}

fn date() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(env!("ZEROLUX_BUILD_BUILT_AT"))
        .map(|at| at.with_timezone(&Utc))
        .unwrap_or_else(|_| {
            DateTime::from_timestamp(env!("ZEROLUX_BUILD_UNIX").parse().unwrap(), 0).unwrap()
        })
}

pub fn commit() -> &'static str {
    match env!("ZEROLUX_BUILD_COMMIT") {
        "" => env!("ZEROLUX_SOURCE_COMMIT"),
        commit => commit,
    }
}

pub fn dirty() -> bool {
    env!("ZEROLUX_SOURCE_DIRTY") == "true"
}

pub fn schema() -> &'static str {
    env!("ZEROLUX_BUILD_SCHEMA")
}

/// Local builds use nightly number zero; published nightlies start at one.
pub fn version() -> &'static str {
    static VERSION: LazyLock<String> = LazyLock::new(|| {
        let published = env!("ZEROLUX_BUILD_VERSION");
        if !published.is_empty() {
            return published.to_owned();
        }
        let package = semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("package version");
        let source = commit().get(..7).unwrap_or("unknown");
        let changed = if dirty() { ".dirty" } else { "" };
        format!(
            "{}.{}.{}-alpha.{}.0+g{source}.t{}{changed}",
            package.major,
            package.minor,
            package.patch,
            date().format("%Y%m%d"),
            date().format("%H%M%S")
        )
    });
    &VERSION
}

pub fn channel() -> &'static str {
    match env!("ZEROLUX_BUILD_CHANNEL") {
        "nightly" => "nightly",
        "beta" => "beta",
        "stable" => "stable",
        _ if version().contains("-beta.") || version().contains("-rc.") => "beta",
        _ if version().contains('-') => "nightly",
        _ => "stable",
    }
}

pub fn info() -> BuildInfo {
    BuildInfo {
        version: version(),
        channel: channel(),
        commit: commit(),
        built_at: date().to_rfc3339_opts(SecondsFormat::Secs, true),
        dirty: dirty(),
        schema: schema(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn build_identity_is_valid_and_serializable() {
        let build = super::info();
        assert!(semver::Version::parse(build.version).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&build.built_at).is_ok());
        assert!(matches!(build.channel, "nightly" | "beta" | "stable"));
        assert_eq!(
            serde_json::to_value(&build).unwrap()["version"],
            build.version
        );
    }
}
