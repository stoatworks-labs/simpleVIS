//! simpleVIS's use of the fleet's vendored `diag` crate.
//!
//! The crate itself lives at `src-tauri/crates/diag` and is a byte-for-byte
//! copy of the fleet reference implementation — see the diagnostics-sweep
//! convention: every repo carries its own copy so repos stay independent, and
//! the module is always named `diag`.
//!
//! What simpleVIS adds is the config snapshot: which protocols were enabled and
//! which interface was chosen. A visualiser that "sees no DMX" is almost always
//! bound to the wrong interface, so that is the first thing a diagnostics
//! bundle should answer.

use std::sync::OnceLock;

use serde::Serialize;

static GUARD: OnceLock<Option<diag::Guard>> = OnceLock::new();

#[derive(Serialize, Default, Clone)]
pub struct ConfigSnapshot {
    pub protocols: Vec<String>,
    pub interface: String,
    pub serial_port: String,
}

/// Install logging and the panic hook. Call once, at startup.
pub fn init() {
    let options = diag::Options::new("simplevis", "SIMPLEVIS", env!("CARGO_PKG_VERSION"))
        .with_default_filter("info")
        .with_config(&ConfigSnapshot::default());

    // The guard must outlive the process or the log file is never flushed —
    // `let _ = diag::init(..)` drops it immediately and silently writes
    // nothing, which is the one failure this module exists to prevent.
    let _ = GUARD.set(diag::init(options).ok());
}

/// Write a single-file diagnostics bundle and return its path.
pub fn collect(_app: &tauri::AppHandle) -> std::io::Result<String> {
    diag::collect_diagnostics().map(|p| p.display().to_string())
}
