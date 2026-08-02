/**
 * Turning live DMX into something drawable.
 *
 * For each fixture this produces one `EmitterState` per beam instance — a
 * moving head has one, the Generic LED Wall has a hundred — carrying the pose,
 * the emitted colour and the cone geometry the renderer needs. Nothing here
 * knows about three.js or WebGPU.
 *
 * Two GDTF details do most of the work:
 *
 *  - A channel's **physical range may run backwards** (`Pan` is 270 -> -270,
 *    `Zoom` 50.2 -> 6.6). Interpolation is always
 *    `from + v * (to - from)`, which handles both directions; anything that
 *    normalises the range first will mirror every fixture.
 *  - A channel's **`Geometry` says what it moves**. Pan is written against
 *    `Yoke` and Tilt against `Head`, so the two rotations compose in the right
 *    order without the renderer hard-coding a moving-head skeleton.
 *
 * Known limitation, stated rather than hidden: GDTF `ModeMaster` relations are
 * parsed into `GdtfChannelFunction.modeMaster` but **not yet evaluated**. Where
 * several functions on one channel share `DMXFrom` — the MAC Ultra has four
 * `Gobo1Pos` functions all starting at 0, selected by the gobo wheel channel —
 * the first is used. That is correct for indexing, and wrong for the shake and
 * spin variants of the same channel.
 */

import type { PatchedChannel, PatchedFixture } from '../patch.js';
import type { GdtfChannelFunction } from '../gdtf/types.js';
import { findBeams } from '../gdtf/parse.js';
import type { UniverseStore } from './universe.js';

/** Linear RGB, 0..1, unbounded above for over-bright emitters. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Everything the renderer needs to draw one beam. */
export interface EmitterState {
  /** Geometry instance this emitter belongs to; '' for a single-beam fixture. */
  readonly instance: string;
  /** Combined dimmer and shutter, 0..1. */
  readonly intensity: number;
  /** Strobe rate in Hz; 0 means not strobing. */
  readonly strobeHz: number;
  /** Degrees, GDTF sign convention. */
  readonly pan: number;
  readonly tilt: number;
  /** Live cone half-angle source: zoom if present, else the GDTF beam angle. */
  readonly beamAngle: number;
  readonly fieldAngle: number;
  /** Emitted colour after CMY / RGB / CTO, linear. */
  readonly color: Rgb;
  /** 0 = fully closed, 1 = fully open. */
  readonly iris: number;
  readonly focus: number;
  readonly frost: number;
  /** Peak output in lumens, before intensity. */
  readonly luminousFlux: number;
}

export interface FixtureState {
  readonly uuid: string;
  readonly emitters: readonly EmitterState[];
}

/**
 * Select the active ChannelFunction for a normalised value.
 *
 * Functions are spans starting at `dmxFrom` and running to the next one's
 * start, so the active function is the last whose start is at or below the
 * value. Ties are resolved by document order — see the ModeMaster note above.
 */
export function selectFunction(
  functions: readonly GdtfChannelFunction[],
  value: number,
): GdtfChannelFunction | undefined {
  let best: GdtfChannelFunction | undefined;
  let bestFrom = -1;
  for (const fn of functions) {
    if (fn.dmxFrom <= value + 1e-9 && fn.dmxFrom > bestFrom) {
      best = fn;
      bestFrom = fn.dmxFrom;
    }
  }
  return best ?? functions[0];
}

/**
 * Map a normalised channel value onto its physical quantity.
 *
 * The value is re-normalised across the active function's own span so a
 * function occupying the top half of a channel still sweeps its full physical
 * range.
 */
export function physicalValue(
  functions: readonly GdtfChannelFunction[],
  value: number,
  fallback: number,
): number {
  const fn = selectFunction(functions, value);
  if (!fn) return fallback;

  // Span runs from this function's start to the next function's start.
  let next = 1;
  for (const other of functions) {
    if (other.dmxFrom > fn.dmxFrom && other.dmxFrom < next) next = other.dmxFrom;
  }
  const span = next - fn.dmxFrom;
  const local = span > 1e-9 ? Math.min(1, Math.max(0, (value - fn.dmxFrom) / span)) : 0;

  return fn.physicalFrom + local * (fn.physicalTo - fn.physicalFrom);
}

/**
 * Blackbody colour temperature to linear RGB, normalised so the brightest
 * component is 1.
 *
 * Tanner Helland's piecewise approximation, converted from sRGB-ish output to
 * linear. Good to a few percent across 1000-12000 K, which is well inside the
 * error of everything else in the beam model, and far cheaper than a full
 * Planckian locus lookup.
 */
export function kelvinToRgb(kelvin: number): Rgb {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }

  const srgbToLinear = (c: number) => {
    const n = Math.min(255, Math.max(0, c)) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  const lin = { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) };
  const peak = Math.max(lin.r, lin.g, lin.b, 1e-6);
  return { r: lin.r / peak, g: lin.g / peak, b: lin.b / peak };
}

/** Group a fixture's channels by the instance they belong to. */
function byInstance(channels: readonly PatchedChannel[]): Map<string, PatchedChannel[]> {
  const map = new Map<string, PatchedChannel[]>();
  for (const channel of channels) {
    const list = map.get(channel.instance) ?? [];
    list.push(channel);
    map.set(channel.instance, list);
  }
  return map;
}

/** Evaluate one fixture against the current universe contents. */
export function evaluateFixture(
  patched: PatchedFixture,
  store: UniverseStore,
): FixtureState {
  const beams = findBeams(patched.fixtureType.geometries);
  const beam = beams[0]?.geometry.beam;
  const groups = byInstance(patched.channels);

  // A fixture can have a main emitter *and* sub-emitters. The Prolights
  // Sunrise2IP is a wash with two eye-candy pixels: its channels split into a
  // root group plus `Pixel_left` and `Pixel_right`. Those pixels sit inside the
  // moving head, so they must inherit its pan, tilt and master dimmer — the
  // root group is evaluated first and passed down as the fallback. Without
  // this the eye candy stays pointing at 0,0 while the head moves.
  const rootChannels = groups.get('') ?? [];
  const root = rootChannels.length > 0
    ? evaluateGroup('', rootChannels, store, beam, undefined)
    : undefined;

  const emitters: EmitterState[] = root ? [root] : [];
  for (const [instance, channels] of groups) {
    if (instance === '') continue;
    emitters.push(evaluateGroup(instance, channels, store, beam, root));
  }

  return { uuid: patched.fixture.uuid, emitters };
}

/**
 * Evaluate one instance group.
 *
 * `inherit` is the fixture's root emitter, when it has one. Attributes absent
 * from this group fall back to it, and intensity multiplies through it so a
 * master dimmer at zero blacks out the sub-pixels too.
 */
function evaluateGroup(
  instance: string,
  channels: readonly PatchedChannel[],
  store: UniverseStore,
  beam: ReturnType<typeof findBeams>[number]['geometry']['beam'],
  inherit: EmitterState | undefined,
): EmitterState {
  {
    const find = (attribute: string) => channels.find((c) => c.attribute === attribute);

    const read = (channel: PatchedChannel | undefined): number =>
      channel ? store.readNormalised(channel.addresses, channel.initialValue) : 0;

    const physical = (attribute: string, fallback: number): number => {
      const channel = find(attribute);
      if (!channel) return fallback;
      return physicalValue(channel.functions, read(channel), fallback);
    };

    // --- intensity -------------------------------------------------------
    const dimmerChannel = find('Dimmer');
    // Two ways a fixture ends up with no controllable dimmer, both of which
    // must read as "fully on" rather than "off":
    //
    //  - No Dimmer channel at all. An LED wall pixel has only RGB.
    //  - A **virtual** Dimmer — declared with an empty `Offset`, so it occupies
    //    no DMX and no console can ever drive it. The Generic LED Wall does
    //    exactly this and its default is 0, so honouring the default would
    //    leave every wall in the show permanently black no matter what the
    //    desk sends to the colour channels.
    const dimmer =
      !dimmerChannel || dimmerChannel.addresses.length === 0 ? 1 : read(dimmerChannel);

    const shutterChannel = find('Shutter1') ?? find('Shutter');
    let shutter = 1;
    let strobeHz = 0;
    if (shutterChannel) {
      const value = read(shutterChannel);
      const fn = selectFunction(shutterChannel.functions, value);
      const attribute = fn?.attribute ?? '';
      if (attribute.includes('Strobe')) {
        strobeHz = physicalValue(shutterChannel.functions, value, 0);
        shutter = 1;
      } else if (fn && fn.physicalFrom === 0 && fn.physicalTo === 0) {
        shutter = 0; // closed
      }
    }

    // --- colour ----------------------------------------------------------
    const baseK = beam?.colorTemperature ?? 6500;
    const cto = physical('CTO', baseK);
    let color = kelvinToRgb(Number.isFinite(cto) && cto > 0 ? cto : baseK);

    // Subtractive CMY: 1 means the flag is fully in.
    const hasCmy = find('ColorSub_C') ?? find('ColorSub_M') ?? find('ColorSub_Y');
    if (hasCmy) {
      const c = read(find('ColorSub_C'));
      const m = read(find('ColorSub_M'));
      const y = read(find('ColorSub_Y'));
      color = { r: color.r * (1 - c), g: color.g * (1 - m), b: color.b * (1 - y) };
    }

    // Additive RGB(W) replaces the lamp colour outright.
    const hasRgb = find('ColorAdd_R') ?? find('ColorAdd_G') ?? find('ColorAdd_B');
    if (hasRgb) {
      const white = read(find('ColorAdd_W'));
      color = {
        r: Math.min(1, read(find('ColorAdd_R')) + white),
        g: Math.min(1, read(find('ColorAdd_G')) + white),
        b: Math.min(1, read(find('ColorAdd_B')) + white),
      };
    }

    // --- pose and optics -------------------------------------------------
    // Anything this group does not control comes from the parent emitter, so
    // sub-pixels ride the head they are mounted in.
    return {
      instance,
      intensity: dimmer * shutter * (inherit?.intensity ?? 1),
      strobeHz: strobeHz || (inherit?.strobeHz ?? 0),
      pan: find('Pan') ? physical('Pan', 0) : (inherit?.pan ?? 0),
      tilt: find('Tilt') ? physical('Tilt', 0) : (inherit?.tilt ?? 0),
      beamAngle: find('Zoom')
        ? physical('Zoom', beam?.beamAngle ?? 25)
        : (inherit?.beamAngle ?? beam?.beamAngle ?? 25),
      fieldAngle: beam?.fieldAngle ?? beam?.beamAngle ?? 25,
      color,
      iris: find('Iris') ? physical('Iris', 1) : (inherit?.iris ?? 1),
      focus: find('Focus1') ? read(find('Focus1')) : (inherit?.focus ?? 0),
      frost: find('Frost1') ? read(find('Frost1')) : (inherit?.frost ?? 0),
      luminousFlux: beam?.luminousFlux ?? 0,
    };
  }
}

/** Evaluate a whole patch. */
export function evaluatePatch(
  fixtures: readonly PatchedFixture[],
  store: UniverseStore,
): FixtureState[] {
  return fixtures.map((f) => evaluateFixture(f, store));
}
