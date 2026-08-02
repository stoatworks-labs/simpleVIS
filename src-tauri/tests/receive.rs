//! End-to-end receive tests: real sockets, real datagrams.
//!
//! The unit tests in `protocol::*` prove the parsers understand the wire
//! formats. They say nothing about whether the *sockets* are set up correctly,
//! and that is where the failures actually happen — a receiver that binds
//! successfully and hears nothing is the classic Art-Net/sACN bug, and it looks
//! identical whether the cause is a missing `SO_REUSEADDR`, an unjoined
//! multicast group, or a universe numbering slip.
//!
//! These send genuine packets to loopback and assert that merged frames come
//! out the other end with the right universe and the right levels.
//!
//! Ignored by default: they bind the real Art-Net and sACN ports, so they fail
//! on a machine already running a console or a node tool. Run explicitly:
//!
//! ```text
//! cargo test --test receive -- --ignored --test-threads=1
//! ```

use std::net::{Ipv4Addr, UdpSocket};
use std::sync::mpsc;
use std::time::Duration;

use simplevis::net::InputEngine;

/// Build a valid E1.31 data packet for `universe` with the given slots.
fn sacn_packet(universe: u16, priority: u8, slots: &[u8]) -> Vec<u8> {
    const ACN_ID: [u8; 12] = [
        0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
    ];
    let mut b = vec![0u8; 126 + slots.len()];
    b[0..2].copy_from_slice(&0x0010u16.to_be_bytes());
    b[4..16].copy_from_slice(&ACN_ID);
    b[18..22].copy_from_slice(&4u32.to_be_bytes()); // root vector
    b[40..44].copy_from_slice(&2u32.to_be_bytes()); // framing vector
    b[22..38].copy_from_slice(&[9u8; 16]); // CID
    b[44..53].copy_from_slice(b"test desk");
    b[108] = priority;
    b[113..115].copy_from_slice(&universe.to_be_bytes());
    b[117] = 0x02; // DMP vector
    b[118] = 0xA1; // address/data type
    b[121..123].copy_from_slice(&1u16.to_be_bytes()); // increment
    b[123..125].copy_from_slice(&((slots.len() + 1) as u16).to_be_bytes());
    b[125] = 0x00; // start code
    b[126..].copy_from_slice(slots);
    b
}

/// Build an ArtDmx packet. `port_address` is 0-based.
fn artdmx(port_address: u16, slots: &[u8]) -> Vec<u8> {
    let mut b = vec![0u8; 18 + slots.len()];
    b[0..8].copy_from_slice(b"Art-Net\0");
    b[8..10].copy_from_slice(&0x5000u16.to_le_bytes());
    b[14] = (port_address & 0xFF) as u8;
    b[15] = (port_address >> 8) as u8;
    b[16..18].copy_from_slice(&(slots.len() as u16).to_be_bytes());
    b[18..].copy_from_slice(slots);
    b
}

/// Wait for a frame on `universe`, or give up.
fn wait_for(
    rx: &mpsc::Receiver<(u16, Vec<u8>)>,
    universe: u16,
    timeout: Duration,
) -> Option<Vec<u8>> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok((u, slots)) if u == universe => return Some(slots),
            Ok(_) => continue, // a frame for some other universe
            Err(_) => continue,
        }
    }
    None
}

#[test]
#[ignore = "binds the real Art-Net/sACN ports"]
fn receives_sacn_over_a_real_socket() {
    let engine = InputEngine::new();
    let (tx, rx) = mpsc::channel();

    engine
        .start(
            &["sacn".to_string()],
            Ipv4Addr::UNSPECIFIED,
            move |frame| {
                let _ = tx.send((frame.universe, frame.slots));
            },
            |_| {},
        )
        .expect("engine should start");

    let sender = UdpSocket::bind("0.0.0.0:0").unwrap();
    let packet = sacn_packet(7, 100, &[11, 22, 33]);

    // Send a few: the publisher only emits on change, and the first frame may
    // race the receive thread reaching its recv call.
    for _ in 0..5 {
        sender.send_to(&packet, "127.0.0.1:5568").unwrap();
        std::thread::sleep(Duration::from_millis(40));
    }

    let slots = wait_for(&rx, 7, Duration::from_secs(3)).expect("no sACN frame arrived");
    assert_eq!(&slots[0..3], &[11, 22, 33]);
    // A short universe must be zero-filled, not left with stale data.
    assert_eq!(slots.len(), 512);
    assert_eq!(slots[3], 0);

    engine.stop();
}

#[test]
#[ignore = "binds the real Art-Net/sACN ports"]
fn receives_artnet_and_offsets_the_universe_by_one() {
    // Art-Net Port-Addresses are 0-based; simpleVIS uses 1-based universes
    // everywhere above the transport, matching sACN and every console's patch
    // display. Getting this wrong puts the whole rig one universe out — which
    // looks like a patch error rather than a bug.
    let engine = InputEngine::new();
    let (tx, rx) = mpsc::channel();

    engine
        .start(
            &["artnet".to_string()],
            Ipv4Addr::UNSPECIFIED,
            move |frame| {
                let _ = tx.send((frame.universe, frame.slots));
            },
            |_| {},
        )
        .expect("engine should start");

    let sender = UdpSocket::bind("0.0.0.0:0").unwrap();
    let packet = artdmx(6, &[200, 100, 50]);
    for _ in 0..5 {
        sender.send_to(&packet, "127.0.0.1:6454").unwrap();
        std::thread::sleep(Duration::from_millis(40));
    }

    // Port-Address 6 must surface as universe 7.
    let slots = wait_for(&rx, 7, Duration::from_secs(3)).expect("no Art-Net frame arrived");
    assert_eq!(&slots[0..3], &[200, 100, 50]);

    engine.stop();
}

#[test]
#[ignore = "binds the real Art-Net/sACN ports"]
fn higher_sacn_priority_overrides_a_lower_one_end_to_end() {
    let engine = InputEngine::new();
    let (tx, rx) = mpsc::channel();

    engine
        .start(
            &["sacn".to_string()],
            Ipv4Addr::UNSPECIFIED,
            move |frame| {
                let _ = tx.send((frame.universe, frame.slots));
            },
            |_| {},
        )
        .expect("engine should start");

    let sender = UdpSocket::bind("0.0.0.0:0").unwrap();

    // Two desks, different CIDs, different priorities. The high-priority one
    // must win outright rather than being HTP-mixed.
    let mut low = sacn_packet(20, 100, &[255, 255, 255]);
    low[22..38].copy_from_slice(&[1u8; 16]);
    let mut high = sacn_packet(20, 200, &[0, 0, 7]);
    high[22..38].copy_from_slice(&[2u8; 16]);

    for _ in 0..6 {
        sender.send_to(&low, "127.0.0.1:5568").unwrap();
        sender.send_to(&high, "127.0.0.1:5568").unwrap();
        std::thread::sleep(Duration::from_millis(40));
    }

    let slots = wait_for(&rx, 20, Duration::from_secs(3)).expect("no frame arrived");
    assert_eq!(&slots[0..3], &[0, 0, 7]);

    engine.stop();
}
