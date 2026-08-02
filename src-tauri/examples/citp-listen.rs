//! Run the **real** CITP peer and print everything it receives.
//!
//! Where `citp-probe` dials outwards to inspect a peer, this runs the exact
//! code the desktop app ships — announcing on the multicast group, accepting
//! inbound connections *and* dialling discovered peers — and reports what comes
//! back. It is the harness for bringing simpleVIS up against a real console:
//! whichever direction the console prefers to connect, this catches it.
//!
//! ```text
//! cargo run --example citp-listen -- [seconds]
//! ```

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use simplevis::citp::CitpPeer;

fn main() -> std::io::Result<()> {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(45);

    // Per-universe summary rather than a line per frame: a console at full rate
    // would otherwise scroll anything interesting off the screen.
    let levels: Arc<Mutex<HashMap<u16, (usize, u64, u8)>>> = Arc::new(Mutex::new(HashMap::new()));
    let seen = Arc::clone(&levels);

    let peer = CitpPeer::new();
    peer.start(
        Ipv4Addr::UNSPECIFIED,
        "simpleVIS".to_string(),
        move |universe, slots| {
            let highest = slots.iter().copied().max().unwrap_or(0);
            let mut map = seen.lock().unwrap();
            let entry = map.entry(universe).or_insert((0, 0, 0));
            entry.0 += 1;
            entry.1 = slots.iter().filter(|&&v| v > 0).count() as u64;
            entry.2 = highest;
        },
        |patch| {
            println!("\n*** FPTC patch: {} fixture(s) ***", patch.len());
            for f in patch.iter().take(12) {
                println!(
                    "    id={:<5} universe={:<3} channel={:<4} count={}",
                    f.fixture_id, f.universe, f.channel, f.channel_count
                );
            }
            if patch.len() > 12 {
                println!("    … and {} more", patch.len() - 12);
            }
        },
    )?;

    println!("simpleVIS CITP peer running for {seconds}s — announcing, listening and dialling.\n");

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut last_peers = String::new();

    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));

        let mut line = String::new();
        for p in peer.peers() {
            line.push_str(&format!(
                "  {} [{}] {} — {}\n",
                p.name,
                p.kind,
                p.address,
                if p.connected { "CONNECTED" } else { &p.state }
            ));
        }
        if line != last_peers && !line.is_empty() {
            println!("peers:\n{line}");
            last_peers = line;
        }

        let map = levels.lock().unwrap();
        if !map.is_empty() {
            let mut universes: Vec<_> = map.iter().collect();
            universes.sort_by_key(|(u, _)| **u);
            let summary: Vec<String> = universes
                .iter()
                .map(|(u, (frames, active, high))| {
                    format!("u{u}: {frames} frames, {active} live ch, peak {high}")
                })
                .collect();
            println!("SDMX  {}", summary.join(" | "));
        }
    }

    let map = levels.lock().unwrap();
    if map.is_empty() {
        println!("\nNo SDMX levels arrived.");
        println!("If a console is running, check its visualiser/CITP output is enabled");
        println!("and pointed at a universe.");
    } else {
        println!("\nReceived levels on {} universe(s).", map.len());
    }

    peer.stop();
    Ok(())
}
