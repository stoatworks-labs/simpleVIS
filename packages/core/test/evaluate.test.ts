/**
 * DMX evaluation, driven through the real Demostage patch.
 *
 * These write values into universes exactly as a console would and assert on
 * the pose and colour that come out — the closest thing to "programme it and
 * look at it" that runs without a GPU.
 */

import { describe, expect, it } from 'vitest';
import { openMvr } from '../src/mvr/archive.js';
import { buildPatch, type PatchedFixture } from '../src/patch.js';
import { UniverseStore } from '../src/dmx/universe.js';
import { evaluateFixture, kelvinToRgb, physicalValue } from '../src/dmx/evaluate.js';
import { toAbsolute } from '../src/dmx/address.js';
import { demostageBytes, demostageSkipReason, hasDemostage } from './fixtures.js';

describe('universe store', () => {
  it('reads a 16-bit channel big-endian, coarse first', () => {
    const store = new UniverseStore();
    const slots = new Uint8Array(512);
    slots[0] = 0x80; // coarse
    slots[1] = 0x00; // fine
    store.set(1, slots);

    const value = store.readNormalised([
      { universe: 1, channel: 1 },
      { universe: 1, channel: 2 },
    ]);
    expect(value).toBeCloseTo(32768 / 65535, 9);
  });

  it('returns the fallback for a virtual channel', () => {
    expect(new UniverseStore().readNormalised([], 0.42)).toBe(0.42);
  });

  it('reads unseen universes as zero rather than throwing', () => {
    expect(new UniverseStore().read({ universe: 99, channel: 1 })).toBe(0);
  });
});

describe('physical interpolation', () => {
  const pan = [
    { name: 'Pan', attribute: 'Pan', dmxFrom: 0, dmxDefault: 0.5, physicalFrom: 270, physicalTo: -270 },
  ];

  it('interpolates a backwards range without mirroring it', () => {
    expect(physicalValue(pan, 0, 0)).toBeCloseTo(270, 6);
    expect(physicalValue(pan, 0.5, 0)).toBeCloseTo(0, 6);
    expect(physicalValue(pan, 1, 0)).toBeCloseTo(-270, 6);
  });

  it('re-normalises across the active function span', () => {
    // A function occupying the top half still sweeps its whole physical range.
    const fns = [
      { name: 'a', attribute: 'X', dmxFrom: 0, dmxDefault: 0, physicalFrom: 0, physicalTo: 0 },
      { name: 'b', attribute: 'X', dmxFrom: 0.5, dmxDefault: 0, physicalFrom: 10, physicalTo: 20 },
    ];
    expect(physicalValue(fns, 0.5, 0)).toBeCloseTo(10, 6);
    expect(physicalValue(fns, 0.75, 0)).toBeCloseTo(15, 6);
    expect(physicalValue(fns, 1, 0)).toBeCloseTo(20, 6);
  });
});

describe('colour temperature', () => {
  it('is warm below and cool above the neutral point', () => {
    const warm = kelvinToRgb(2850);
    const cool = kelvinToRgb(8000);
    expect(warm.r).toBeGreaterThan(warm.b);
    expect(cool.b).toBeGreaterThan(cool.r);
  });

  it('normalises to a peak of 1', () => {
    for (const k of [2000, 3200, 5600, 6500, 9000]) {
      const c = kelvinToRgb(k);
      expect(Math.max(c.r, c.g, c.b)).toBeCloseTo(1, 6);
    }
  });
});

describe.skipIf(!hasDemostage)(`evaluation — ${demostageSkipReason}`, () => {
  const setup = () => {
    const patch = buildPatch(openMvr(demostageBytes()));
    const store = new UniverseStore();
    return { patch, store };
  };

  /** Write a normalised value across a channel's addresses, coarse first. */
  const write = (store: UniverseStore, fixture: PatchedFixture, attribute: string, v: number) => {
    const channel = fixture.channels.find((c) => c.attribute === attribute);
    if (!channel || channel.addresses.length === 0) throw new Error(`no ${attribute}`);
    const full = 2 ** (8 * channel.addresses.length) - 1;
    let raw = Math.round(v * full);
    const bytes: number[] = [];
    for (let i = 0; i < channel.addresses.length; i++) {
      bytes.unshift(raw & 0xff);
      raw >>>= 8;
    }
    channel.addresses.forEach((address, i) => {
      const slots = store.get(address.universe);
      slots[address.channel - 1] = bytes[i];
      store.set(address.universe, slots);
    });
  };

  const macUltra = (patch: ReturnType<typeof buildPatch>) =>
    patch.fixtures.find((f) => f.fixture.name === 'MAC Ultra Performance 1')!;

  it('centres pan and tilt at half scale', () => {
    const { patch, store } = setup();
    const mac = macUltra(patch);
    write(store, mac, 'Pan', 0.5);
    write(store, mac, 'Tilt', 0.5);

    const [emitter] = evaluateFixture(mac, store).emitters;
    expect(emitter.pan).toBeCloseTo(0, 1);
    expect(emitter.tilt).toBeCloseTo(0, 1);
  });

  it('drives pan to its real -270..270 extremes in the right direction', () => {
    const { patch, store } = setup();
    const mac = macUltra(patch);

    write(store, mac, 'Pan', 0);
    expect(evaluateFixture(mac, store).emitters[0].pan).toBeCloseTo(270, 1);

    write(store, mac, 'Pan', 1);
    expect(evaluateFixture(mac, store).emitters[0].pan).toBeCloseTo(-270, 1);
  });

  it('narrows the cone as zoom rises', () => {
    const { patch, store } = setup();
    const mac = macUltra(patch);

    write(store, mac, 'Zoom', 0);
    const wide = evaluateFixture(mac, store).emitters[0].beamAngle;
    write(store, mac, 'Zoom', 1);
    const narrow = evaluateFixture(mac, store).emitters[0].beamAngle;

    expect(wide).toBeCloseTo(50.2, 1);
    expect(narrow).toBeCloseTo(6.6, 1);
    expect(narrow).toBeLessThan(wide);
  });

  it('subtracts CMY from the lamp colour', () => {
    const { patch, store } = setup();
    const mac = macUltra(patch);
    write(store, mac, 'Dimmer', 1);

    // Full cyan removes red.
    write(store, mac, 'ColorSub_C', 1);
    const cyan = evaluateFixture(mac, store).emitters[0].color;
    expect(cyan.r).toBeCloseTo(0, 5);
    expect(cyan.g).toBeGreaterThan(0.2);

    // Full magenta as well removes green, leaving blue.
    write(store, mac, 'ColorSub_M', 1);
    const blue = evaluateFixture(mac, store).emitters[0].color;
    expect(blue.g).toBeCloseTo(0, 5);
    expect(blue.b).toBeGreaterThan(0.2);
  });

  it('applies the dimmer to intensity', () => {
    const { patch, store } = setup();
    const mac = macUltra(patch);

    write(store, mac, 'Dimmer', 0);
    expect(evaluateFixture(mac, store).emitters[0].intensity).toBeCloseTo(0, 5);

    write(store, mac, 'Dimmer', 1);
    expect(evaluateFixture(mac, store).emitters[0].intensity).toBeCloseTo(1, 5);

    write(store, mac, 'Dimmer', 0.5);
    expect(evaluateFixture(mac, store).emitters[0].intensity).toBeCloseTo(0.5, 2);
  });

  it('lights one wall pixel without lighting its neighbours', () => {
    // The end-to-end proof that GeometryReference expansion addressed each
    // pixel separately: a single slot must move exactly one emitter.
    const { patch, store } = setup();
    const wall = patch.fixtures.find((f) => f.fixtureType.name === 'LED Wall 10x10')!;

    const red = wall.channels.filter((c) => c.attribute === 'ColorAdd_R');
    const target = red.find((c) => c.instance === 'GeometryReference 42')!;
    const address = target.addresses[0];
    const slots = store.get(address.universe);
    slots[address.channel - 1] = 255;
    store.set(address.universe, slots);

    const state = evaluateFixture(wall, store);
    expect(state.emitters).toHaveLength(100);

    const lit = state.emitters.filter((e) => e.color.r > 0.5);
    expect(lit).toHaveLength(1);
    expect(lit[0].instance).toBe('GeometryReference 42');
  });

  it('treats an uncontrollable dimmer as fully open', () => {
    // The wall's Dimmer is VIRTUAL — declared with an empty Offset, so it
    // occupies no DMX — and its GDTF default is 0. Honouring that default
    // would leave every wall in the show permanently black however the desk
    // drives the colour channels, because nothing can ever raise it.
    const { patch, store } = setup();
    const wall = patch.fixtures.find((f) => f.fixtureType.name === 'LED Wall 10x10')!;
    const dimmer = wall.channels.find((c) => c.attribute === 'Dimmer')!;
    expect(dimmer.addresses).toEqual([]);
    expect(dimmer.initialValue).toBe(0);

    for (const emitter of evaluateFixture(wall, store).emitters) {
      expect(emitter.intensity).toBe(1);
    }
  });

  it('gates independently-addressed sub-pixels through the master dimmer', () => {
    // The Prolights Sunrise2IP splits into a root group plus Pixel_left and
    // Pixel_right. Each pixel has its OWN addressable Dimmer (203, 204) behind
    // the fixture's master (199). Evaluating the groups independently would
    // leave the eye candy burning through a blackout.
    const { patch, store } = setup();
    const sunrise = patch.fixtures.find((f) => f.fixtureType.name === 'Sunrise2IP')!;
    expect(new Set(sunrise.channels.map((c) => c.instance))).toEqual(
      new Set(['', 'Pixel_left', 'Pixel_right']),
    );

    const writeInstance = (instance: string, v: number) => {
      const channel = sunrise.channels.find(
        (c) => c.attribute === 'Dimmer' && c.instance === instance,
      )!;
      const address = channel.addresses[0];
      const slots = store.get(address.universe);
      slots[address.channel - 1] = Math.round(v * 255);
      store.set(address.universe, slots);
    };

    // This fixture's shutter reads "Closed" at DMX 0 — a real behaviour, and
    // the reason a fixture with every slot at zero must render dark. Open it
    // before testing the dimmer chain.
    expect(evaluateFixture(sunrise, store).emitters[0].intensity).toBe(0);
    write(store, sunrise, 'Shutter1', 0.5);

    // Master up, left pixel up, right pixel down.
    writeInstance('', 1);
    writeInstance('Pixel_left', 1);
    writeInstance('Pixel_right', 0);

    const lit = evaluateFixture(sunrise, store).emitters;
    expect(lit.find((e) => e.instance === 'Pixel_left')!.intensity).toBeCloseTo(1, 2);
    expect(lit.find((e) => e.instance === 'Pixel_right')!.intensity).toBeCloseTo(0, 2);

    // Master down blacks everything out regardless of the pixel's own level.
    writeInstance('', 0);
    for (const emitter of evaluateFixture(sunrise, store).emitters) {
      expect(emitter.intensity).toBeCloseTo(0, 5);
    }
  });

  it('evaluates the whole 119-fixture show without throwing', () => {
    const { patch, store } = setup();
    let emitters = 0;
    for (const fixture of patch.fixtures) {
      emitters += evaluateFixture(fixture, store).emitters.length;
    }
    // 94 single-emitter fixtures, 16 walls x 100 pixels, and 9 Sunrise2IPs
    // that each carry a main beam plus two eye-candy pixels.
    expect(emitters).toBe(94 + 16 * 100 + 9 * 3);
  });

  it('addresses every patched channel inside a valid universe slot', () => {
    const { patch } = setup();
    for (const fixture of patch.fixtures) {
      for (const channel of fixture.channels) {
        for (const address of channel.addresses) {
          expect(toAbsolute(address)).toBeGreaterThan(0);
          expect(address.channel).toBeGreaterThanOrEqual(1);
          expect(address.channel).toBeLessThanOrEqual(512);
        }
      }
    }
  });
});
