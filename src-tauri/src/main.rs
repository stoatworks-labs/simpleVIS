// Suppress the console window on a Windows release build. Debug builds keep
// it, because that is where the tracing output goes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Everything is in the library half of the crate, including the app setup:
// the mobile shells have no `main` to call and link the library instead.
// See `run` in lib.rs.
fn main() {
    simplevis_lib::run()
}
