//! DMX input over USB, via an Enttec DMX USB Pro.
//!
//! The Pro speaks a framed message protocol:
//!
//! ```text
//!   0x7E <label> <len lo> <len hi> <data …> 0xE7
//! ```
//!
//! Receiving is not the default. The widget must be told to start with a
//! **Receive DMX on Change** message (label 8) whose single payload byte
//! selects the mode; `0` means "send me every frame", which is what a
//! visualiser wants — "on change only" (`1`) makes a static look look like a
//! dead link. Inbound frames then arrive as label 5, carrying a status byte,
//! the start code, and the slots.
//!
//! Deliberately Pro-only. An Enttec **Open** DMX USB is a bare FTDI chip that
//! bit-bangs the line with no framing and no receive path at all, so there is
//! nothing to read; supporting it would mean advertising an input that can
//! never deliver a frame.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const SOM: u8 = 0x7E;
const EOM: u8 = 0xE7;
const LABEL_RECEIVE_ON_CHANGE: u8 = 8;
const LABEL_RECEIVED_PACKET: u8 = 5;

/// Ports that could plausibly be a DMX widget.
///
/// Every USB serial device on a Mac shows up twice, as `/dev/tty.*` and
/// `/dev/cu.*`. The `tty` node blocks on open waiting for carrier detect, which
/// a DMX widget never asserts — opening it hangs rather than failing, so only
/// the `cu` node is offered.
pub fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| {
            ports
                .into_iter()
                .map(|p| p.port_name)
                .filter(|name| !name.contains("/dev/tty."))
                .collect()
        })
        .unwrap_or_default()
}

fn message(label: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(SOM);
    out.push(label);
    out.push((payload.len() & 0xFF) as u8);
    out.push((payload.len() >> 8) as u8);
    out.extend_from_slice(payload);
    out.push(EOM);
    out
}

pub struct SerialInput {
    running: Arc<AtomicBool>,
}

impl Default for SerialInput {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialInput {
    pub fn new() -> Self {
        Self { running: Arc::new(AtomicBool::new(false)) }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Open a widget and stream its DMX input to `on_frame`.
    ///
    /// `universe` is the universe number these frames are attributed to — a
    /// USB widget has no concept of one, so the operator chooses.
    pub fn start<F>(&self, port: &str, universe: u16, on_frame: F) -> Result<(), String>
    where
        F: Fn(u16, Vec<u8>) + Send + 'static,
    {
        if self.is_running() {
            return Err("already receiving".into());
        }

        // The Pro is a USB CDC device: the baud rate is ignored, but a value
        // still has to be supplied.
        let mut port = serialport::new(port, 115_200)
            .timeout(Duration::from_millis(250))
            .open()
            .map_err(|e| format!("could not open {port}: {e}"))?;

        port.write_all(&message(LABEL_RECEIVE_ON_CHANGE, &[0]))
            .map_err(|e| format!("could not enable receive: {e}"))?;

        self.running.store(true, Ordering::SeqCst);
        let running = Arc::clone(&self.running);

        thread::spawn(move || {
            let mut buffer: Vec<u8> = Vec::with_capacity(2048);
            let mut chunk = [0u8; 1024];

            while running.load(Ordering::SeqCst) {
                match port.read(&mut chunk) {
                    Ok(0) => continue,
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }

                // Frames can be split across reads and the stream can start
                // mid-message, so resynchronise on the start byte rather than
                // assuming a read begins one.
                while let Some(start) = buffer.iter().position(|&b| b == SOM) {
                    if start > 0 {
                        buffer.drain(..start);
                    }
                    if buffer.len() < 5 {
                        break;
                    }
                    let label = buffer[1];
                    let length = usize::from(buffer[2]) | (usize::from(buffer[3]) << 8);
                    let total = length + 5;
                    if buffer.len() < total {
                        break; // wait for the rest
                    }
                    if buffer[total - 1] != EOM {
                        buffer.drain(..1); // false start byte; resynchronise
                        continue;
                    }

                    if label == LABEL_RECEIVED_PACKET && length >= 2 {
                        // payload[0] is a status byte, payload[1] the start
                        // code. Only start code 0x00 is DMX levels.
                        let payload = &buffer[4..total - 1];
                        if payload[1] == 0x00 {
                            on_frame(universe, payload[2..].to_vec());
                        }
                    }
                    buffer.drain(..total);
                }

                if buffer.len() > 8192 {
                    buffer.clear(); // desynchronised beyond recovery
                }
            }
            running.store(false, Ordering::SeqCst);
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_a_message_correctly() {
        let m = message(LABEL_RECEIVE_ON_CHANGE, &[0]);
        assert_eq!(m, vec![0x7E, 8, 1, 0, 0, 0xE7]);
    }

    #[test]
    fn encodes_a_two_byte_length_little_endian() {
        let m = message(6, &vec![0u8; 513]);
        assert_eq!(m[2], 0x01); // 513 & 0xFF
        assert_eq!(m[3], 0x02); // 513 >> 8
        assert_eq!(*m.last().unwrap(), EOM);
    }
}
