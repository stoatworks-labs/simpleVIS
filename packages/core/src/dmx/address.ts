/**
 * DMX addressing.
 *
 * simpleVIS uses a **1-based universe number** as the canonical identity of a
 * universe everywhere above the transport layer. Art-Net's Net/Sub-Net/Universe
 * triple and sACN's 16-bit universe both collapse onto it, so the patch does
 * not have to know which protocol delivered a frame.
 */

export const SLOTS_PER_UNIVERSE = 512;

/** A universe/channel pair, both 1-based. */
export interface DmxAddress {
  /** 1-based universe. */
  readonly universe: number;
  /** 1-based channel, 1..512. */
  readonly channel: number;
}

/**
 * Convert MVR's absolute address to universe/channel.
 *
 * MVR writes `<Address break="0">3313</Address>`, where the number is
 * `(universe - 1) * 512 + channel` with both 1-based. 3313 is therefore
 * universe 7, channel 241 — **not** universe 6, and not channel 3313.
 */
export function fromAbsolute(absolute: number): DmxAddress {
  const zero = Math.max(0, Math.trunc(absolute) - 1);
  return {
    universe: Math.floor(zero / SLOTS_PER_UNIVERSE) + 1,
    channel: (zero % SLOTS_PER_UNIVERSE) + 1,
  };
}

/** Inverse of {@link fromAbsolute}. */
export function toAbsolute(address: DmxAddress): number {
  return (address.universe - 1) * SLOTS_PER_UNIVERSE + address.channel;
}

/**
 * Parse an MVR `<Address>` value.
 *
 * Most writers use the absolute form. Some emit `universe.channel` instead
 * (Vectorworks does this in older exports), so both are accepted.
 */
export function parseMvrAddress(raw: string): DmxAddress {
  const text = raw.trim();
  const dot = text.indexOf('.');
  if (dot > 0) {
    const universe = Number.parseInt(text.slice(0, dot), 10);
    const channel = Number.parseInt(text.slice(dot + 1), 10);
    if (Number.isFinite(universe) && Number.isFinite(channel)) {
      return { universe: Math.max(1, universe), channel: Math.max(1, channel) };
    }
  }
  const absolute = Number.parseInt(text, 10);
  return fromAbsolute(Number.isFinite(absolute) ? absolute : 1);
}

/**
 * Art-Net's 15-bit Port-Address (Net<<8 | SubNet<<4 | Universe) as a 1-based
 * universe number.
 */
export function fromArtNetPortAddress(portAddress: number): number {
  return (portAddress & 0x7fff) + 1;
}

/** sACN universes are already 1-based 1..63999. */
export function fromSacnUniverse(universe: number): number {
  return universe;
}
