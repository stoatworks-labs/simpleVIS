//! The CITP peer: discovery, connections, and what arrives over them.
//!
//! CITP is two transports at once, and conflating them is the usual way to end
//! up with a peer nobody can see:
//!
//!  - **`PLoc` is multicast UDP** on 224.0.0.180:4809. It is only an
//!    advertisement, and the useful thing in it is the **TCP port** the sender
//!    is listening on.
//!  - **Everything else is TCP**, on that port. Patch, levels, names.
//!
//! simpleVIS both listens and dials. A console may expect to connect *to* the
//! visualiser (Eos does) or to be connected *to* (Capture does), and supporting
//! only one of those looks exactly like the other end being broken.
//!
//! ## Levels
//!
//! `ChBk` blocks are **partial** — a console may send channels 0..127 and
//! 128..255 as separate messages, and only the changed ones. So a whole
//! universe is accumulated per peer and handed to the same merge engine that
//! Art-Net and sACN feed. That means a console sending both CITP *and* sACN
//! counts as two sources and merges normally, rather than one silently
//! overwriting the other.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

use crate::merge::{MergePort, DEFAULT_PRIORITY, UNIVERSE_LEN};
use crate::protocol::citp::{self, Message, PatchEntry};

/// How often we re-announce ourselves. The spec is not prescriptive; consoles
/// generally expire a peer after a few missed announcements.
const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(4);

/// A fixture the console says is patched, in simpleVIS's own terms.
#[derive(Clone, serde::Serialize)]
pub struct PatchedFixture {
    #[serde(rename = "fixtureId")]
    pub fixture_id: u16,
    /// **1-based**, converted from CITP's 0-based universe at this boundary —
    /// the same conversion Art-Net's Port-Address gets.
    pub universe: u16,
    pub channel: u16,
    #[serde(rename = "channelCount")]
    pub channel_count: u16,
}

#[derive(Clone, serde::Serialize)]
pub struct CitpPeerInfo {
    pub name: String,
    pub kind: String,
    pub state: String,
    pub address: String,
    pub connected: bool,
}

struct Shared {
    running: AtomicBool,
    /// Universe accumulators, keyed by (peer address, CITP universe index).
    universes: Mutex<HashMap<(String, u8), [u8; UNIVERSE_LEN]>>,
    ports: Mutex<HashMap<u16, MergePort>>,
    peers: Mutex<HashMap<String, CitpPeerInfo>>,
    patch: Mutex<Vec<PatchedFixture>>,
    started: Instant,
    /// Peers that told us to take their levels from Art-Net/sACN instead.
    external: Mutex<HashMap<String, String>>,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

pub struct CitpPeer {
    shared: Arc<Shared>,
    tcp_port: Mutex<u16>,
}

impl Default for CitpPeer {
    fn default() -> Self {
        Self::new()
    }
}

fn bind_reusable_udp(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(not(target_os = "windows"))]
    socket.set_reuse_port(true)?;
    socket.set_read_timeout(Some(Duration::from_millis(400)))?;
    socket.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port).into())?;
    Ok(socket.into())
}

impl CitpPeer {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                running: AtomicBool::new(false),
                universes: Mutex::new(HashMap::new()),
                ports: Mutex::new(HashMap::new()),
                peers: Mutex::new(HashMap::new()),
                patch: Mutex::new(Vec::new()),
                started: Instant::now(),
                external: Mutex::new(HashMap::new()),
            }),
            tcp_port: Mutex::new(0),
        }
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.shared.running.store(false, Ordering::SeqCst);
        self.shared.peers.lock().unwrap().clear();
        self.shared.universes.lock().unwrap().clear();
        self.shared.ports.lock().unwrap().clear();
    }

    pub fn peers(&self) -> Vec<CitpPeerInfo> {
        self.shared.peers.lock().unwrap().values().cloned().collect()
    }

    pub fn patch(&self) -> Vec<PatchedFixture> {
        self.shared.patch.lock().unwrap().clone()
    }

    /// Start discovery, the TCP listener, and the publish loop.
    pub fn start<F, P>(
        &self,
        interface: Ipv4Addr,
        name: String,
        on_frame: F,
        on_patch: P,
    ) -> std::io::Result<()>
    where
        F: Fn(u16, Vec<u8>) + Send + Sync + 'static,
        P: Fn(Vec<PatchedFixture>) + Send + Sync + 'static,
    {
        if self.is_running() {
            return Ok(());
        }
        self.shared.running.store(true, Ordering::SeqCst);

        // Port 0 lets the OS choose; whatever it picks is what we advertise, so
        // a hard-coded port cannot collide with another CITP peer on the box.
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
        let tcp_port = listener.local_addr()?.port();
        *self.tcp_port.lock().unwrap() = tcp_port;

        let on_frame: Arc<dyn Fn(u16, Vec<u8>) + Send + Sync> = Arc::new(on_frame);
        let on_patch: Arc<dyn Fn(Vec<PatchedFixture>) + Send + Sync> = Arc::new(on_patch);

        // Inbound connections.
        {
            let shared = Arc::clone(&self.shared);
            let frame_cb = Arc::clone(&on_frame);
            let patch_cb = Arc::clone(&on_patch);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if !shared.running.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let shared = Arc::clone(&shared);
                    let frame_cb = Arc::clone(&frame_cb);
                    let patch_cb = Arc::clone(&patch_cb);
                    thread::spawn(move || serve(stream, shared, frame_cb, patch_cb, 0));
                }
            });
        }

        // Discovery: listen for other peers' PLoc, and announce our own.
        let socket = bind_reusable_udp(citp::MULTICAST_PORT)?;
        let _ = socket.join_multicast_v4(&citp::MULTICAST_ADDR, &interface);
        let socket = Arc::new(socket);

        {
            let shared = Arc::clone(&self.shared);
            let socket = Arc::clone(&socket);
            let frame_cb = Arc::clone(&on_frame);
            let patch_cb = Arc::clone(&on_patch);
            thread::spawn(move || {
                discover(socket, shared, frame_cb, patch_cb, tcp_port);
            });
        }

        {
            let shared = Arc::clone(&self.shared);
            let socket = Arc::clone(&socket);
            thread::spawn(move || announce(socket, shared, tcp_port, name));
        }

        Ok(())
    }
}

/// Re-announce ourselves on the multicast group.
fn announce(socket: Arc<UdpSocket>, shared: Arc<Shared>, tcp_port: u16, name: String) {
    let target = SocketAddr::new(IpAddr::V4(citp::MULTICAST_ADDR), citp::MULTICAST_PORT);
    while shared.running.load(Ordering::SeqCst) {
        let message = citp::peer_location(tcp_port, &name, "Ready");
        let _ = socket.send_to(&message, target);
        thread::sleep(ANNOUNCE_INTERVAL);
    }
}

/// Watch the multicast group and dial peers that advertise a port.
fn discover(
    socket: Arc<UdpSocket>,
    shared: Arc<Shared>,
    on_frame: Arc<dyn Fn(u16, Vec<u8>) + Send + Sync>,
    on_patch: Arc<dyn Fn(Vec<PatchedFixture>) + Send + Sync>,
    our_port: u16,
) {
    let mut buf = [0u8; 2048];
    while shared.running.load(Ordering::SeqCst) {
        let Ok((len, from)) = socket.recv_from(&mut buf) else {
            continue;
        };
        let Ok(Message::PeerLocation(location)) = citp::parse(&buf[..len]) else {
            continue;
        };
        // Our own announcement comes straight back on the loopback of the
        // group; connecting to ourselves would be an amusing way to deadlock.
        if location.listening_tcp_port == our_port || location.listening_tcp_port == 0 {
            continue;
        }

        let address = from.ip().to_string();
        {
            let mut peers = shared.peers.lock().unwrap();
            // Read the existing connection state out before inserting: an
            // announcement must refresh a peer's name without knocking it back
            // to "disconnected" while its TCP session is still up.
            let was_connected = peers.get(&address).map(|p| p.connected);
            let known = was_connected.is_some();
            peers.insert(
                address.clone(),
                CitpPeerInfo {
                    name: location.name.clone(),
                    kind: location.kind.clone(),
                    state: location.state.clone(),
                    address: address.clone(),
                    connected: was_connected.unwrap_or(false),
                },
            );
            if known {
                continue; // already dialled
            }
        }

        let target = SocketAddr::new(from.ip(), location.listening_tcp_port);
        let shared = Arc::clone(&shared);
        let on_frame = Arc::clone(&on_frame);
        let on_patch = Arc::clone(&on_patch);
        thread::spawn(move || {
            if let Ok(stream) = TcpStream::connect_timeout(&target, Duration::from_secs(3)) {
                serve(stream, shared, on_frame, on_patch, our_port);
            }
        });
    }
}

/// Handle one CITP connection for its lifetime.
fn serve(
    mut stream: TcpStream,
    shared: Arc<Shared>,
    on_frame: Arc<dyn Fn(u16, Vec<u8>) + Send + Sync>,
    on_patch: Arc<dyn Fn(Vec<PatchedFixture>) + Send + Sync>,
    our_port: u16,
) {
    let address = stream
        .peer_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "unknown".into());
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));

    // Introduce ourselves, then ask for the patch. Port 0 because this PLoc is
    // travelling over an established TCP connection, not the multicast group —
    // a console that reads a real port here may open a second connection.
    let _ = stream.write_all(&citp::peer_location(0, "simpleVIS", "Ready"));
    let _ = stream.write_all(&citp::send_patch_request());

    if let Some(peer) = shared.peers.lock().unwrap().get_mut(&address) {
        peer.connected = true;
    }

    let mut buffer: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];

    while shared.running.load(Ordering::SeqCst) {
        match stream.read(&mut chunk) {
            Ok(0) => break, // peer closed
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            Err(ref e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                continue
            }
            Err(_) => break,
        }

        // Frame the stream. CITP is length-prefixed, so a partial message is
        // kept until the rest arrives rather than discarded.
        loop {
            let declared = match citp::message_length(&buffer) {
                Ok(n) => n,
                Err(citp::CitpError::Incomplete) => break,
                Err(_) => {
                    // Not CITP at this offset. Resynchronise on the next
                    // cookie rather than dropping the whole connection.
                    match find_cookie(&buffer, 1) {
                        Some(at) => {
                            buffer.drain(..at);
                            continue;
                        }
                        None => {
                            buffer.clear();
                            break;
                        }
                    }
                }
            };
            if buffer.len() < declared {
                break;
            }

            if let Ok(message) = citp::parse(&buffer[..declared]) {
                handle(message, &address, &shared, &on_frame, &on_patch);
            }
            buffer.drain(..declared);
        }
    }

    if let Some(peer) = shared.peers.lock().unwrap().get_mut(&address) {
        peer.connected = false;
    }
    let _ = our_port;
}

fn find_cookie(buf: &[u8], from: usize) -> Option<usize> {
    buf.windows(4).skip(from).position(|w| w == citp::COOKIE).map(|i| i + from)
}

fn handle(
    message: Message,
    address: &str,
    shared: &Arc<Shared>,
    on_frame: &Arc<dyn Fn(u16, Vec<u8>) + Send + Sync>,
    on_patch: &Arc<dyn Fn(Vec<PatchedFixture>) + Send + Sync>,
) {
    match message {
        Message::ChannelBlock { blind, universe, first_channel, levels } => {
            // Blind data is what the programmer is editing off-line. Acting on
            // it would show the audience the next cue.
            if blind {
                return;
            }
            // A peer that asked us to take its levels from Art-Net is not also
            // sending them here in earnest.
            if shared.external.lock().unwrap().contains_key(address) {
                return;
            }

            let merged = {
                let mut universes = shared.universes.lock().unwrap();
                let slot = universes
                    .entry((address.to_string(), universe))
                    .or_insert([0u8; UNIVERSE_LEN]);
                let start = first_channel as usize;
                let end = (start + levels.len()).min(UNIVERSE_LEN);
                if start < UNIVERSE_LEN {
                    slot[start..end].copy_from_slice(&levels[..end - start]);
                }
                *slot
            };

            // CITP universes are 0-based; everything above the transport is 1-based.
            let universe_1 = u16::from(universe) + 1;
            let now = shared.now_ms();
            let mut id = [0u8; 16];
            let bytes = address.as_bytes();
            id[..bytes.len().min(16)].copy_from_slice(&bytes[..bytes.len().min(16)]);

            let mut ports = shared.ports.lock().unwrap();
            ports.entry(universe_1).or_default().feed(
                id,
                address,
                DEFAULT_PRIORITY,
                &merged,
                now,
            );
            drop(ports);

            on_frame(universe_1, merged.to_vec());
        }

        Message::Patch(entries) => {
            let converted: Vec<PatchedFixture> = entries
                .iter()
                .map(|e: &PatchEntry| PatchedFixture {
                    fixture_id: e.fixture_id,
                    universe: u16::from(e.universe) + 1,
                    channel: e.channel,
                    channel_count: e.channel_count,
                })
                .collect();

            let mut patch = shared.patch.lock().unwrap();
            for entry in converted {
                match patch.iter_mut().find(|p| p.fixture_id == entry.fixture_id) {
                    Some(existing) => *existing = entry,
                    None => patch.push(entry),
                }
            }
            let snapshot = patch.clone();
            drop(patch);
            on_patch(snapshot);
        }

        Message::Unpatch(ids) => {
            let mut patch = shared.patch.lock().unwrap();
            patch.retain(|p| !ids.contains(&p.fixture_id));
            let snapshot = patch.clone();
            drop(patch);
            on_patch(snapshot);
        }

        Message::SetExternalSource(connection) => {
            shared
                .external
                .lock()
                .unwrap()
                .insert(address.to_string(), connection);
        }

        Message::PeerLocation(location) => {
            if let Some(peer) = shared.peers.lock().unwrap().get_mut(address) {
                peer.name = location.name;
                peer.kind = location.kind;
                peer.state = location.state;
            }
        }

        Message::PeerName(name) => {
            if let Some(peer) = shared.peers.lock().unwrap().get_mut(address) {
                peer.name = name;
            }
        }

        // A universe's human name is useful in a status panel but changes
        // nothing about the levels, so it is accepted and ignored here rather
        // than left to fall through a wildcard — an explicit arm means adding a
        // message type to the enum breaks this match instead of silently
        // dropping it.
        Message::UniverseName { .. } => {}

        // Recorded rather than acted on: the codes' meanings are not verified,
        // and a peer's declared capabilities change nothing about how its
        // channel blocks are handled.
        Message::Capabilities(_) => {}

        // We are not a console; a peer asking us for a patch gets silence
        // rather than a wrong answer.
        Message::SendPatch => {}
        Message::Unhandled { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resynchronises_on_the_next_cookie() {
        let mut buf = b"junkjunk".to_vec();
        buf.extend_from_slice(&citp::peer_location(1, "a", "b"));
        assert_eq!(find_cookie(&buf, 1), Some(8));
    }

    #[test]
    fn finds_no_cookie_in_noise() {
        assert_eq!(find_cookie(b"nothing to see here", 1), None);
    }
}
