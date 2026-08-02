//! CITP — Controller Interface Transport Protocol.
//!
//! Three layers, which is what simpleVIS needs and no more:
//!
//! | Layer | Why |
//! |---|---|
//! | **PINF** | Peer discovery. `PLoc` is multicast on 224.0.0.180:4809 and carries the TCP port everything else runs over, so nothing works without it. |
//! | **SDMX** | *Send DMX* — levels, as channel blocks. A third input alongside Art-Net and sACN. |
//! | **FPTC** | Fixture patch, so the patch can follow the desk without re-importing an MVR. |
//!
//! ⚠️ **A correction worth carrying:** an earlier version of this project's
//! documentation claimed CITP carries no DMX and named a layer "CaSt". Both were
//! wrong — SDMX transmits levels, and there is no CaSt layer (streaming a
//! viewport to a console is MSEX). What is true is only that consoles *usually*
//! prefer Art-Net or sACN for levels; SDMX's `SXSr` exists to say exactly that.
//!
//! ## Content types are compared as bytes, never as u32
//!
//! Reference headers in the wild define these as `u32` constants, and at least
//! two of them are byte-reversed relative to the rest — `COOKIE_PINF_PNAM` and
//! `COOKIE_SDMX_ENID` spell their code big-endian while `PINF`, `PLoc`, `ChBk`
//! and the FPTC set spell theirs little-endian. Whichever is the typo, matching
//! on `*b"PLoc"` cannot inherit it.
//!
//! ## Strings
//!
//! PINF's strings are 8-bit and null-terminated. UCS-2 appears in MSEX, which
//! this module does not implement — so nothing here needs it.

use std::net::Ipv4Addr;

pub const COOKIE: [u8; 4] = *b"CITP";
pub const VERSION_MAJOR: u8 = 1;
pub const VERSION_MINOR: u8 = 0;
pub const HEADER_LEN: usize = 20;

pub const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 180);
pub const MULTICAST_PORT: u16 = 4809;

// Layer content types.
pub const PINF: [u8; 4] = *b"PINF";
pub const SDMX: [u8; 4] = *b"SDMX";
pub const FPTC: [u8; 4] = *b"FPTC";

// PINF message types.
pub const PLOC: [u8; 4] = *b"PLoc";
pub const PNAM: [u8; 4] = *b"PNam";

// SDMX message types.
pub const CHBK: [u8; 4] = *b"ChBk";
pub const CHLS: [u8; 4] = *b"ChLs";
pub const UNAM: [u8; 4] = *b"UNam";
pub const ENID: [u8; 4] = *b"EnId";
pub const SXSR: [u8; 4] = *b"SXSr";
pub const CAPA: [u8; 4] = *b"Capa";

// FPTC message types.
pub const PTCH: [u8; 4] = *b"Ptch";
pub const UPTC: [u8; 4] = *b"UPtc";
pub const SPTC: [u8; 4] = *b"SPtc";

/// A patched fixture, as a console describes it over FPTC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchEntry {
    pub fixture_id: u16,
    /// 0-based on the wire. simpleVIS uses 1-based universes above the
    /// transport, so this is converted at the boundary, exactly as Art-Net's
    /// Port-Address is.
    pub universe: u8,
    /// 1-based DMX channel.
    pub channel: u16,
    pub channel_count: u16,
}

/// What a peer says about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerLocation {
    /// 0 when the message arrived over TCP rather than multicast.
    pub listening_tcp_port: u16,
    /// "LightingConsole", "MediaServer", "Visualizer", …
    pub kind: String,
    pub name: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    PeerLocation(PeerLocation),
    PeerName(String),
    /// A block of DMX levels for one universe.
    ChannelBlock {
        /// Blind data must not be treated as live output — the same rule as
        /// sACN's preview bit.
        blind: bool,
        /// 0-based on the wire.
        universe: u8,
        /// 0-based offset of the first level in this block.
        first_channel: u16,
        levels: Vec<u8>,
    },
    UniverseName {
        universe: u8,
        name: String,
    },
    /// The peer is telling us to take its levels from somewhere else entirely,
    /// e.g. `"ArtNet/1/0/0"` or `"BSRE1.31/1/1"`. Honouring this is what stops
    /// simpleVIS double-counting a console that sends both.
    SetExternalSource(String),
    Patch(Vec<PatchEntry>),
    Unpatch(Vec<u16>),
    /// The peer is asking us to send our patch.
    SendPatch,
    /// What a peer says it can do with DMX.
    ///
    /// Observed from Capture 2026 on connect: `05 00 | 02 00 03 00 65 00 66 00
    /// 69 00` — a u16 count followed by that many u16 codes, here
    /// `[2, 3, 101, 102, 105]`. The **meaning** of individual codes is not
    /// decoded, because nothing here has verified it and guessing at protocol
    /// semantics is what produced this project's one published error. They are
    /// surfaced as numbers for diagnostics.
    Capabilities(Vec<u16>),
    /// A well-formed CITP message in a layer this module does not implement.
    ///
    /// ⚠️ `kind` is **not always ASCII**. Capture's CAEX messages carry a
    /// numeric content type (`0x00030100`), so rendering this as text gives
    /// mojibake. Treat it as four opaque bytes.
    Unhandled { layer: [u8; 4], kind: [u8; 4] },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CitpError {
    /// Fewer bytes than a header — wait for more rather than discarding.
    Incomplete,
    NotCitp,
    UnsupportedVersion,
    /// `MessageSize` disagrees with what arrived.
    BadLength,
    Malformed,
}

fn le16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}
fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// Read a null-terminated 8-bit string, advancing `pos` past the terminator.
///
/// A string running to the end of the buffer without a NUL is accepted rather
/// than rejected: some writers omit the final terminator on the last field, and
/// dropping an otherwise valid `PLoc` over one missing byte would make the peer
/// invisible for no good reason.
fn read_cstring(buf: &[u8], pos: &mut usize) -> String {
    let start = *pos;
    let end = buf[start..]
        .iter()
        .position(|&b| b == 0)
        .map(|i| start + i)
        .unwrap_or(buf.len());
    *pos = (end + 1).min(buf.len());
    String::from_utf8_lossy(&buf[start..end]).into_owned()
}

/// Total declared length of the message starting at `buf`, for stream framing.
///
/// CITP runs over TCP for everything except `PLoc`, so a reader has to know
/// where one message ends before it can parse the next.
pub fn message_length(buf: &[u8]) -> Result<usize, CitpError> {
    if buf.len() < HEADER_LEN {
        return Err(CitpError::Incomplete);
    }
    if buf[0..4] != COOKIE {
        return Err(CitpError::NotCitp);
    }
    let size = le32(&buf[8..]) as usize;
    if size < HEADER_LEN {
        return Err(CitpError::BadLength);
    }
    Ok(size)
}

/// Parse one complete CITP message.
pub fn parse(buf: &[u8]) -> Result<Message, CitpError> {
    let declared = message_length(buf)?;
    if buf[4] != VERSION_MAJOR {
        return Err(CitpError::UnsupportedVersion);
    }
    if buf.len() < declared {
        return Err(CitpError::Incomplete);
    }
    let buf = &buf[..declared];

    let layer: [u8; 4] = buf[16..20].try_into().map_err(|_| CitpError::Malformed)?;
    if buf.len() < HEADER_LEN + 4 {
        return Err(CitpError::Malformed);
    }
    let kind: [u8; 4] = buf[20..24].try_into().map_err(|_| CitpError::Malformed)?;
    let mut pos = 24;

    match (layer, kind) {
        (PINF, PLOC) => {
            if buf.len() < pos + 2 {
                return Err(CitpError::Malformed);
            }
            let port = le16(&buf[pos..]);
            pos += 2;
            Ok(Message::PeerLocation(PeerLocation {
                listening_tcp_port: port,
                kind: read_cstring(buf, &mut pos),
                name: read_cstring(buf, &mut pos),
                state: read_cstring(buf, &mut pos),
            }))
        }

        (PINF, PNAM) => Ok(Message::PeerName(read_cstring(buf, &mut pos))),

        (SDMX, CHBK) => {
            if buf.len() < pos + 6 {
                return Err(CitpError::Malformed);
            }
            let blind = buf[pos] != 0;
            let universe = buf[pos + 1];
            let first_channel = le16(&buf[pos + 2..]);
            let count = le16(&buf[pos + 4..]) as usize;
            pos += 6;
            // The declared count must fit what actually arrived — the same
            // check that stops a truncated sACN packet reading off the end.
            if pos + count > buf.len() {
                return Err(CitpError::BadLength);
            }
            Ok(Message::ChannelBlock {
                blind,
                universe,
                first_channel,
                levels: buf[pos..pos + count].to_vec(),
            })
        }

        (SDMX, UNAM) => {
            if buf.len() < pos + 1 {
                return Err(CitpError::Malformed);
            }
            let universe = buf[pos];
            pos += 1;
            Ok(Message::UniverseName {
                universe,
                name: read_cstring(buf, &mut pos),
            })
        }

        (SDMX, SXSR) => Ok(Message::SetExternalSource(read_cstring(buf, &mut pos))),

        (SDMX, CAPA) => {
            if buf.len() < pos + 2 {
                return Err(CitpError::Malformed);
            }
            let count = le16(&buf[pos..]) as usize;
            pos += 2;
            if pos + count * 2 > buf.len() {
                return Err(CitpError::BadLength);
            }
            let codes = (0..count).map(|i| le16(&buf[pos + i * 2..])).collect();
            Ok(Message::Capabilities(codes))
        }

        (FPTC, PTCH) => {
            // FPTC's header carries an extra ContentHint word before the body.
            pos += 4;
            let mut entries = Vec::new();
            // The message is a run of fixed-size records filling the rest of
            // the message; the count is implied by MessageSize.
            while pos + 8 <= buf.len() {
                entries.push(PatchEntry {
                    fixture_id: le16(&buf[pos..]),
                    universe: buf[pos + 2],
                    channel: le16(&buf[pos + 4..]),
                    channel_count: le16(&buf[pos + 6..]),
                });
                pos += 8;
            }
            Ok(Message::Patch(entries))
        }

        (FPTC, UPTC) => {
            pos += 4; // ContentHint
            if buf.len() < pos + 2 {
                return Err(CitpError::Malformed);
            }
            let count = le16(&buf[pos..]) as usize;
            pos += 2;
            let mut ids = Vec::with_capacity(count);
            for _ in 0..count {
                if pos + 2 > buf.len() {
                    break;
                }
                ids.push(le16(&buf[pos..]));
                pos += 2;
            }
            Ok(Message::Unpatch(ids))
        }

        (FPTC, SPTC) => Ok(Message::SendPatch),

        _ => Ok(Message::Unhandled { layer, kind }),
    }
}

/// Wrap a layer body in a CITP header.
///
/// `MessageSize` counts the header, so it can only be filled in once the body
/// is known — which is why this takes the finished body rather than offering a
/// writer that has to be patched up afterwards.
pub fn frame(layer: [u8; 4], kind: [u8; 4], body: &[u8]) -> Vec<u8> {
    let total = HEADER_LEN + 4 + body.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&COOKIE);
    out.push(VERSION_MAJOR);
    out.push(VERSION_MINOR);
    out.extend_from_slice(&[0, 0]); // reserved / request index
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // MessagePartCount
    out.extend_from_slice(&0u16.to_le_bytes()); // MessagePart
    out.extend_from_slice(&layer);
    out.extend_from_slice(&kind);
    out.extend_from_slice(body);
    out
}

/// Build the `PLoc` simpleVIS announces itself with.
///
/// `listening_tcp_port` must be 0 when this goes out over an established TCP
/// connection and the real port when it is multicast — the spec distinguishes
/// the two, and a console that reads a stale port from a TCP-borne PLoc will
/// try to open a second connection to nothing.
pub fn peer_location(listening_tcp_port: u16, name: &str, state: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&listening_tcp_port.to_le_bytes());
    for field in [
        // "Visualizer" is what consoles look for when deciding whether to offer
        // a patch or a stream. simpleVIS is not a console and must not claim to
        // be one, or a desk may try to take levels *from* it.
        "Visualizer",
        name,
        state,
    ] {
        body.extend_from_slice(field.as_bytes());
        body.push(0);
    }
    frame(PINF, PLOC, &body)
}

/// Build a `SPtc`, asking a peer to send us its patch.
pub fn send_patch_request() -> Vec<u8> {
    // ContentHint 0: no filtering, give us everything.
    frame(FPTC, SPTC, &0u32.to_le_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_peer_location() {
        let raw = peer_location(4810, "simpleVIS", "Idle");
        let parsed = parse(&raw).expect("should parse");
        assert_eq!(
            parsed,
            Message::PeerLocation(PeerLocation {
                listening_tcp_port: 4810,
                kind: "Visualizer".into(),
                name: "simpleVIS".into(),
                state: "Idle".into(),
            })
        );
    }

    #[test]
    fn header_declares_the_total_including_itself() {
        let raw = peer_location(4810, "x", "y");
        assert_eq!(message_length(&raw).unwrap(), raw.len());
        assert_eq!(&raw[0..4], b"CITP");
        assert_eq!(&raw[16..20], b"PINF");
    }

    /// Content types are matched as bytes precisely so a byte-reversed constant
    /// in someone else's header cannot be inherited.
    #[test]
    fn content_types_are_ascii_in_wire_order() {
        assert_eq!(&PINF, b"PINF");
        assert_eq!(&PLOC, b"PLoc");
        assert_eq!(&PNAM, b"PNam");
        assert_eq!(&ENID, b"EnId");
        assert_eq!(&CHBK, b"ChBk");
    }

    fn chbk(blind: u8, universe: u8, first: u16, levels: &[u8]) -> Vec<u8> {
        let mut body = vec![blind, universe];
        body.extend_from_slice(&first.to_le_bytes());
        body.extend_from_slice(&(levels.len() as u16).to_le_bytes());
        body.extend_from_slice(levels);
        frame(SDMX, CHBK, &body)
    }

    #[test]
    fn parses_a_channel_block() {
        let raw = chbk(0, 3, 100, &[10, 20, 30]);
        match parse(&raw).unwrap() {
            Message::ChannelBlock { blind, universe, first_channel, levels } => {
                assert!(!blind);
                assert_eq!(universe, 3);
                assert_eq!(first_channel, 100);
                assert_eq!(levels, vec![10, 20, 30]);
            }
            other => panic!("expected ChannelBlock, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_channel_count_longer_than_the_message() {
        // Same class of check as sACN's property count: a declared length that
        // overruns the datagram must not be trusted.
        let mut raw = chbk(0, 0, 0, &[1, 2, 3]);
        let count_at = HEADER_LEN + 4 + 4;
        raw[count_at..count_at + 2].copy_from_slice(&500u16.to_le_bytes());
        assert_eq!(parse(&raw), Err(CitpError::BadLength));
    }

    #[test]
    fn blind_data_is_flagged_not_silently_used() {
        let raw = chbk(1, 0, 0, &[255]);
        match parse(&raw).unwrap() {
            Message::ChannelBlock { blind, .. } => assert!(blind),
            other => panic!("expected ChannelBlock, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_patch_with_several_fixtures() {
        let mut body = 0u32.to_le_bytes().to_vec(); // ContentHint
        for (id, universe, channel, count) in [(1u16, 0u8, 1u16, 10u16), (2, 0, 11, 10)] {
            body.extend_from_slice(&id.to_le_bytes());
            body.push(universe);
            body.push(0); // reserved
            body.extend_from_slice(&channel.to_le_bytes());
            body.extend_from_slice(&count.to_le_bytes());
        }
        let raw = frame(FPTC, PTCH, &body);
        match parse(&raw).unwrap() {
            Message::Patch(entries) => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0], PatchEntry { fixture_id: 1, universe: 0, channel: 1, channel_count: 10 });
                assert_eq!(entries[1].fixture_id, 2);
                assert_eq!(entries[1].channel, 11);
            }
            other => panic!("expected Patch, got {other:?}"),
        }
    }

    #[test]
    fn reads_a_set_external_source() {
        let mut body = b"ArtNet/1/0/0".to_vec();
        body.push(0);
        let raw = frame(SDMX, SXSR, &body);
        assert_eq!(
            parse(&raw).unwrap(),
            Message::SetExternalSource("ArtNet/1/0/0".into())
        );
    }

    /// Captured verbatim from Capture 2026 on the wire.
    #[test]
    fn parses_captures_real_capabilities_message() {
        let body = [0x05, 0x00, 0x02, 0x00, 0x03, 0x00, 0x65, 0x00, 0x66, 0x00, 0x69, 0x00];
        let raw = frame(SDMX, CAPA, &body);
        assert_eq!(parse(&raw).unwrap(), Message::Capabilities(vec![2, 3, 101, 102, 105]));
    }

    #[test]
    fn a_non_ascii_content_type_does_not_break_anything() {
        // Capture's CAEX messages carry a numeric kind (0x00030100), not a
        // four-character code. Reported as opaque bytes rather than mangled
        // into text or rejected.
        let kind = 0x00030100u32.to_le_bytes();
        let raw = frame(*b"CAEX", kind, &[]);
        assert_eq!(parse(&raw).unwrap(), Message::Unhandled { layer: *b"CAEX", kind });
    }

    #[test]
    fn an_unknown_layer_is_reported_rather_than_failing() {
        // MSEX and CAEX are not implemented; a console that speaks them must
        // not take the connection down.
        let raw = frame(*b"MSEX", *b"CInf", &[0u8; 4]);
        assert_eq!(
            parse(&raw).unwrap(),
            Message::Unhandled { layer: *b"MSEX", kind: *b"CInf" }
        );
    }

    #[test]
    fn distinguishes_incomplete_from_invalid() {
        // A TCP reader must wait for more bytes rather than resynchronising.
        assert_eq!(parse(&[]), Err(CitpError::Incomplete));
        assert_eq!(parse(b"CITP"), Err(CitpError::Incomplete));

        let raw = peer_location(1, "a", "b");
        assert_eq!(parse(&raw[..raw.len() - 3]), Err(CitpError::Incomplete));

        assert_eq!(parse(&[0u8; 40]), Err(CitpError::NotCitp));
    }

    #[test]
    fn tolerates_a_missing_final_terminator() {
        // Some writers omit the NUL on the last string. Dropping the whole
        // PLoc over one byte would make the peer invisible.
        let mut body = 4810u16.to_le_bytes().to_vec();
        body.extend_from_slice(b"Visualizer\0simpleVIS\0Idle");
        let raw = frame(PINF, PLOC, &body);
        match parse(&raw).unwrap() {
            Message::PeerLocation(p) => assert_eq!(p.state, "Idle"),
            other => panic!("expected PeerLocation, got {other:?}"),
        }
    }
}
