//! Structured logging: env-driven level control, JSONL output, daily rotation.
//!
//! Callers provide their own env var name and log directory via [`Config`];
//! this module only wires them into a `tracing` subscriber that writes
//! newline-delimited JSON, one file per day, keeping the most recent
//! `retention` files.

use std::path::{Path, PathBuf};
use std::sync::Once;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

const DEFAULT_LEVEL: &str = "info";
const DEFAULT_RETENTION: usize = 7;

/// Configuration for [`init`].
#[derive(Debug, Clone)]
pub struct Config {
    /// Env var read for the `EnvFilter` directive (`info`, `debug`, or any
    /// other `tracing_subscriber::EnvFilter` directive such as
    /// `my_crate=debug`). The case-insensitive value `off` disables logging
    /// entirely. Empty or unset falls back to `info`.
    pub env_var: String,
    /// Directory the rotated JSONL log files are written to. Created if missing.
    pub dir: PathBuf,
    /// Prefix for rotated file names: `<filename_prefix>.YYYY-MM-DD`.
    pub filename_prefix: String,
    /// Number of rotated files to retain. `0` disables pruning entirely
    /// (matches `tracing-appender`'s `max_log_files` semantics) rather than
    /// retaining none.
    pub retention: usize,
}

impl Config {
    pub fn new(
        env_var: impl Into<String>,
        dir: impl Into<PathBuf>,
        filename_prefix: impl Into<String>,
    ) -> Self {
        Self {
            env_var: env_var.into(),
            dir: dir.into(),
            filename_prefix: filename_prefix.into(),
            retention: DEFAULT_RETENTION,
        }
    }
}

/// Failure to wire up the JSONL file sink. Callers decide how to surface this
/// (log a warning and continue, exit, etc.) since the acceptable tolerance
/// for a logging failure is application-specific.
#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("failed to create log directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to build log file appender in {path}: {source}")]
    BuildAppender {
        path: PathBuf,
        #[source]
        source: tracing_appender::rolling::InitError,
    },
    /// A subscriber other than the one built by [`init`] already claimed the
    /// global default before `init`'s first call — e.g. another component in
    /// the same process called `tracing_subscriber::fmt().init()` first.
    /// [`init`]'s own idempotency (a second call is a no-op) is handled
    /// separately and never reaches this variant.
    #[error("a tracing subscriber is already installed globally: {0}")]
    SubscriberAlreadySet(#[from] tracing_subscriber::util::TryInitError),
}

/// Resolves the raw env var value into an `EnvFilter` directive, or `None`
/// when logging is disabled via the `off` sentinel.
///
/// Takes the already-read value rather than reading `std::env` itself so it
/// stays unit-testable without mutating process-global env state.
fn resolve_level(raw: Option<&str>) -> Option<String> {
    let level = raw.filter(|s| !s.is_empty()).unwrap_or(DEFAULT_LEVEL);
    (!level.eq_ignore_ascii_case("off")).then(|| level.to_string())
}

fn build_subscriber(
    dir: &Path,
    filename_prefix: &str,
    retention: usize,
    level: &str,
) -> Result<Box<dyn tracing::Subscriber + Send + Sync>, InitError> {
    std::fs::create_dir_all(dir).map_err(|source| InitError::CreateDir {
        path: dir.to_path_buf(),
        source,
    })?;

    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(filename_prefix)
        .max_log_files(retention)
        .build(dir)
        .map_err(|source| InitError::BuildAppender {
            path: dir.to_path_buf(),
            source,
        })?;

    // EnvFilter accepts `info`, `my_crate=debug`, etc. Fall back to `info` on
    // a malformed directive instead of failing init over a typo'd env var.
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new(DEFAULT_LEVEL));

    let layer = fmt::layer()
        .with_writer(appender)
        .with_ansi(false)
        .with_target(true)
        .json()
        .flatten_event(true)
        .with_current_span(true)
        .with_span_list(false);

    Ok(Box::new(
        tracing_subscriber::registry().with(filter).with(layer),
    ))
}

/// Resolves the level and, unless disabled, builds and installs the
/// subscriber. Split out from [`init`] so the disabled/off early return is
/// exercised without going through the process-wide [`INIT`] guard.
fn build_and_install(config: &Config, raw: Option<&str>) -> Result<(), InitError> {
    let Some(level) = resolve_level(raw) else {
        return Ok(());
    };

    let subscriber = build_subscriber(
        &config.dir,
        &config.filename_prefix,
        config.retention,
        &level,
    )?;
    subscriber.try_init()?;
    Ok(())
}

static INIT: Once = Once::new();

/// Installs the global `tracing` subscriber for JSONL file logging.
///
/// Idempotent: a second call in the same process is a genuine no-op — guarded
/// by [`INIT`] so the directory-creation / rotation-file-pruning side effects
/// in [`build_subscriber`] run at most once, matching the fact that the
/// global subscriber itself can only be installed once.
pub fn init(config: &Config) -> Result<(), InitError> {
    let raw = std::env::var(&config.env_var).ok();
    let mut result = Ok(());
    INIT.call_once(|| {
        result = build_and_install(config, raw.as_deref());
    });
    result
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rstest::{fixture, rstest};
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;

    #[fixture]
    fn tmp_dir() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    #[rstest]
    #[case::unset(None, Some("info"))]
    #[case::empty(Some(""), Some("info"))]
    #[case::off_lowercase(Some("off"), None)]
    #[case::off_uppercase(Some("OFF"), None)]
    #[case::custom_directive(Some("my_crate=debug"), Some("my_crate=debug"))]
    fn test_resolve_level(#[case] raw: Option<&str>, #[case] expected: Option<&str>) {
        assert_eq!(resolve_level(raw), expected.map(str::to_string));
    }

    /// Reads back the single rotated log file under `dir` and returns its
    /// events with the `timestamp` field normalized to a fixed placeholder,
    /// so the rest of the shape can be asserted with one equality check.
    fn read_normalized_events(dir: &Path) -> Vec<Value> {
        let entries: Vec<_> = fs::read_dir(dir)
            .expect("read log dir")
            .map(|e| e.expect("dir entry").path())
            .collect();
        assert_eq!(entries.len(), 1, "expected exactly one rotated log file");

        let contents = fs::read_to_string(&entries[0]).expect("read log file");
        contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut event: Value = serde_json::from_str(line).expect("parse json line");
                event["timestamp"] = json!("<timestamp>");
                event
            })
            .collect()
    }

    #[rstest]
    fn build_subscriber_writes_jsonl_events(tmp_dir: TempDir) {
        let subscriber = build_subscriber(tmp_dir.path(), "test.log", 7, "info").expect("build");
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(user_id = 42, "hello world");
        });

        assert_eq!(
            read_normalized_events(tmp_dir.path()),
            vec![json!({
                "timestamp": "<timestamp>",
                "level": "INFO",
                "target": "fohte_service_kit::logging::tests",
                "user_id": 42,
                "message": "hello world",
            })],
        );
    }

    #[rstest]
    fn build_subscriber_creates_missing_directory(tmp_dir: TempDir) {
        let dir = tmp_dir.path().join("nested").join("logs");
        assert!(!dir.exists());

        build_subscriber(&dir, "test.log", 7, "info").expect("build");

        assert!(dir.is_dir());
    }

    #[rstest]
    fn build_subscriber_fails_when_dir_is_blocked_by_a_file(tmp_dir: TempDir) {
        let blocker = tmp_dir.path().join("blocker");
        fs::write(&blocker, "").expect("write blocker file");
        let dir = blocker.join("logs");

        let Err(err) = build_subscriber(&dir, "test.log", 7, "info") else {
            panic!("expected build_subscriber to fail");
        };

        assert!(matches!(err, InitError::CreateDir { path, .. } if path == dir));
    }

    #[rstest]
    fn build_and_install_is_noop_when_level_is_off(tmp_dir: TempDir) {
        let dir = tmp_dir.path().join("logs");
        let config = Config::new("UNUSED_ENV_VAR", dir.clone(), "test.log");

        let result = build_and_install(&config, Some("off"));

        assert!(result.is_ok());
        assert!(!dir.exists());
    }
}
