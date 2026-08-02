//! simpleVIS desktop backend, as a library.
//!
//! The binary is a thin Tauri shell over these modules. Exposing them as a
//! library exists for one reason: the **integration tests bind real sockets and
//! send real datagrams**, and proving the receive path works needs the engine
//! without the GUI around it.

pub mod citp;
pub mod merge;
pub mod net;
pub mod protocol;
pub mod serial;
