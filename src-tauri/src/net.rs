//! Listening for Art-Net and sACN, and publishing merged universes.
//!
//! One socket per protocol, each on its own thread, both feeding a shared
//! per-universe merge engine. A third thread publishes merged results to the
//! webview at DMX rate.
//!
//! Two things about the sockets are worth stating, because getting either
//! wrong produces a receiver that binds successfully and never hears anything:
//!
//!  - **`SO_REUSEADDR` (and `SO_REUSEPORT` on macOS/BSD) are mandatory.**
//!    Lighting software co-exists on one machine all the time — a console, a
//!    visualiser and a node tool may all want 6454. Without reuse the second
//!    binder simply fails.
//!  - **sACN multicast needs an explicit group join, per universe, per
//!    interface.** Binding to 0.0.0.0:5568 gets you unicast sACN only, which is
//!    how a rig can appear to work from one console and be silent from another.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

use crate::merge::{MergeMode, MergePort, DEFAULT_PRIORITY, UNIVERSE_LEN};
use crate::protocol::{artnet, sacn};

/// A universe of merged levels, ready for the webview.
#[derive(Clone, serde::Serialize)]
pub struct UniverseFrame {
    pub universe: u16,
    pub slots: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
pub struct SourceStatus {
    pub protocol: String,
    pub label: String,
    pub universes: Vec<u16>,
    pub fps: u32,
    #[serde(rename = "tooManySources")]
    pub too_many_sources: bool,
}

struct Shared {
    ports: Mutex<HashMap<u16, MergePort>>,
    /// Protocol each universe was last heard on, for the status panel.
    origin: Mutex<HashMap<u16, &'static str>>,
    started: Instant,
    running: AtomicBool,
    mode: Mutex<MergeMode>,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

pub struct InputEngine {
    shared: Arc<Shared>,
    sacn_socket: Mutex<Option<Arc<UdpSocket>>>,
    joined: Mutex<Vec<u16>>,
    interface: Mutex<Ipv4Addr>,
}

impl Default for InputEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Bind a UDP socket that tolerates other lighting software on the same port.
fn bind_reusable(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(not(target_os = "windows"))]
    socket.set_reuse_port(true)?;
    socket.set_broadcast(true)?;
    socket.set_read_timeout(Some(Duration::from_millis(400)))?;
    socket.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port).into())?;
    Ok(socket.into())
}

impl InputEngine {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                ports: Mutex::new(HashMap::new()),
                origin: Mutex::new(HashMap::new()),
                started: Instant::now(),
                running: AtomicBool::new(false),
                mode: Mutex::new(MergeMode::Htp),
            }),
            sacn_socket: Mutex::new(None),
            joined: Mutex::new(Vec::new()),
            interface: Mutex::new(Ipv4Addr::UNSPECIFIED),
        }
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.shared.running.store(false, Ordering::SeqCst);
        *self.sacn_socket.lock().unwrap() = None;
        self.joined.lock().unwrap().clear();
        self.shared.ports.lock().unwrap().clear();
        self.shared.origin.lock().unwrap().clear();
    }

    pub fn set_mode(&self, mode: MergeMode) {
        *self.shared.mode.lock().unwrap() = mode;
    }

    /// Join sACN multicast groups for the patch's universes.
    ///
    /// Called whenever an MVR is imported. Joining only what is patched keeps a
    /// machine on a busy network from processing thousands of irrelevant
    /// universes.
    pub fn set_universes(&self, universes: &[u16]) -> std::io::Result<()> {
        let socket = self.sacn_socket.lock().unwrap();
        let Some(socket) = socket.as_ref() else {
            return Ok(());
        };
        let interface = *self.interface.lock().unwrap();
        let mut joined = self.joined.lock().unwrap();

        for &universe in universes {
            if joined.contains(&universe) {
                continue;
            }
            let group = sacn::multicast_ip(universe);
            // A failed join is not fatal — the universe may still arrive by
            // unicast, and some interfaces refuse membership entirely.
            if socket.join_multicast_v4(&group, &interface).is_ok() {
                joined.push(universe);
            }
        }
        Ok(())
    }

    /// Start receiving. `interface` of `0.0.0.0` means all interfaces.
    pub fn start<F, S>(
        &self,
        protocols: &[String],
        interface: Ipv4Addr,
        on_frame: F,
        on_sources: S,
    ) -> std::io::Result<()>
    where
        F: Fn(UniverseFrame) + Send + 'static,
        S: Fn(Vec<SourceStatus>) + Send + 'static,
    {
        if self.is_running() {
            return Ok(());
        }
        self.shared.running.store(true, Ordering::SeqCst);
        *self.interface.lock().unwrap() = interface;

        let want_artnet = protocols.iter().any(|p| p == "artnet");
        let want_sacn = protocols.iter().any(|p| p == "sacn");

        if want_artnet {
            let socket = bind_reusable(artnet::ARTNET_PORT)?;
            let shared = Arc::clone(&self.shared);
            thread::spawn(move || artnet_loop(socket, shared));
        }

        if want_sacn {
            let socket = Arc::new(bind_reusable(sacn::SACN_PORT)?);
            *self.sacn_socket.lock().unwrap() = Some(Arc::clone(&socket));
            let shared = Arc::clone(&self.shared);
            thread::spawn(move || sacn_loop(socket, shared));
        }

        let shared = Arc::clone(&self.shared);
        thread::spawn(move || publish_loop(shared, on_frame, on_sources));
        Ok(())
    }
}

fn artnet_loop(socket: UdpSocket, shared: Arc<Shared>) {
    let mut buf = [0u8; 1024];
    while shared.running.load(Ordering::SeqCst) {
        let Ok((len, from)) = socket.recv_from(&mut buf) else {
            continue; // read timeout, so the running flag is re-checked
        };
        let Some(packet) = artnet::parse(&buf[..len]) else {
            continue;
        };

        match packet {
            artnet::ArtNetPacket::Dmx { port_address, slots, .. } => {
                // Art-Net Port-Address is 0-based; simpleVIS uses 1-based
                // universes everywhere above the transport.
                let universe = port_address.wrapping_add(1);
                let mut id = [0u8; 16];
                if let IpAddr::V4(v4) = from.ip() {
                    id[..4].copy_from_slice(&v4.octets());
                }
                let now = shared.now_ms();
                let mut ports = shared.ports.lock().unwrap();
                ports.entry(universe).or_default().feed(
                    id,
                    &from.ip().to_string(),
                    DEFAULT_PRIORITY,
                    slots,
                    now,
                );
                shared.origin.lock().unwrap().insert(universe, "artnet");
            }
            artnet::ArtNetPacket::Poll => {
                // Answer so the console lists simpleVIS as a node. Failure to
                // reply is not fatal — it only affects discovery.
                if let Ok(local) = socket.local_addr() {
                    if let IpAddr::V4(v4) = local.ip() {
                        let reply = artnet::poll_reply(v4, "simpleVIS", "simpleVIS visualiser");
                        let _ = socket.send_to(&reply, from);
                    }
                }
            }
            _ => {}
        }
    }
}

fn sacn_loop(socket: Arc<UdpSocket>, shared: Arc<Shared>) {
    let mut buf = [0u8; 1024];
    while shared.running.load(Ordering::SeqCst) {
        let Ok((len, _from)) = socket.recv_from(&mut buf) else {
            continue;
        };
        let Ok(packet) = sacn::parse(&buf[..len]) else {
            continue;
        };
        // Preview data is explicitly not live output, and a terminated stream
        // is a source saying goodbye.
        if packet.preview || packet.terminated {
            continue;
        }

        let now = shared.now_ms();
        let mut ports = shared.ports.lock().unwrap();
        ports.entry(packet.universe).or_default().feed(
            packet.cid,
            &packet.source_name,
            packet.priority,
            packet.slots,
            now,
        );
        shared.origin.lock().unwrap().insert(packet.universe, "sacn");
    }
}

/// Publish merged universes at DMX rate.
fn publish_loop<F, S>(shared: Arc<Shared>, on_frame: F, on_sources: S)
where
    F: Fn(UniverseFrame),
    S: Fn(Vec<SourceStatus>),
{
    // 44 Hz is full DMX rate. Publishing faster wastes IPC on frames the
    // console never sent; slower and fast chases visibly stutter.
    let interval = Duration::from_millis(1000 / 44);
    let mut last_status = Instant::now();
    let mut previous: HashMap<u16, [u8; UNIVERSE_LEN]> = HashMap::new();

    while shared.running.load(Ordering::SeqCst) {
        let start = Instant::now();
        let now = shared.now_ms();
        let mode = *shared.mode.lock().unwrap();

        {
            let mut ports = shared.ports.lock().unwrap();
            for (&universe, port) in ports.iter_mut() {
                let Some(merged) = port.result(mode, now) else {
                    continue;
                };
                // Only publish changes. A rig sitting in a static look would
                // otherwise push 28 universes across the IPC boundary 44 times
                // a second for no reason.
                if previous.get(&universe) == Some(&merged) {
                    continue;
                }
                previous.insert(universe, merged);
                on_frame(UniverseFrame { universe, slots: merged.to_vec() });
            }
        }

        if last_status.elapsed() >= Duration::from_millis(500) {
            last_status = Instant::now();
            let mut ports = shared.ports.lock().unwrap();
            let origin = shared.origin.lock().unwrap();
            let mut by_source: HashMap<(String, String), (Vec<u16>, u32, bool)> = HashMap::new();

            for (&universe, port) in ports.iter_mut() {
                let protocol = (*origin.get(&universe).unwrap_or(&"artnet")).to_string();
                let fps = port.fps(now).round() as u32;
                let too_many = port.too_many_sources;
                for label in port.labels() {
                    let entry = by_source
                        .entry((protocol.clone(), label))
                        .or_insert((Vec::new(), 0, false));
                    entry.0.push(universe);
                    entry.1 = entry.1.max(fps);
                    entry.2 |= too_many;
                }
            }

            let mut statuses: Vec<SourceStatus> = by_source
                .into_iter()
                .map(|((protocol, label), (mut universes, fps, too_many))| {
                    universes.sort_unstable();
                    SourceStatus { protocol, label, universes, fps, too_many_sources: too_many }
                })
                .collect();
            statuses.sort_by(|a, b| a.label.cmp(&b.label));
            on_sources(statuses);
        }

        let elapsed = start.elapsed();
        if elapsed < interval {
            thread::sleep(interval - elapsed);
        }
    }
}

/// IPv4 addresses of the machine's usable interfaces.
pub fn list_interfaces() -> Vec<(String, String)> {
    let mut out = vec![("All interfaces".to_string(), "0.0.0.0".to_string())];
    if let Ok(addrs) = if_addrs::get_if_addrs() {
        for iface in addrs {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                out.push((iface.name.clone(), v4.to_string()));
            }
        }
    }
    out
}
