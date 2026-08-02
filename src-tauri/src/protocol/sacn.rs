//! ANSI E1.31 (sACN) data-packet parsing.
//!
//! Ported from nanODE's host-tested C99 implementation
//! (`firmware/components/artnet/sacn.c`), which has been exercised against real
//! consoles. The layered ACN framing is fiddly and **every layer carries its own
//! length and vector**, so each one is validated rather than trusted:
//!
//! ```text
//!   Root layer    0   preamble, ACN id, vector, CID
//!   Framing layer 38  vector, source name, PRIORITY, sync addr, seq, universe
//!   DMP layer   115   vector, address/data type, slot count, start code, data
//! ```
//!
//! The checks that matter most in practice are the DMP address type and the
//! declared property count: a packet claiming more slots than the datagram
//! actually contains would otherwise read past the end of the buffer.

pub const SACN_PORT: u16 = 5568;
pub const DEFAULT_PRIORITY: u8 = 100;
pub const MAX_SLOTS: usize = 512;

const OFF_PREAMBLE: usize = 0;
const OFF_ACN_ID: usize = 4;
const OFF_ROOT_VECTOR: usize = 18;
const OFF_CID: usize = 22;
const OFF_FRAME_VECTOR: usize = 40;
const OFF_SOURCE_NAME: usize = 44;
const OFF_PRIORITY: usize = 108;
const OFF_SEQUENCE: usize = 111;
const OFF_OPTIONS: usize = 112;
const OFF_UNIVERSE: usize = 113;
const OFF_DMP_VECTOR: usize = 117;
const OFF_ADDR_TYPE: usize = 118;
const OFF_FIRST_ADDR: usize = 119;
const OFF_ADDR_INCR: usize = 121;
const OFF_PROP_COUNT: usize = 123;
const OFF_START_CODE: usize = 125;
const OFF_DATA: usize = 126;

const VECTOR_ROOT_E131_DATA: u32 = 0x0000_0004;
const VECTOR_E131_DATA_PACKET: u32 = 0x0000_0002;
const VECTOR_DMP_SET_PROPERTY: u8 = 0x02;

/// "ASC-E1.17" followed by three NULs.
const ACN_ID: [u8; 12] = [
    0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SacnError {
    Short,
    Preamble,
    AcnId,
    Vector,
    Dmp,
    Length,
    /// Start code is not 0x00, so this is RDM or similar — not DMX levels.
    StartCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SacnPacket<'a> {
    pub universe: u16,
    /// 0-200. Higher wins outright (E1.31 6.2.3).
    pub priority: u8,
    pub sequence: u8,
    /// Source identity, stable across IP changes — this, not the address, is
    /// what identifies a console that has moved or re-homed.
    pub cid: [u8; 16],
    pub source_name: String,
    /// Preview data: must not be acted on as live output.
    pub preview: bool,
    /// The source is announcing it has stopped.
    pub terminated: bool,
    pub slots: &'a [u8],
}

fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// Parse an E1.31 data packet.
pub fn parse(buf: &[u8]) -> Result<SacnPacket<'_>, SacnError> {
    if buf.len() < OFF_DATA {
        return Err(SacnError::Short);
    }
    if be16(&buf[OFF_PREAMBLE..]) != 0x0010 {
        return Err(SacnError::Preamble);
    }
    if buf[OFF_ACN_ID..OFF_ACN_ID + 12] != ACN_ID {
        return Err(SacnError::AcnId);
    }
    if be32(&buf[OFF_ROOT_VECTOR..]) != VECTOR_ROOT_E131_DATA
        || be32(&buf[OFF_FRAME_VECTOR..]) != VECTOR_E131_DATA_PACKET
    {
        return Err(SacnError::Vector);
    }
    if buf[OFF_DMP_VECTOR] != VECTOR_DMP_SET_PROPERTY {
        return Err(SacnError::Dmp);
    }

    // Fixed for a DMX universe. A mismatch means this is some other DMP
    // payload and must not be treated as levels.
    if buf[OFF_ADDR_TYPE] != 0xA1
        || be16(&buf[OFF_FIRST_ADDR..]) != 0x0000
        || be16(&buf[OFF_ADDR_INCR..]) != 0x0001
    {
        return Err(SacnError::Dmp);
    }

    let count = be16(&buf[OFF_PROP_COUNT..]) as usize; // includes the start code
    if count < 1 || count > MAX_SLOTS + 1 {
        return Err(SacnError::Length);
    }
    // The declared count must fit what actually arrived.
    if OFF_START_CODE + count > buf.len() {
        return Err(SacnError::Length);
    }
    if buf[OFF_START_CODE] != 0x00 {
        return Err(SacnError::StartCode);
    }

    let mut cid = [0u8; 16];
    cid.copy_from_slice(&buf[OFF_CID..OFF_CID + 16]);

    let name_bytes = &buf[OFF_SOURCE_NAME..OFF_SOURCE_NAME + 64];
    let end = name_bytes.iter().position(|&b| b == 0).unwrap_or(64);
    let source_name = String::from_utf8_lossy(&name_bytes[..end]).into_owned();

    let options = buf[OFF_OPTIONS];

    Ok(SacnPacket {
        universe: be16(&buf[OFF_UNIVERSE..]),
        priority: buf[OFF_PRIORITY],
        sequence: buf[OFF_SEQUENCE],
        cid,
        source_name,
        preview: options & 0x80 != 0,
        terminated: options & 0x40 != 0,
        slots: &buf[OFF_DATA..OFF_START_CODE + count],
    })
}

/// Multicast group for a universe: `239.255.<hi>.<lo>`.
pub fn multicast_ip(universe: u16) -> std::net::Ipv4Addr {
    std::net::Ipv4Addr::new(239, 255, (universe >> 8) as u8, (universe & 0xFF) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal but valid E1.31 data packet.
    fn packet(universe: u16, priority: u8, slots: &[u8]) -> Vec<u8> {
        let mut b = vec![0u8; OFF_DATA + slots.len()];
        b[0..2].copy_from_slice(&0x0010u16.to_be_bytes());
        b[OFF_ACN_ID..OFF_ACN_ID + 12].copy_from_slice(&ACN_ID);
        b[OFF_ROOT_VECTOR..OFF_ROOT_VECTOR + 4]
            .copy_from_slice(&VECTOR_ROOT_E131_DATA.to_be_bytes());
        b[OFF_FRAME_VECTOR..OFF_FRAME_VECTOR + 4]
            .copy_from_slice(&VECTOR_E131_DATA_PACKET.to_be_bytes());
        b[OFF_PRIORITY] = priority;
        b[OFF_UNIVERSE..OFF_UNIVERSE + 2].copy_from_slice(&universe.to_be_bytes());
        b[OFF_DMP_VECTOR] = VECTOR_DMP_SET_PROPERTY;
        b[OFF_ADDR_TYPE] = 0xA1;
        b[OFF_ADDR_INCR..OFF_ADDR_INCR + 2].copy_from_slice(&1u16.to_be_bytes());
        let count = (slots.len() + 1) as u16;
        b[OFF_PROP_COUNT..OFF_PROP_COUNT + 2].copy_from_slice(&count.to_be_bytes());
        b[OFF_START_CODE] = 0x00;
        b[OFF_DATA..].copy_from_slice(slots);
        b
    }

    #[test]
    fn parses_a_valid_packet() {
        let raw = packet(7, 120, &[1, 2, 3, 4]);
        let p = parse(&raw).expect("should parse");
        assert_eq!(p.universe, 7);
        assert_eq!(p.priority, 120);
        assert_eq!(p.slots, &[1, 2, 3, 4]);
        assert!(!p.preview);
    }

    #[test]
    fn rejects_a_count_longer_than_the_datagram() {
        // The check that stops a malicious or truncated packet from reading
        // past the end of the buffer.
        let mut raw = packet(1, 100, &[1, 2, 3, 4]);
        raw[OFF_PROP_COUNT..OFF_PROP_COUNT + 2].copy_from_slice(&500u16.to_be_bytes());
        assert_eq!(parse(&raw), Err(SacnError::Length));
    }

    #[test]
    fn rejects_a_non_dmx_start_code() {
        let mut raw = packet(1, 100, &[1, 2]);
        raw[OFF_START_CODE] = 0xCC; // RDM
        assert_eq!(parse(&raw), Err(SacnError::StartCode));
    }

    #[test]
    fn rejects_foreign_traffic_on_the_same_port() {
        assert_eq!(parse(&[0u8; 200]), Err(SacnError::Preamble));
        assert_eq!(parse(&[0u8; 10]), Err(SacnError::Short));
    }

    #[test]
    fn reads_the_options_bits() {
        let mut raw = packet(1, 100, &[9]);
        raw[OFF_OPTIONS] = 0x80;
        assert!(parse(&raw).unwrap().preview);
        raw[OFF_OPTIONS] = 0x40;
        assert!(parse(&raw).unwrap().terminated);
    }

    #[test]
    fn multicast_group_follows_the_universe() {
        assert_eq!(multicast_ip(1), std::net::Ipv4Addr::new(239, 255, 0, 1));
        assert_eq!(multicast_ip(258), std::net::Ipv4Addr::new(239, 255, 1, 2));
        assert_eq!(multicast_ip(0xFFFF), std::net::Ipv4Addr::new(239, 255, 255, 255));
    }
}
