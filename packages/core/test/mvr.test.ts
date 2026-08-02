/**
 * MVR parsing, pinned against MA Lighting's Demostage.
 *
 * The numbers in here (119 fixtures, 28 universes, the specific addresses)
 * were read off the real file. If a change moves them, the change is wrong
 * until proven otherwise — fix the parser, not the expectation.
 */

import { describe, expect, it } from 'vitest';
import { loadXml } from '../src/xml.js';
import { parseMvrMatrix, parseGdtfMatrix, translationOf } from '../src/matrix.js';
import { fromAbsolute, parseMvrAddress, toAbsolute } from '../src/dmx/address.js';
import { openMvr } from '../src/mvr/archive.js';
import { buildPatch } from '../src/patch.js';
import { demostageBytes, demostageSkipReason, hasDemostage } from './fixtures.js';

describe('XML tolerance', () => {
  it('parses a document with the trailing NUL that MA writes', () => {
    // Every GeneralSceneDescription.xml and description.xml examined from MA's
    // own library ends with a NUL after the closing tag. A strict parser
    // rejects the entire document over that one byte.
    const withNul = '<Root a="1"><Child>text</Child></Root>\n\0';
    const root = loadXml(withNul);
    expect(root.name).toBe('Root');
    expect(root.attrs.a).toBe('1');
    expect(root.children[0]?.text).toBe('text');
  });

  it('keeps sibling order across differing tag names', () => {
    // GDTF geometry trees interleave Geometry / Axis / Beam siblings and the
    // order is meaningful, so a name-keyed parse is not good enough.
    const root = loadXml('<G><Geometry/><Beam/><Geometry/></G>');
    expect(root.children.map((c) => c.name)).toEqual(['Geometry', 'Beam', 'Geometry']);
  });

  it('does not coerce numeric-looking text', () => {
    const root = loadXml('<G Name="0123" Value="1.50"/>');
    expect(root.attrs.Name).toBe('0123');
    expect(root.attrs.Value).toBe('1.50');
  });
});

describe('matrix conventions', () => {
  it('reads an MVR matrix as {u}{v}{w}{origin} in millimetres', () => {
    const m = parseMvrMatrix(
      '{1.000000,0.000000,0.000000}{0.000000,1.000000,0.000000}' +
        '{0.000000,0.000000,1.000000}{-2980.000000,-6355.000000,9000.000000}',
    );
    // Translation converts mm -> m. This is the real placement of
    // "MAC Ultra Performance 1" in the Demostage.
    expect(translationOf(m)).toEqual([-2.98, -6.355, 9]);
  });

  it('reads a GDTF Position as four ROWS in metres', () => {
    // The MAC Ultra's Pigtail. Read as rows this is "156 mm in -Y, 50 mm in
    // -Z" — a cable gland under the base. Read as columns it would be a basis
    // vector with a homogeneous w of -0.156, which is meaningless.
    const m = parseGdtfMatrix(
      '{1.000000,0.000000,0.000000,0.000000}{0.000000,1.000000,0.000000,-0.156000}' +
        '{0.000000,0.000000,1.000000,-0.050000}{0,0,0,1}',
    );
    expect(translationOf(m)).toEqual([0, -0.156, -0.05]);
  });

  it('falls back to identity for an absent matrix', () => {
    expect(translationOf(parseMvrMatrix(''))).toEqual([0, 0, 0]);
  });
});

describe('DMX addressing', () => {
  it('splits an MVR absolute address into universe and channel', () => {
    // 3313 is the real address of "MAC Ultra Performance 1".
    expect(fromAbsolute(3313)).toEqual({ universe: 7, channel: 241 });
    expect(fromAbsolute(1)).toEqual({ universe: 1, channel: 1 });
    expect(fromAbsolute(512)).toEqual({ universe: 1, channel: 512 });
    expect(fromAbsolute(513)).toEqual({ universe: 2, channel: 1 });
    expect(fromAbsolute(58881)).toEqual({ universe: 116, channel: 1 });
  });

  it('round-trips', () => {
    for (const absolute of [1, 512, 513, 3313, 58881]) {
      expect(toAbsolute(fromAbsolute(absolute))).toBe(absolute);
    }
  });

  it('accepts the universe.channel form some writers emit', () => {
    expect(parseMvrAddress('7.241')).toEqual({ universe: 7, channel: 241 });
    expect(parseMvrAddress('3313')).toEqual({ universe: 7, channel: 241 });
  });
});

describe.skipIf(!hasDemostage)(`Demostage_MVR.mvr — ${demostageSkipReason}`, () => {
  const archive = () => openMvr(demostageBytes());

  it('opens the archive and finds every referenced GDTF', () => {
    const a = archive();
    expect(a.scene.version).toEqual({ major: 1, minor: 5 });
    expect(a.fixtureTypes.size).toBe(7);
    expect(a.warnings).toEqual([]);
  });

  it('reads all 119 fixtures', () => {
    const a = archive();
    expect(a.scene.fixtures).toHaveLength(119);

    const byType = new Map<string, number>();
    for (const f of a.scene.fixtures) {
      byType.set(f.gdtfSpec, (byType.get(f.gdtfSpec) ?? 0) + 1);
    }
    expect(Object.fromEntries(byType)).toEqual({
      'Martin Professional@MAC Ultra Performance': 30,
      'Martin Professional@MAC Aura XB': 22,
      'Robe Lighting@Robin SuperSpikie': 18,
      'Generic@LED Wall 10x10': 16,
      'Ayrton@MagicDot SX': 15,
      'Prolights@Sunrise2IP': 9,
      'Prolights@EclFresnel2KTW': 9,
    });
  });

  it('places the first fixture where the file says, in metres', () => {
    const a = archive();
    const mac = a.scene.fixtures.find((f) => f.name === 'MAC Ultra Performance 1');
    expect(mac).toBeDefined();
    expect(translationOf(mac!.transform)).toEqual([-2.98, -6.355, 9]);
    expect(mac!.fixtureId).toBe(101);
    expect(mac!.gdtfMode).toBe('Basic');
    expect(mac!.addresses).toEqual([{ universe: 7, channel: 241, break: 0 }]);
  });

  it('reads Color as CIE xyY rather than RGB', () => {
    const a = archive();
    const mac = a.scene.fixtures.find((f) => f.name === 'MAC Ultra Performance 1');
    // D65 white. As RGB this triple would be a near-black blue.
    expect(mac!.color!.x).toBeCloseTo(0.312712, 6);
    expect(mac!.color!.y).toBeCloseTo(0.329008, 6);
    expect(mac!.color!.Y).toBeCloseTo(100, 6);
  });

  it('resolves scene geometry through Symbol -> Symdef indirection', () => {
    const a = archive();
    // 54 SceneObjects, most reaching their mesh via a Symdef rather than a
    // direct Geometry3D. Resolving only the direct form loses most of the set.
    expect(a.scene.sceneObjects.length).toBeGreaterThan(0);
    const withModels = a.scene.sceneObjects.filter((o) => o.models.length > 0);
    expect(withModels.length).toBeGreaterThan(0);
    for (const o of withModels) {
      for (const model of o.models) {
        expect(a.assets.has(model)).toBe(true);
      }
    }
  });

  it('builds a patch spanning the expected 28 universes', () => {
    const patch = buildPatch(archive());
    expect(patch.fixtures).toHaveLength(119);
    expect(patch.universes).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16,
      101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
      111, 112, 113, 114, 115, 116,
    ]);
    expect(patch.warnings).toEqual([]);
  });
});
