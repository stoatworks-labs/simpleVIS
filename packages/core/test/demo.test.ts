/**
 * The built-in demo source.
 *
 * This is what the hosted build shows and what the project video films, so it
 * has to actually move the rig — a demo that silently writes nothing looks
 * exactly like a renderer that draws nothing.
 */

import { describe, expect, it } from 'vitest';
import { openMvr } from '../src/mvr/archive.js';
import { buildPatch } from '../src/patch.js';
import { UniverseStore } from '../src/dmx/universe.js';
import { DemoSource } from '../src/dmx/demo.js';
import { evaluateFixture, evaluatePatch } from '../src/dmx/evaluate.js';
import { demostageBytes, demostageSkipReason, hasDemostage } from './fixtures.js';

describe.skipIf(!hasDemostage)(`demo source — ${demostageSkipReason}`, () => {
  const setup = () => {
    const patch = buildPatch(openMvr(demostageBytes()));
    return { patch, store: new UniverseStore(), demo: new DemoSource(patch.fixtures) };
  };

  it('writes to every universe in the patch', () => {
    const { patch, store, demo } = setup();
    demo.tick(store, 1.0);
    expect(store.universes()).toEqual(patch.universes);
  });

  it('opens shutters rather than guessing a value', () => {
    // Writing 255 to a shutter lands in the strobe band on plenty of real
    // fixtures — the Sunrise2IP's top range is a pulse effect. The demo picks
    // the fixture's own "open" function instead.
    //
    // Asserted across several instants because the demo deliberately dips the
    // dimmer through zero: a single instant would be testing the phase of the
    // sine wave, not the shutter.
    const { patch, store, demo } = setup();
    const sunrise = patch.fixtures.find((f) => f.fixtureType.name === 'Sunrise2IP')!;

    let everLit = false;
    for (const t of [0.2, 1.0, 2.0, 3.0, 4.0, 5.0]) {
      demo.tick(store, t);
      const [emitter] = evaluateFixture(sunrise, store).emitters;
      // Never strobing: that would be the "just write 255" mistake.
      expect(emitter.strobeHz).toBe(0);
      if (emitter.intensity > 0.05) everLit = true;
    }
    expect(everLit).toBe(true);
  });

  it('moves the rig over time', () => {
    const { patch, store, demo } = setup();
    const mac = patch.fixtures.find((f) => f.fixture.name === 'MAC Ultra Performance 1')!;

    demo.tick(store, 0);
    const first = evaluateFixture(mac, store).emitters[0];
    demo.tick(store, 3);
    const later = evaluateFixture(mac, store).emitters[0];

    expect(later.pan).not.toBeCloseTo(first.pan, 3);
    expect(later.tilt).not.toBeCloseTo(first.tilt, 3);
  });

  it('lights something on every fixture in the show', () => {
    const { patch, store, demo } = setup();
    // Sample a few phases: the demo dips fixtures through zero, so a single
    // instant legitimately has some of them dark.
    const everLit = new Set<string>();
    for (const t of [0.4, 1.6, 2.8, 4.2, 5.5, 7.1]) {
      demo.tick(store, t);
      for (const state of evaluatePatch(patch.fixtures, store)) {
        if (state.emitters.some((e) => e.intensity > 0.05)) everLit.add(state.uuid);
      }
    }
    expect(everLit.size).toBe(patch.fixtures.length);
  });

  it('ripples a pixel wall rather than driving every pixel together', () => {
    const { patch, store, demo } = setup();
    demo.tick(store, 2.0);
    const wall = patch.fixtures.find((f) => f.fixtureType.name === 'LED Wall 10x10')!;
    const colours = evaluateFixture(wall, store).emitters.map(
      (e) => `${e.color.r.toFixed(2)},${e.color.g.toFixed(2)},${e.color.b.toFixed(2)}`,
    );
    // A wall showing one flat colour would mean the per-instance phase was
    // being ignored — which is also how a broken GeometryReference expansion
    // would look.
    expect(new Set(colours).size).toBeGreaterThan(10);
  });

  it('leaves virtual channels alone', () => {
    // A virtual channel has no address; writing to it must be a no-op rather
    // than an out-of-range slot write.
    const { patch, store, demo } = setup();
    expect(() => demo.tick(store, 1.0)).not.toThrow();

    const wall = patch.fixtures.find((f) => f.fixtureType.name === 'LED Wall 10x10')!;
    const dimmer = wall.channels.find((c) => c.attribute === 'Dimmer')!;
    expect(dimmer.addresses).toEqual([]);
  });
});
