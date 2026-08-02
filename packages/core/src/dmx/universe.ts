/**
 * Live universe storage.
 *
 * One flat 512-byte buffer per universe, written by whichever transport
 * delivered the frame (Art-Net, sACN, USB DMX) and read once per rendered
 * frame. Deliberately mutable and allocation-free on the hot path: at 44 Hz
 * across the Demostage's 28 universes this is touched ~1,200 times a second.
 */

import { SLOTS_PER_UNIVERSE, type DmxAddress } from './address.js';

export class UniverseStore {
  private readonly buffers = new Map<number, Uint8Array>();
  /** Bumped on every write, so the renderer can skip untouched frames. */
  private revision = 0;

  /** Existing buffer for a universe, or a freshly zeroed one. */
  get(universe: number): Uint8Array {
    let buffer = this.buffers.get(universe);
    if (!buffer) {
      buffer = new Uint8Array(SLOTS_PER_UNIVERSE);
      this.buffers.set(universe, buffer);
    }
    return buffer;
  }

  /** True once any frame has arrived for this universe. */
  has(universe: number): boolean {
    return this.buffers.has(universe);
  }

  /** Replace a universe's contents. `slots` may be shorter than 512. */
  set(universe: number, slots: Uint8Array): void {
    const buffer = this.get(universe);
    buffer.set(slots.subarray(0, SLOTS_PER_UNIVERSE));
    if (slots.length < SLOTS_PER_UNIVERSE) buffer.fill(0, slots.length);
    this.revision++;
  }

  /** Read one slot. Out-of-range or unseen universes read as 0. */
  read(address: DmxAddress): number {
    const buffer = this.buffers.get(address.universe);
    if (!buffer) return 0;
    const index = address.channel - 1;
    return index >= 0 && index < SLOTS_PER_UNIVERSE ? buffer[index] : 0;
  }

  /**
   * Read a channel of one or more bytes as a 0..1 fraction of full scale.
   *
   * Bytes are big-endian coarse-first, which is what both `Offset="2,3"` and
   * every console mean by a 16-bit channel. An empty address list is a virtual
   * channel and yields `fallback`.
   */
  readNormalised(addresses: readonly DmxAddress[], fallback = 0): number {
    if (addresses.length === 0) return fallback;
    let value = 0;
    for (const address of addresses) value = value * 256 + this.read(address);
    const full = 2 ** (8 * addresses.length) - 1;
    return value / full;
  }

  get version(): number {
    return this.revision;
  }

  clear(): void {
    this.buffers.clear();
    this.revision++;
  }

  /** Universes that have received at least one frame. */
  universes(): number[] {
    return [...this.buffers.keys()].sort((a, b) => a - b);
  }
}
