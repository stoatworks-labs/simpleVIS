//! Listen to real CITP traffic and report what it says.
//!
//! Built for bringing simpleVIS up against an actual console or visualiser —
//! Capture, Eos, grandMA3 — where the useful question is never "does my parser
//! round-trip" but "does the other end say what I assumed".
//!
//! It deliberately parses with simpleVIS's own code, so a disagreement between
//! this project and a real peer shows up here rather than as a rig that renders
//! nothing. Anything that fails to parse is hex-dumped, because on a first
//! contact the *unparseable* packet is the interesting one.
//!
//! ```text
//! cargo run --example citp-probe -- [seconds]
//! ```

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

use simplevis::protocol::citp::{self, Message};

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(64)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn main() -> std::io::Result<()> {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);

    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(not(target_os = "windows"))]
    socket.set_reuse_port(true)?;
    socket.set_read_timeout(Some(Duration::from_millis(500)))?;
    socket.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), citp::MULTICAST_PORT).into())?;
    let socket: UdpSocket = socket.into();
    socket.join_multicast_v4(&citp::MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED)?;

    println!(
        "listening on {}:{} for {seconds}s …",
        citp::MULTICAST_ADDR,
        citp::MULTICAST_PORT
    );

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut buf = [0u8; 4096];
    let mut seen: HashSet<String> = HashSet::new();
    let mut peers: Vec<(SocketAddr, u16, String, String)> = Vec::new();

    while Instant::now() < deadline {
        let Ok((len, from)) = socket.recv_from(&mut buf) else {
            continue;
        };
        let raw = &buf[..len];

        match citp::parse(raw) {
            Ok(Message::PeerLocation(p)) => {
                let key = format!("{}|{}|{}", from.ip(), p.name, p.listening_tcp_port);
                if seen.insert(key) {
                    println!(
                        "  PLoc from {}  tcp={}  kind={:?}  name={:?}  state={:?}",
                        from.ip(),
                        p.listening_tcp_port,
                        p.kind,
                        p.name,
                        p.state
                    );
                    if p.listening_tcp_port != 0 {
                        peers.push((from, p.listening_tcp_port, p.name.clone(), p.kind.clone()));
                    }
                }
            }
            Ok(other) => {
                let key = format!("{other:?}");
                if seen.insert(key.clone()) {
                    println!("  {} -> {}", from.ip(), &key[..key.len().min(120)]);
                }
            }
            Err(e) => {
                let key = format!("err{e:?}{}", from.ip());
                if seen.insert(key) {
                    println!("  UNPARSED from {} ({e:?}), {len} bytes:", from.ip());
                    println!("    {}", hex(raw));
                }
            }
        }
    }

    if peers.is_empty() {
        println!("\nno peers announced. Either nothing is speaking CITP, or it is");
        println!("not announcing on this interface.");
        return Ok(());
    }

    // Connect to each peer and see what it volunteers.
    for (addr, port, name, kind) in peers {
        let target = SocketAddr::new(addr.ip(), port);
        println!("\nconnecting to {name:?} ({kind}) at {target} …");

        let Ok(mut stream) = TcpStream::connect_timeout(&target, Duration::from_secs(3)) else {
            println!("  connection refused");
            continue;
        };
        stream.set_read_timeout(Some(Duration::from_millis(700)))?;

        // Introduce ourselves with port 0 — this PLoc is on an established
        // connection, not the multicast group — then ask for the patch.
        stream.write_all(&citp::peer_location(0, "simpleVIS probe", "Ready"))?;
        stream.write_all(&citp::send_patch_request())?;

        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        let until = Instant::now() + Duration::from_secs(6);
        let mut counts: Vec<String> = Vec::new();

        while Instant::now() < until {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(_) => continue,
            }
            loop {
                let declared = match citp::message_length(&buffer) {
                    Ok(n) => n,
                    Err(citp::CitpError::Incomplete) => break,
                    Err(e) => {
                        println!("  UNFRAMEABLE ({e:?}): {}", hex(&buffer));
                        buffer.clear();
                        break;
                    }
                };
                if buffer.len() < declared {
                    break;
                }
                match citp::parse(&buffer[..declared]) {
                    Ok(Message::ChannelBlock { universe, first_channel, levels, blind }) => {
                        let line = format!(
                            "  ChBk universe={universe} first={first_channel} count={} blind={blind}",
                            levels.len()
                        );
                        if !counts.contains(&line) {
                            println!("{line}");
                            counts.push(line);
                        }
                    }
                    Ok(Message::Patch(entries)) => {
                        println!("  Ptch with {} fixture(s)", entries.len());
                        for e in entries.iter().take(5) {
                            println!(
                                "    id={} universe={} channel={} count={}",
                                e.fixture_id, e.universe, e.channel, e.channel_count
                            );
                        }
                    }
                    Ok(Message::Unhandled { layer, kind }) => {
                        // The whole point of first contact: dump what we do not
                        // yet understand, with the codes shown as ASCII *and*
                        // as a number — CAEX turns out not to use a
                        // four-character code at all.
                        println!(
                            "  Unhandled layer={:?} kind={:?} (kind as u32 LE = 0x{:08x}), {} byte body:",
                            String::from_utf8_lossy(&layer),
                            String::from_utf8_lossy(&kind),
                            u32::from_le_bytes(kind),
                            declared.saturating_sub(24),
                        );
                        println!("    {}", hex(&buffer[24..declared]));
                    }
                    Ok(other) => {
                        let text = format!("{other:?}");
                        println!("  {}", &text[..text.len().min(140)]);
                    }
                    Err(e) => println!("  parse error {e:?}: {}", hex(&buffer[..declared])),
                }
                buffer.drain(..declared);
            }
        }
    }

    Ok(())
}
