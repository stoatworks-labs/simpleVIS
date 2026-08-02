//! End-to-end CITP: a fake console on real sockets.
//!
//! The unit tests in `protocol::citp` prove the encoder and decoder agree with
//! each other. They say nothing about whether the *peer* works — whether it
//! announces itself where consoles look, dials what it discovers, frames a TCP
//! stream correctly, and turns partial channel blocks into whole universes.
//! That is where the failures actually live, and every one of them presents the
//! same way: a visualiser that sits there showing nothing.
//!
//! So this stands up a minimal console: multicast a `PLoc` advertising a TCP
//! port, accept the connection simpleVIS makes, then send a `Ptch` and a couple
//! of `ChBk`s and assert on what comes out the other end.
//!
//! Ignored by default — it binds the real CITP multicast port, which a machine
//! running Capture or a console already has.
//!
//! ```text
//! cargo test --test citp_peer -- --ignored --test-threads=1
//! ```

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket};
use std::sync::mpsc;
use std::time::Duration;

use simplevis::citp::CitpPeer;
use simplevis::protocol::citp;

/// A `ChBk` for one universe, starting at `first_channel`.
fn channel_block(blind: bool, universe: u8, first_channel: u16, levels: &[u8]) -> Vec<u8> {
    let mut body = vec![u8::from(blind), universe];
    body.extend_from_slice(&first_channel.to_le_bytes());
    body.extend_from_slice(&(levels.len() as u16).to_le_bytes());
    body.extend_from_slice(levels);
    citp::frame(citp::SDMX, citp::CHBK, &body)
}

/// A `Ptch` describing some patched fixtures.
fn patch(entries: &[(u16, u8, u16, u16)]) -> Vec<u8> {
    let mut body = 0u32.to_le_bytes().to_vec(); // ContentHint
    for &(id, universe, channel, count) in entries {
        body.extend_from_slice(&id.to_le_bytes());
        body.push(universe);
        body.push(0); // reserved
        body.extend_from_slice(&channel.to_le_bytes());
        body.extend_from_slice(&count.to_le_bytes());
    }
    citp::frame(citp::FPTC, citp::PTCH, &body)
}

struct FakeConsole {
    listener: TcpListener,
    port: u16,
}

impl FakeConsole {
    fn new() -> Self {
        // 0.0.0.0, not 127.0.0.1. PLoc is multicast, so the receiver sees the
        // sender's *interface* address (192.168.x.x), not loopback — a console
        // listening only on loopback advertises an address it cannot be
        // reached on, and the connection is refused.
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        Self { listener, port }
    }

    /// Announce on the CITP multicast group, as a console does.
    fn announce(&self) {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        socket.set_multicast_loop_v4(true).unwrap();
        let message = citp::peer_location(self.port, "Fake Desk", "Ready");
        let target = SocketAddr::new(IpAddr::V4(citp::MULTICAST_ADDR), citp::MULTICAST_PORT);
        for _ in 0..6 {
            let _ = socket.send_to(&message, target);
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

/// Bring up the peer and a fake console, run `script` on the accepted
/// connection, and return whatever the peer emitted.
fn exchange(
    script: impl FnOnce(&mut std::net::TcpStream) + Send + 'static,
) -> (
    mpsc::Receiver<(u16, Vec<u8>)>,
    mpsc::Receiver<Vec<simplevis::citp::PatchedFixture>>,
    CitpPeer,
) {
    let console = FakeConsole::new();
    console.listener.set_nonblocking(false).unwrap();

    let (frame_tx, frame_rx) = mpsc::channel();
    let (patch_tx, patch_rx) = mpsc::channel();

    let peer = CitpPeer::new();
    peer.start(
        Ipv4Addr::UNSPECIFIED,
        "simpleVIS test".into(),
        move |universe, slots| {
            let _ = frame_tx.send((universe, slots));
        },
        move |fixtures| {
            let _ = patch_tx.send(fixtures);
        },
    )
    .expect("peer should start");

    let listener = console.listener.try_clone().unwrap();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // simpleVIS introduces itself and asks for the patch first; drain
            // that so the script writes into a settled connection.
            let mut scratch = [0u8; 1024];
            let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
            let _ = stream.read(&mut scratch);
            script(&mut stream);
            std::thread::sleep(Duration::from_secs(2));
        }
    });

    std::thread::spawn(move || console.announce());
    (frame_rx, patch_rx, peer)
}

fn wait_frame(rx: &mpsc::Receiver<(u16, Vec<u8>)>, universe: u16) -> Option<Vec<u8>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    while std::time::Instant::now() < deadline {
        if let Ok((u, slots)) = rx.recv_timeout(Duration::from_millis(300)) {
            if u == universe {
                return Some(slots);
            }
        }
    }
    None
}

#[test]
#[ignore = "binds the real CITP multicast port"]
fn discovers_a_console_and_receives_its_patch() {
    let (_frames, patches, peer) = exchange(|stream| {
        let _ = stream.write_all(&patch(&[(1, 0, 1, 10), (2, 0, 11, 10), (7, 3, 100, 24)]));
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut got = None;
    while std::time::Instant::now() < deadline {
        if let Ok(fixtures) = patches.recv_timeout(Duration::from_millis(300)) {
            if fixtures.len() >= 3 {
                got = Some(fixtures);
                break;
            }
        }
    }

    let fixtures = got.expect("no patch arrived from the console");
    assert_eq!(fixtures.len(), 3);
    assert_eq!(fixtures[0].fixture_id, 1);
    // CITP universes are 0-based on the wire; simpleVIS is 1-based above the
    // transport. Universe 3 must surface as 4, exactly as Art-Net's
    // Port-Address does.
    assert_eq!(fixtures[0].universe, 1);
    assert_eq!(fixtures[2].universe, 4);
    assert_eq!(fixtures[2].channel, 100);
    assert_eq!(fixtures[2].channel_count, 24);

    peer.stop();
}

#[test]
#[ignore = "binds the real CITP multicast port"]
fn assembles_partial_channel_blocks_into_one_universe() {
    // The behaviour that matters: a console sends only what changed, in blocks.
    // Treating each block as a whole universe would blank everything outside it.
    let (frames, _patches, peer) = exchange(|stream| {
        let _ = stream.write_all(&channel_block(false, 0, 0, &[11, 22, 33]));
        std::thread::sleep(Duration::from_millis(150));
        let _ = stream.write_all(&channel_block(false, 0, 100, &[44, 55]));
    });

    let mut last = wait_frame(&frames, 1).expect("no levels arrived");
    // Drain to the most recent frame — the first block may arrive alone.
    while let Ok((u, slots)) = frames.recv_timeout(Duration::from_millis(500)) {
        if u == 1 {
            last = slots;
        }
    }

    assert_eq!(last.len(), 512);
    assert_eq!(&last[0..3], &[11, 22, 33], "first block lost");
    assert_eq!(&last[100..102], &[44, 55], "second block lost");
    assert_eq!(last[50], 0, "untouched channels should stay at zero");

    peer.stop();
}

#[test]
#[ignore = "binds the real CITP multicast port"]
fn ignores_blind_data() {
    // Blind is what the programmer is editing off-line. Showing it would put
    // the next cue on the audience.
    //
    // Asserting only that nothing arrives would pass just as happily if the
    // console never connected at all — which is exactly how this test first
    // "passed" while the whole transport was broken. So a live block follows
    // the blind one on a different universe, and the test demands the live one
    // *and* the absence of the blind one.
    let (frames, _patches, peer) = exchange(|stream| {
        let _ = stream.write_all(&channel_block(true, 0, 0, &[255, 255, 255]));
        std::thread::sleep(Duration::from_millis(150));
        let _ = stream.write_all(&channel_block(false, 5, 0, &[99]));
    });

    let live = wait_frame(&frames, 6).expect("the connection itself never worked");
    assert_eq!(live[0], 99);

    // Universe 1 carried only blind data and must never have been emitted.
    let mut saw_blind = false;
    while let Ok((u, _)) = frames.recv_timeout(Duration::from_millis(400)) {
        if u == 1 {
            saw_blind = true;
        }
    }
    assert!(!saw_blind, "blind channel block must not produce output");

    peer.stop();
}

#[test]
#[ignore = "binds the real CITP multicast port"]
fn handles_several_messages_arriving_in_one_tcp_segment() {
    // CITP is length-prefixed over a stream, so two messages can share a read.
    // A reader that assumes one message per read silently drops the second.
    let (frames, patches, peer) = exchange(|stream| {
        let mut combined = patch(&[(9, 1, 5, 4)]);
        combined.extend_from_slice(&channel_block(false, 1, 4, &[7, 8, 9, 10]));
        let _ = stream.write_all(&combined);
    });

    let levels = wait_frame(&frames, 2).expect("second message in the segment was dropped");
    assert_eq!(&levels[4..8], &[7, 8, 9, 10]);

    let fixtures = patches
        .recv_timeout(Duration::from_secs(3))
        .expect("first message in the segment was dropped");
    assert_eq!(fixtures[0].fixture_id, 9);
    assert_eq!(fixtures[0].universe, 2);

    peer.stop();
}
