//! Per-universe source tracking, priority arbitration and HTP/LTP merging.
//!
//! Ported from nanODE's host-tested C99 engine
//! (`firmware/components/artnet/artnet_merge.c`). The clock is injected rather
//! than read, which is what makes the timeout and merge behaviour testable —
//! this is exactly the logic that is painful to debug on a rig at 2am and
//! trivial to pin down here.
//!
//! Three rules do all the work, and all three come from the standards rather
//! than from taste:
//!
//!  - **Two sources per universe.** Art-Net 4 defines merging for two. A third
//!    transmitting to the same universe is a patch error, not a feature: the
//!    two already present are kept, the newcomer is refused, and a flag is
//!    raised so the operator can be told.
//!  - **Highest sACN priority wins outright** (E1.31 6.2.3) — it is *not*
//!    HTP-mixed with lower ones. Art-Net has no priority field, so it always
//!    arrives at the default and a mixed rig behaves differently from either
//!    protocol alone.
//!  - **A source that stops transmitting is gone after 4 s** of silence.

use std::time::Duration;

pub const UNIVERSE_LEN: usize = 512;
pub const MAX_SOURCES: usize = 2;
pub const SOURCE_TIMEOUT: Duration = Duration::from_millis(4000);
pub const DEFAULT_PRIORITY: u8 = 100;
const ACTIVITY_WINDOW_MS: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMode {
    /// Most recent source wins outright.
    None,
    /// Per-slot maximum.
    Htp,
    /// Latest takes precedence.
    Ltp,
}

#[derive(Clone)]
struct Source {
    /// Identity. For sACN this is the CID (stable across IP changes); for
    /// Art-Net, the source address.
    id: [u8; 16],
    label: String,
    last_ms: u64,
    priority: u8,
    data: [u8; UNIVERSE_LEN],
}

pub struct MergePort {
    sources: Vec<Source>,
    window_start_ms: u64,
    window_packets: u32,
    /// A third source tried to transmit and was refused.
    pub too_many_sources: bool,
}

impl Default for MergePort {
    fn default() -> Self {
        Self::new()
    }
}

impl MergePort {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
            window_start_ms: 0,
            window_packets: 0,
            too_many_sources: false,
        }
    }

    fn expire(&mut self, now_ms: u64) {
        let before = self.sources.len();
        self.sources
            .retain(|s| now_ms.saturating_sub(s.last_ms) <= SOURCE_TIMEOUT.as_millis() as u64);
        if self.sources.len() < before {
            self.too_many_sources = false; // there is room again
        }
    }

    /// Feed one received universe. Returns false when refused.
    pub fn feed(
        &mut self,
        id: [u8; 16],
        label: &str,
        priority: u8,
        slots: &[u8],
        now_ms: u64,
    ) -> bool {
        self.expire(now_ms);

        let mut data = [0u8; UNIVERSE_LEN];
        let n = slots.len().min(UNIVERSE_LEN);
        data[..n].copy_from_slice(&slots[..n]);

        if let Some(existing) = self.sources.iter_mut().find(|s| s.id == id) {
            existing.last_ms = now_ms;
            existing.priority = priority;
            existing.data = data;
        } else if self.sources.len() < MAX_SOURCES {
            self.sources.push(Source {
                id,
                label: label.to_string(),
                last_ms: now_ms,
                priority,
                data,
            });
        } else {
            self.too_many_sources = true;
            return false;
        }

        if self.window_start_ms == 0 {
            self.window_start_ms = now_ms;
        }
        self.window_packets = self.window_packets.saturating_add(1);
        true
    }

    /// Merged output, or `None` when no source is live.
    pub fn result(&mut self, mode: MergeMode, now_ms: u64) -> Option<[u8; UNIVERSE_LEN]> {
        self.expire(now_ms);
        if self.sources.is_empty() {
            return None;
        }

        // Highest priority present wins outright; lower ones are dropped, not
        // merged.
        let top = self.sources.iter().map(|s| s.priority).max().unwrap_or(0);
        let live: Vec<&Source> = self.sources.iter().filter(|s| s.priority == top).collect();

        if live.len() == 1 || mode == MergeMode::None || mode == MergeMode::Ltp {
            let newest = live.iter().max_by_key(|s| s.last_ms).unwrap();
            return Some(newest.data);
        }

        let mut out = live[0].data;
        for source in &live[1..] {
            for k in 0..UNIVERSE_LEN {
                if source.data[k] > out[k] {
                    out[k] = source.data[k];
                }
            }
        }
        Some(out)
    }

    /// Live source count after expiry.
    pub fn source_count(&mut self, now_ms: u64) -> usize {
        self.expire(now_ms);
        self.sources.len()
    }

    pub fn labels(&self) -> Vec<String> {
        self.sources.iter().map(|s| s.label.clone()).collect()
    }

    /// Measured packet rate, frames per second.
    pub fn fps(&mut self, now_ms: u64) -> f32 {
        let elapsed = now_ms.saturating_sub(self.window_start_ms).max(1);
        if elapsed > ACTIVITY_WINDOW_MS * 4 {
            return 0.0; // long silence
        }
        let rate = self.window_packets as f32 * 1000.0 / elapsed as f32;
        if elapsed >= ACTIVITY_WINDOW_MS {
            self.window_start_ms = now_ms;
            self.window_packets = 0;
        }
        rate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> [u8; 16] {
        let mut a = [0u8; 16];
        a[0] = n;
        a
    }

    #[test]
    fn htp_takes_the_per_slot_maximum() {
        let mut port = MergePort::new();
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[10, 200, 5], 0);
        port.feed(id(2), "b", DEFAULT_PRIORITY, &[100, 20, 5], 0);
        let out = port.result(MergeMode::Htp, 0).unwrap();
        assert_eq!(&out[0..3], &[100, 200, 5]);
    }

    #[test]
    fn ltp_takes_the_most_recent_whole_universe() {
        let mut port = MergePort::new();
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[10, 200, 5], 0);
        port.feed(id(2), "b", DEFAULT_PRIORITY, &[100, 20, 5], 10);
        let out = port.result(MergeMode::Ltp, 10).unwrap();
        assert_eq!(&out[0..3], &[100, 20, 5]);
    }

    #[test]
    fn higher_priority_wins_outright_rather_than_merging() {
        // E1.31 6.2.3. A priority-200 console must override a priority-100 one
        // completely — HTP-mixing them would let the lower desk raise levels
        // the higher one had deliberately taken out.
        let mut port = MergePort::new();
        port.feed(id(1), "low", 100, &[255, 255, 255], 0);
        port.feed(id(2), "high", 200, &[0, 0, 10], 0);
        let out = port.result(MergeMode::Htp, 0).unwrap();
        assert_eq!(&out[0..3], &[0, 0, 10]);
    }

    #[test]
    fn a_third_source_is_refused_and_flagged() {
        let mut port = MergePort::new();
        assert!(port.feed(id(1), "a", DEFAULT_PRIORITY, &[1], 0));
        assert!(port.feed(id(2), "b", DEFAULT_PRIORITY, &[2], 0));
        assert!(!port.feed(id(3), "c", DEFAULT_PRIORITY, &[3], 0));
        assert!(port.too_many_sources);
        assert_eq!(port.source_count(0), 2);
    }

    #[test]
    fn a_silent_source_expires_after_four_seconds() {
        let mut port = MergePort::new();
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[1], 0);
        assert_eq!(port.source_count(3_999), 1);
        assert_eq!(port.source_count(4_001), 0);
        assert!(port.result(MergeMode::Htp, 4_001).is_none());
    }

    #[test]
    fn expiry_makes_room_and_clears_the_flag() {
        let mut port = MergePort::new();
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[1], 0);
        port.feed(id(2), "b", DEFAULT_PRIORITY, &[2], 0);
        assert!(!port.feed(id(3), "c", DEFAULT_PRIORITY, &[3], 0));
        assert!(port.too_many_sources);

        // Both originals go silent; the refused source can now be accepted.
        assert!(port.feed(id(3), "c", DEFAULT_PRIORITY, &[3], 5_000));
        assert!(!port.too_many_sources);
    }

    #[test]
    fn the_same_source_updates_in_place_rather_than_taking_a_second_slot() {
        let mut port = MergePort::new();
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[1], 0);
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[2], 10);
        assert_eq!(port.source_count(10), 1);
        assert_eq!(port.result(MergeMode::Htp, 10).unwrap()[0], 2);
    }

    #[test]
    fn a_short_universe_zero_fills_the_rest() {
        // A console sending 24 slots must not leave stale values in 25..512.
        let mut port = MergePort::new();
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[255u8; 512], 0);
        port.feed(id(1), "a", DEFAULT_PRIORITY, &[7, 7, 7], 10);
        let out = port.result(MergeMode::Htp, 10).unwrap();
        assert_eq!(&out[0..3], &[7, 7, 7]);
        assert_eq!(out[3], 0);
        assert_eq!(out[511], 0);
    }
}
