/**
 * A synthetic console.
 *
 * Writes plausible, moving DMX into a `UniverseStore` for any patch, so the
 * viewer can be exercised with no network, no interface and no desk. That
 * serves three purposes and all three matter:
 *
 *  - it is what the **hosted build** shows, since a browser can never receive
 *    Art-Net or sACN;
 *  - it is the **verification path** for the renderer on a machine with no
 *    lighting hardware attached;
 *  - it is what gets **filmed** for the project video.
 *
 * It drives the patch through its own resolved channels rather than writing
 * hard-coded slot numbers, so it works on any MVR without being told anything
 * about the rig.
 *
 * ⚠️ This is a test pattern, not a lighting desk. It proves the chain from DMX
 * slot to photons on screen; it says nothing about whether a real console's
 * output looks right.
 */

import type { PatchedChannel, PatchedFixture } from '../patch.js';
import type { UniverseStore } from './universe.js';

/** Write a 0..1 value across a channel's bytes, coarse first. */
function writeChannel(store: UniverseStore, channel: PatchedChannel, value: number): void {
  if (channel.addresses.length === 0) return;
  const full = 2 ** (8 * channel.addresses.length) - 1;
  let raw = Math.max(0, Math.min(full, Math.round(value * full)));

  const bytes: number[] = [];
  for (let i = 0; i < channel.addresses.length; i++) {
    bytes.unshift(raw & 0xff);
    raw = Math.floor(raw / 256);
  }
  channel.addresses.forEach((address, i) => {
    const slots = store.get(address.universe);
    slots[address.channel - 1] = bytes[i];
    store.set(address.universe, slots);
  });
}

/**
 * Find a DMX value that opens the shutter.
 *
 * A shutter channel's "closed" state is written as a function whose physical
 * range is 0 -> 0, and its strobe states carry a `Strobe` attribute. The open
 * band is whatever is left. Guessing a fixed value like 255 lands in the strobe
 * range on plenty of real fixtures.
 *
 * Two refinements, both learned from real files:
 *
 *  - **Aim at the centre of the band, not just past its start.** The Prolights
 *    Sunrise2IP's first `Open` band is **two DMX values wide** (63-64), with a
 *    strobe-pulse function beginning at 65. Nudging a fixed epsilon past the
 *    start overshoots straight into it, and the demo strobes the whole rig.
 *  - **Prefer the widest open band.** Fixtures often declare several, and the
 *    widest is the plain one; the narrow ones tend to be special modes.
 */
function openShutterValue(channel: PatchedChannel): number {
  // Sorted starts let each function's span be measured against the next.
  const starts = [...new Set(channel.functions.map((f) => f.dmxFrom))].sort((a, b) => a - b);
  const endOf = (from: number) => starts.find((s) => s > from) ?? 1;

  let best: { centre: number; width: number } | undefined;
  for (const fn of channel.functions) {
    const closed = fn.physicalFrom === 0 && fn.physicalTo === 0;
    if (closed || fn.attribute.includes('Strobe') || fn.attribute === 'NoFeature') continue;

    const end = endOf(fn.dmxFrom);
    const width = end - fn.dmxFrom;
    if (!best || width > best.width) {
      best = { centre: fn.dmxFrom + width / 2, width };
    }
  }
  return best ? Math.min(1, best.centre) : 1;
}

export interface DemoOptions {
  /** Overall movement speed multiplier. */
  speed?: number;
  /** 0..1 master level. */
  intensity?: number;
}

/**
 * A looping demo look: slow criss-cross movement, a colour wash drifting
 * through the rig, and a zoom breath.
 */
export class DemoSource {
  private readonly fixtures: readonly PatchedFixture[];
  private readonly options: Required<DemoOptions>;

  constructor(fixtures: readonly PatchedFixture[], options: DemoOptions = {}) {
    this.fixtures = fixtures;
    this.options = { speed: options.speed ?? 1, intensity: options.intensity ?? 1 };
  }

  /** Write one frame at time `t` seconds. */
  tick(store: UniverseStore, t: number): void {
    const speed = this.options.speed;
    const master = this.options.intensity;

    this.fixtures.forEach((fixture, index) => {
      // Spread the rig out in phase so it reads as a look rather than every
      // fixture doing the same thing at the same moment.
      const phase = index * 0.7;

      for (const channel of fixture.channels) {
        if (channel.addresses.length === 0) continue;

        // Sub-emitters get their own offset so a pixel wall ripples.
        const sub = channel.instance ? hashPhase(channel.instance) : 0;
        const p = phase + sub * 6;

        switch (channel.attribute) {
          case 'Dimmer':
            writeChannel(store, channel, master * (0.55 + 0.45 * Math.sin(t * 0.9 * speed + p)));
            break;
          case 'Shutter1':
          case 'Shutter':
            writeChannel(store, channel, openShutterValue(channel));
            break;
          case 'Pan':
            writeChannel(store, channel, 0.5 + 0.28 * Math.sin(t * 0.37 * speed + p));
            break;
          case 'Tilt':
            writeChannel(store, channel, 0.5 + 0.18 * Math.sin(t * 0.53 * speed + p * 1.3));
            break;
          case 'Zoom':
            writeChannel(store, channel, 0.5 + 0.35 * Math.sin(t * 0.21 * speed));
            break;
          // Subtractive CMY: keep one flag mostly out so the beam stays bright.
          case 'ColorSub_C':
            writeChannel(store, channel, 0.5 + 0.5 * Math.sin(t * 0.23 * speed + p));
            break;
          case 'ColorSub_M':
            writeChannel(store, channel, 0.5 + 0.5 * Math.sin(t * 0.19 * speed + p + 2.1));
            break;
          case 'ColorSub_Y':
            writeChannel(store, channel, 0.5 + 0.5 * Math.sin(t * 0.17 * speed + p + 4.2));
            break;
          // Additive RGB: a travelling hue.
          case 'ColorAdd_R':
            writeChannel(store, channel, 0.5 + 0.5 * Math.sin(t * 0.6 * speed + p));
            break;
          case 'ColorAdd_G':
            writeChannel(store, channel, 0.5 + 0.5 * Math.sin(t * 0.6 * speed + p + 2.094));
            break;
          case 'ColorAdd_B':
            writeChannel(store, channel, 0.5 + 0.5 * Math.sin(t * 0.6 * speed + p + 4.188));
            break;
          default:
            break;
        }
      }
    });
  }
}

/** Stable 0..1 from an instance name, so pixel order drives the ripple. */
function hashPhase(name: string): number {
  // The trailing number in "GeometryReference 42" is the pixel index, which
  // gives a spatially coherent ripple. Fall back to a character sum for names
  // that carry no index, e.g. "Pixel_left".
  const match = /(\d+)\s*$/.exec(name);
  if (match) return (Number.parseInt(match[1], 10) % 100) / 100;
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum = (sum + name.charCodeAt(i)) % 97;
  return sum / 97;
}
