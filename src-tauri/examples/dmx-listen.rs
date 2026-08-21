//! Listen on **every** input simpleVIS supports and report what arrives.
//!
//! Built for the one thing this project has never been able to do: put a real
//! lighting console at the other end. Art-Net, sACN and CITP all at once, using
//! the code the desktop app ships, so whichever protocol a desk is configured
//! for, this proves the path end to end without needing an MVR loaded or a
//! window open.
//!
//! ```text
//! cargo run --example dmx-listen -- [seconds]
//! ```
//!
//! What "working" looks like: a line per universe with a rising frame count and
//! a non-zero peak when you push a fader. What a *silent* console looks like is
//! identical to a misconfigured one, which is why the summary at the end says
//! explicitly which protocols were heard and which were not.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use simplevis_lib::citp::CitpPeer;
use simplevis_lib::net::InputEngine;

#[derive(Default, Clone, Copy)]
struct Stat {
    frames: u64,
    active: usize,
    peak: u8,
}

type Universes = Arc<Mutex<HashMap<(&'static str, u16), Stat>>>;

fn record(map: &Universes, source: &'static str, universe: u16, slots: &[u8]) {
    let mut m = map.lock().unwrap();
    let entry = m.entry((source, universe)).or_default();
    entry.frames += 1;
    entry.active = slots.iter().filter(|&&v| v > 0).count();
    entry.peak = slots.iter().copied().max().unwrap_or(0);
}

fn main() -> std::io::Result<()> {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);

    let universes: Universes = Arc::new(Mutex::new(HashMap::new()));

    // Art-Net and sACN, through the shipping receive engine.
    let net = InputEngine::new();
    {
        let map = Arc::clone(&universes);
        net.start(
            &["artnet".to_string(), "sacn".to_string()],
            Ipv4Addr::UNSPECIFIED,
            move |frame| record(&map, "net", frame.universe, &frame.slots),
            |sources| {
                for s in sources {
                    println!(
                        "  source: {} [{}] universes {:?} {} fps{}",
                        s.label,
                        s.protocol,
                        s.universes,
                        s.fps,
                        if s.too_many_sources { "  (3rd source refused)" } else { "" }
                    );
                }
            },
        )?;
    }

    // CITP, through the shipping peer.
    let citp = CitpPeer::new();
    {
        let map = Arc::clone(&universes);
        citp.start(
            Ipv4Addr::UNSPECIFIED,
            "simpleVIS".to_string(),
            move |universe, slots| record(&map, "citp", universe, &slots),
            |patch| {
                println!("\n*** CITP/FPTC patch: {} fixture(s) ***", patch.len());
                for f in patch.iter().take(10) {
                    println!(
                        "      id={:<5} universe={:<3} channel={:<4} count={}",
                        f.fixture_id, f.universe, f.channel, f.channel_count
                    );
                }
            },
        )?;
    }

    println!("Listening for {seconds}s on Art-Net (6454), sACN (5568) and CITP (4809).");
    println!("Push a fader on the console — a universe should appear with a non-zero peak.\n");

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut last = String::new();

    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(2));

        let snapshot = {
            let m = universes.lock().unwrap();
            let mut rows: Vec<_> = m.iter().map(|((s, u), st)| (*s, *u, *st)).collect();
            rows.sort_by_key(|(s, u, _)| (*s, *u));
            rows.iter()
                .map(|(s, u, st)| {
                    format!(
                        "  {s:<5} universe {u:<4} {:>6} frames  {:>3} live ch  peak {:>3}",
                        st.frames, st.active, st.peak
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        if !snapshot.is_empty() && snapshot != last {
            println!("{snapshot}\n");
            last = snapshot;
        }

        for p in citp.peers() {
            // Printed once per change by the peer list rarely changing; cheap.
            let _ = p;
        }
    }

    let m = universes.lock().unwrap();
    let heard_net = m.keys().any(|(s, _)| *s == "net");
    let heard_citp = m.keys().any(|(s, _)| *s == "citp");

    println!("\n─── summary ───");
    println!("  Art-Net / sACN : {}", if heard_net { "RECEIVED" } else { "nothing" });
    println!("  CITP SDMX      : {}", if heard_citp { "RECEIVED" } else { "nothing" });
    let peers = citp.peers();
    if peers.is_empty() {
        println!("  CITP peers     : none announced");
    } else {
        for p in peers {
            println!(
                "  CITP peer      : {} [{}] {} — {}",
                p.name,
                p.kind,
                p.address,
                if p.connected { "connected" } else { &p.state }
            );
        }
    }
    if !heard_net && !heard_citp {
        println!("\n  Nothing arrived. A console that is running but not configured to");
        println!("  output looks exactly like this — check its DMX output/protocol page");
        println!("  and that the universe is enabled, not just patched.");
    }

    net.stop();
    citp.stop();
    Ok(())
}
