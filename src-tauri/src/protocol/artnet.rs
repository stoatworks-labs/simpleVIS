//! Art-Net 4 packet parsing — ArtDmx, ArtPoll and ArtSync.
//!
//! Only what a visualiser needs: receiving levels, being discoverable, and
//! honouring a synchronised flush. Art-Net has no priority field, so every
//! source arrives at the merge engine with the default priority — which is
//! exactly why a rig mixing Art-Net and sACN behaves differently from one
//! running either alone.

use std::net::Ipv4Addr;

pub const ARTNET_PORT: u16 = 6454;

const ID: &[u8; 8] = b"Art-Net\0";

const OP_POLL: u16 = 0x2000;
const OP_POLL_REPLY: u16 = 0x2100;
const OP_DMX: u16 = 0x5000;
const OP_SYNC: u16 = 0x5200;

#[derive(Debug, Clone)]
pub enum ArtNetPacket<'a> {
    Dmx {
        /// 15-bit Port-Address: Net<<8 | SubNet<<4 | Universe.
        port_address: u16,
        sequence: u8,
        physical: u8,
        slots: &'a [u8],
    },
    Poll,
    /// All mapped ports should present their pending data together.
    Sync,
    /// Something valid but not interesting here (PollReply, RDM, …).
    Other(u16),
}

fn le16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}
fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}

/// Parse an Art-Net datagram. Returns `None` for anything that is not Art-Net.
pub fn parse(buf: &[u8]) -> Option<ArtNetPacket<'_>> {
    if buf.len() < 12 || &buf[0..8] != ID {
        return None;
    }
    // OpCode is little-endian; the length field later in ArtDmx is big-endian.
    // Mixing those up is the classic Art-Net bug: it yields a plausible-looking
    // universe number and a wildly wrong slot count.
    let opcode = le16(&buf[8..]);

    match opcode {
        OP_DMX => {
            if buf.len() < 18 {
                return None;
            }
            let length = be16(&buf[16..]) as usize;
            if length == 0 || length > 512 || 18 + length > buf.len() {
                return None;
            }
            Some(ArtNetPacket::Dmx {
                port_address: u16::from(buf[14]) | (u16::from(buf[15]) << 8),
                sequence: buf[12],
                physical: buf[13],
                slots: &buf[18..18 + length],
            })
        }
        OP_POLL => Some(ArtNetPacket::Poll),
        OP_SYNC => Some(ArtNetPacket::Sync),
        other => Some(ArtNetPacket::Other(other)),
    }
}

/// Build an ArtPollReply so consoles list simpleVIS as a node.
pub fn poll_reply(ip: Ipv4Addr, short_name: &str, long_name: &str) -> Vec<u8> {
    let mut b = vec![0u8; 239];
    b[0..8].copy_from_slice(ID);
    b[8..10].copy_from_slice(&OP_POLL_REPLY.to_le_bytes());
    b[10..14].copy_from_slice(&ip.octets());
    b[14..16].copy_from_slice(&ARTNET_PORT.to_le_bytes());

    let put = |dst: &mut [u8], text: &str| {
        let bytes = text.as_bytes();
        let n = bytes.len().min(dst.len() - 1);
        dst[..n].copy_from_slice(&bytes[..n]);
    };
    put(&mut b[26..44], short_name);
    put(&mut b[44..108], long_name);

    // NumPorts = 0: simpleVIS consumes DMX and emits none, so advertising
    // output ports would invite a console to try to patch to it.
    b[173] = 0;
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dmx(port_address: u16, slots: &[u8]) -> Vec<u8> {
        let mut b = vec![0u8; 18 + slots.len()];
        b[0..8].copy_from_slice(ID);
        b[8..10].copy_from_slice(&OP_DMX.to_le_bytes());
        b[12] = 0; // sequence
        b[14] = (port_address & 0xFF) as u8;
        b[15] = (port_address >> 8) as u8;
        b[16..18].copy_from_slice(&(slots.len() as u16).to_be_bytes());
        b[18..].copy_from_slice(slots);
        b
    }

    #[test]
    fn parses_artdmx() {
        let raw = dmx(6, &[10, 20, 30]);
        match parse(&raw).expect("artnet") {
            ArtNetPacket::Dmx { port_address, slots, .. } => {
                assert_eq!(port_address, 6);
                assert_eq!(slots, &[10, 20, 30]);
            }
            other => panic!("expected Dmx, got {other:?}"),
        }
    }

    #[test]
    fn length_is_big_endian_while_opcode_is_little() {
        // 258 slots: 0x0102. Read little-endian this would be 0x0201 = 513,
        // which is longer than a universe and would be rejected — the failure
        // looks like a truncated packet rather than a byte-order mistake.
        let raw = dmx(0, &vec![7u8; 258]);
        match parse(&raw).unwrap() {
            ArtNetPacket::Dmx { slots, .. } => assert_eq!(slots.len(), 258),
            other => panic!("expected Dmx, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_length_longer_than_the_datagram() {
        let mut raw = dmx(0, &[1, 2, 3]);
        raw[16..18].copy_from_slice(&400u16.to_be_bytes());
        assert!(parse(&raw).is_none());
    }

    #[test]
    fn ignores_foreign_traffic() {
        assert!(parse(b"not art-net at all").is_none());
        assert!(parse(&[0u8; 4]).is_none());
    }

    #[test]
    fn recognises_poll_and_sync() {
        let mut b = vec![0u8; 14];
        b[0..8].copy_from_slice(ID);
        b[8..10].copy_from_slice(&OP_POLL.to_le_bytes());
        assert!(matches!(parse(&b), Some(ArtNetPacket::Poll)));

        b[8..10].copy_from_slice(&OP_SYNC.to_le_bytes());
        assert!(matches!(parse(&b), Some(ArtNetPacket::Sync)));
    }

    #[test]
    fn poll_reply_is_well_formed() {
        let reply = poll_reply(Ipv4Addr::new(10, 0, 0, 5), "simpleVIS", "simpleVIS visualiser");
        assert_eq!(&reply[0..8], ID);
        assert_eq!(le16(&reply[8..]), OP_POLL_REPLY);
        assert_eq!(&reply[10..14], &[10, 0, 0, 5]);
        // Advertises no output ports: this node only listens.
        assert_eq!(reply[173], 0);
    }
}
