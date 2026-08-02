/**
 * GDTF parsing and DMX mode resolution, pinned against the real manufacturer
 * files inside MA's Demostage.
 *
 * The two fixtures exercised here were chosen because they fail differently:
 *
 *  - **Martin MAC Ultra Performance** — a 48-channel moving head. Catches
 *    inverted physical ranges, 16-bit pairing, out-of-order offsets, and the
 *    per-channel `Geometry` that says Pan turns the yoke and Tilt turns the head.
 *  - **Generic LED Wall 10x10** — 4 template channels expanded across 100
 *    `GeometryReference`s into a 300-channel footprint, plus a virtual channel
 *    with an empty `Offset`. Nothing about this fixture works if the mode is
 *    read literally.
 */

import { describe, expect, it } from 'vitest';
import { openMvr } from '../src/mvr/archive.js';
import { resolveMode } from '../src/gdtf/modes.js';
import { findBeams, findGeometry } from '../src/gdtf/parse.js';
import { buildPatch } from '../src/patch.js';
import { translationOf } from '../src/matrix.js';
import { demostageBytes, demostageSkipReason, hasDemostage } from './fixtures.js';

describe.skipIf(!hasDemostage)(`GDTF — ${demostageSkipReason}`, () => {
  const archive = () => openMvr(demostageBytes());
  const macSpec = 'martin professional@mac ultra performance';
  const wallSpec = 'generic@led wall 10x10';

  describe('Martin MAC Ultra Performance', () => {
    it('parses identity and geometry tree', () => {
      const ft = archive().fixtureTypes.get(macSpec)!;
      expect(ft.manufacturer).toBe('Martin Professional');
      expect(ft.name).toBe('MAC Ultra Performance');

      // Base -> Yoke -> Head -> Beam is what makes a moving head articulate.
      const base = ft.geometries.find((g) => g.name === 'Base')!;
      const yoke = base.children.find((g) => g.name === 'Yoke')!;
      const head = yoke.children.find((g) => g.name === 'Head')!;
      const beam = head.children.find((g) => g.kind === 'Beam')!;
      expect([base.kind, yoke.kind, head.kind]).toEqual(['Geometry', 'Geometry', 'Geometry']);
      expect(translationOf(yoke.position)).toEqual([0, 0, -0.13]);
      expect(translationOf(head.position)).toEqual([0, 0, -0.347]);
      expect(beam.name).toBe('Beam');
    });

    it('reads the beam data the renderer sizes its cone from', () => {
      const ft = archive().fixtureTypes.get(macSpec)!;
      const [{ geometry }] = findBeams(ft.geometries);
      expect(geometry.beam).toEqual({
        beamAngle: 24.6,
        fieldAngle: 27.299999,
        luminousFlux: 46500,
        colorTemperature: 5800,
        beamRadius: 0.08,
        beamType: 'Spot',
        lampType: 'LED',
        powerConsumption: 1150,
      });
    });

    it('ships .3ds models, not glTF', () => {
      // Worth pinning: a loader that assumes .glb finds nothing here and
      // silently draws no fixture body.
      const ft = archive().fixtureTypes.get(macSpec)!;
      const head = ft.models.find((m) => m.name === 'Head')!;
      expect(head.file).toContain('head');
      expect(head.primitiveType).toBe('Undefined');
      expect(head.height).toBeCloseTo(0.659093, 6);
    });

    it('maps Pan to the Yoke and Tilt to the Head', () => {
      // The channel's Geometry attribute is the only thing that says which
      // node in the tree an attribute rotates.
      const ft = archive().fixtureTypes.get(macSpec)!;
      const mode = resolveMode(ft, 'Basic')!;
      const pan = mode.channels.find((c) => c.attribute === 'Pan')!;
      const tilt = mode.channels.find((c) => c.attribute === 'Tilt')!;
      expect(pan.geometry).toBe('Yoke');
      expect(tilt.geometry).toBe('Head');
      expect(findGeometry(ft.geometries, 'Yoke')).toBeDefined();
    });

    it('keeps inverted physical ranges intact', () => {
      const ft = archive().fixtureTypes.get(macSpec)!;
      const mode = resolveMode(ft, 'Basic')!;

      const pan = mode.channels.find((c) => c.attribute === 'Pan')!.functions[0];
      // 270 -> -270: a 540 deg range that DECREASES with DMX. Sorting these
      // or taking an absolute range mirrors every fixture's movement.
      expect(pan.physicalFrom).toBe(270);
      expect(pan.physicalTo).toBe(-270);

      const tilt = mode.channels.find((c) => c.attribute === 'Tilt')!.functions[0];
      expect(tilt.physicalFrom).toBe(134);
      expect(tilt.physicalTo).toBe(-134);

      const zoom = mode.channels.find((c) => c.attribute === 'Zoom')!.functions[0];
      // Zoom is the live beam angle in degrees, overriding the static 24.6.
      expect(zoom.physicalFrom).toBe(50.2);
      expect(zoom.physicalTo).toBe(6.6);
    });

    it('normalises DMXFrom at the channel resolution, not 8-bit', () => {
      const ft = archive().fixtureTypes.get(macSpec)!;
      const mode = resolveMode(ft, 'Basic')!;
      const pan = mode.channels.find((c) => c.attribute === 'Pan')!;

      // Pan is 16-bit, so its default of "32768/2" is dead centre => 0 deg.
      expect(pan.offsets).toEqual([38, 39]);
      expect(pan.functions[0].dmxDefault).toBeCloseTo(32768 / 65535, 9);

      const centre = pan.functions[0];
      const physicalAtDefault =
        centre.physicalFrom +
        centre.dmxDefault * (centre.physicalTo - centre.physicalFrom);
      expect(physicalAtDefault).toBeCloseTo(0, 2);
    });

    it('pairs 16-bit channels and tolerates out-of-order offsets', () => {
      const ft = archive().fixtureTypes.get(macSpec)!;
      const mode = resolveMode(ft, 'Basic')!;

      const dimmer = mode.channels.find((c) => c.attribute === 'Dimmer')!;
      expect(dimmer.offsets).toEqual([2, 3]);

      // The file writes blades 33,34,35,36 BEFORE 29,30,31,32. Position must
      // come from Offset, never from document order.
      const blade3 = mode.channels.find((c) => c.attribute === 'Blade3A')!;
      const blade1 = mode.channels.find((c) => c.attribute === 'Blade1A')!;
      expect(blade1.offsets).toEqual([33]);
      expect(blade3.offsets).toEqual([29]);
      expect(mode.footprint).toBe(48);
    });

    it('exposes subtractive CMY rather than assuming RGB', () => {
      const ft = archive().fixtureTypes.get(macSpec)!;
      const mode = resolveMode(ft, 'Basic')!;
      const attrs = mode.channels.map((c) => c.attribute);
      expect(attrs).toContain('ColorSub_C');
      expect(attrs).toContain('ColorSub_M');
      expect(attrs).toContain('ColorSub_Y');
      expect(attrs).not.toContain('ColorAdd_R');

      // CTO is a colour temperature in kelvin, not a 0..1 amount.
      const cto = mode.channels.find((c) => c.attribute === 'CTO')!.functions[0];
      expect(cto.physicalFrom).toBe(5800);
      expect(cto.physicalTo).toBe(2850);
    });
  });

  describe('Generic LED Wall 10x10 — GeometryReference expansion', () => {
    it('expands 4 template channels into a 300-channel footprint', () => {
      const ft = archive().fixtureTypes.get(wallSpec)!;
      const mode = ft.modes.find((m) => m.name === 'Default')!;

      // As written in the file: four channels.
      expect(mode.channels).toHaveLength(4);

      // As actually patched: 100 pixels x RGB.
      const resolved = resolveMode(ft, 'Default')!;
      expect(resolved.instances).toHaveLength(100);
      expect(resolved.footprint).toBe(300);
    });

    it('rebases each instance onto its own Break offset', () => {
      const ft = archive().fixtureTypes.get(wallSpec)!;
      const resolved = resolveMode(ft, 'Default')!;

      const red = resolved.channels.filter((c) => c.attribute === 'ColorAdd_R');
      expect(red).toHaveLength(100);

      // absoluteOffset = break.dmxOffset + (templateOffset - 1)
      // Reference 1 is at DMXOffset 1, reference 2 at 4, reference 3 at 7.
      const byInstance = new Map(red.map((c) => [c.instance, c.offsets]));
      expect(byInstance.get('GeometryReference 1')).toEqual([1]);
      expect(byInstance.get('GeometryReference 2')).toEqual([4]);
      expect(byInstance.get('GeometryReference 3')).toEqual([7]);
      expect(byInstance.get('GeometryReference 100')).toEqual([298]);

      const blue = resolved.channels.filter((c) => c.attribute === 'ColorAdd_B');
      const blueByInstance = new Map(blue.map((c) => [c.instance, c.offsets]));
      expect(blueByInstance.get('GeometryReference 1')).toEqual([3]);
      expect(blueByInstance.get('GeometryReference 100')).toEqual([300]);
    });

    it('treats an empty Offset as a virtual channel consuming no DMX', () => {
      const ft = archive().fixtureTypes.get(wallSpec)!;
      const resolved = resolveMode(ft, 'Default')!;
      const dimmers = resolved.channels.filter((c) => c.attribute === 'Dimmer');

      // Present at every instance, but occupying nothing. Treating the empty
      // Offset as 0 would shift every following channel by one.
      expect(dimmers).toHaveLength(100);
      for (const d of dimmers) expect(d.offsets).toEqual([]);
    });

    it('gives each pixel instance a distinct position', () => {
      const ft = archive().fixtureTypes.get(wallSpec)!;
      const resolved = resolveMode(ft, 'Default')!;
      const points = resolved.instances.map((i) => translationOf(i.transform).join(','));
      // 100 pixels at 100 distinct places; coincident pixels would render as
      // one bright dot instead of a wall.
      expect(new Set(points).size).toBe(100);
    });
  });

  describe('patch integration', () => {
    it('addresses an LED wall across the universes its footprint spans', () => {
      const patch = buildPatch(archive());
      const wall = patch.fixtures.find(
        (f) => f.fixtureType.name === 'LED Wall 10x10',
      )!;
      expect(wall.footprint).toBe(300);

      const red = wall.channels.filter((c) => c.attribute === 'ColorAdd_R');
      expect(red).toHaveLength(100);

      // Every address must be a real slot in a real universe.
      for (const channel of wall.channels) {
        for (const address of channel.addresses) {
          expect(address.channel).toBeGreaterThanOrEqual(1);
          expect(address.channel).toBeLessThanOrEqual(512);
          expect(address.universe).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it('resolves every fixture without falling back on a mode', () => {
      const patch = buildPatch(archive());
      expect(patch.warnings).toEqual([]);
      for (const f of patch.fixtures) {
        expect(f.channels.length).toBeGreaterThan(0);
        expect(f.mode.name.toLowerCase()).toBe(f.fixture.gdtfMode.toLowerCase());
      }
    });
  });
});
