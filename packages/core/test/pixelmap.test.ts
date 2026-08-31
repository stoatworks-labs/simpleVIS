/**
 * Turning a wall's `GeometryReference` instances back into a raster.
 *
 * Pinned against the Generic LED Wall 10x10 in MA's Demostage: 100 instances,
 * 300 DMX channels, 100 distinct positions. If a change moves these numbers,
 * the change is wrong until proven otherwise.
 */

import { describe, expect, it } from 'vitest';
import { openMvr } from '../src/mvr/archive.js';
import { buildPatch } from '../src/patch.js';
import { buildPixelMap } from '../src/pixelmap.js';
import { demostageBytes, demostageSkipReason, hasDemostage } from './fixtures.js';

describe.skipIf(!hasDemostage)(`pixel map (${demostageSkipReason})`, () => {
  const patch = () => buildPatch(openMvr(demostageBytes()));

  it('maps every pixel of an LED wall onto a full 10x10 grid', () => {
    const wall = patch().fixtures.find((f) => f.fixtureType.name.includes('LED Wall'));
    expect(wall).toBeDefined();

    const map = buildPixelMap(wall!);
    expect(map).not.toBeNull();
    expect(map!.size).toBe(100);

    // Ten distinct columns and ten distinct rows, not a hundred points in a
    // line and not a hundred points on top of each other. Rounded because the
    // positions come out of the file as floats.
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const us = new Set([...map!.values()].map((p) => round(p.u)));
    const vs = new Set([...map!.values()].map((p) => round(p.v)));
    expect(us.size).toBe(10);
    expect(vs.size).toBe(10);

    // The grid fills the frame edge to edge rather than sitting in a corner.
    expect(Math.min(...us)).toBeCloseTo(0, 5);
    expect(Math.max(...us)).toBeCloseTo(1, 5);
    expect(Math.min(...vs)).toBeCloseTo(0, 5);
    expect(Math.max(...vs)).toBeCloseTo(1, 5);
  });

  it('stays inside the unit square for every pixel-mapped fixture', () => {
    for (const fixture of patch().fixtures) {
      const map = buildPixelMap(fixture);
      if (!map) continue;
      for (const { u, v } of map.values()) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses to map a fixture that is not a surface', () => {
    // A moving head has one emitter. Handing it a UV would make it take the
    // video feed's colour the moment one was playing, which is the single
    // worst way this feature could fail.
    const heads = patch().fixtures.filter((f) => f.instances.length < 2);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) expect(buildPixelMap(head)).toBeNull();
  });

  it('puts the top of the picture at the top of the wall, as hung', () => {
    // The bug this pins: the Demostage's LED Wall is authored flat in its own
    // XY plane and stood up by a placement whose local +Y maps to world -Z, so
    // the pixel with the largest *local* Y is the wall's bottom. Deriving
    // "down the picture" in local space played every wall upside down.
    //
    // Asserted against world space, which is the only place "up" means
    // anything: the highest pixel in the room must be the picture's first row.
    const wall = patch().fixtures.find((f) => f.fixtureType.name.includes('LED Wall'))!;
    const map = buildPixelMap(wall)!;
    const m = wall.fixture.transform;
    const worldZ = (t: typeof m) => m[2] * t[12] + m[6] * t[13] + m[10] * t[14] + m[14];

    let highest = wall.instances[0];
    let lowest = wall.instances[0];
    for (const i of wall.instances) {
      if (worldZ(i.transform) > worldZ(highest.transform)) highest = i;
      if (worldZ(i.transform) < worldZ(lowest.transform)) lowest = i;
    }
    // The wall is hung, so there is a real height difference to reason about.
    expect(worldZ(highest.transform) - worldZ(lowest.transform)).toBeGreaterThan(0.5);
    expect(map.get(highest.name)!.v).toBeCloseTo(0, 5);
    expect(map.get(lowest.name)!.v).toBeCloseTo(1, 5);
  });

  it('agrees with the DMX footprint about how many pixels there are', () => {
    // 4 template channels x 100 references = 300 channels. The map must have
    // one entry per reference, or video and DMX would disagree about which
    // pixel is which.
    const wall = patch().fixtures.find((f) => f.fixtureType.name.includes('LED Wall'))!;
    expect(wall.footprint).toBe(300);
    expect(buildPixelMap(wall)!.size).toBe(wall.instances.length);
  });
});
