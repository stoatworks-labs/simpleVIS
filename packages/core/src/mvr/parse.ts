/**
 * `GeneralSceneDescription.xml` -> `MvrScene`.
 *
 * Shape notes from MA Lighting's `Demostage_MVR.mvr` (MVR 1.5, 119 fixtures
 * across 28 universes), which is the file this parser is pinned against:
 *
 *  - Fixtures and scene objects live in `Scene/Layers/Layer/ChildList`, and
 *    may be nested inside `GroupObject`s, so the walk has to recurse rather
 *    than read one level.
 *  - A `SceneObject`'s geometry is either a direct `Geometry3D` with a
 *    `fileName`, or a `Symbol` pointing at a `Symdef` in `Scene/AUXData` that
 *    holds the `Geometry3D`. Both appear in the same file; resolving only the
 *    direct form loses most of the set.
 *  - `<Matrix>` is optional. An absent one means "at the origin", and 15 of
 *    the 173 placeable objects in the Demostage rely on that.
 */

import {
  attr,
  child,
  childrenNamed,
  childText,
  loadXml,
  type XmlNode,
} from '../xml.js';
import { identity, parseMvrMatrix } from '../matrix.js';
import { parseMvrAddress } from '../dmx/address.js';
import type { CieXyY, MvrFixture, MvrLayer, MvrScene, MvrSceneObject } from './types.js';

/** Parse `<Color>x,y,Y</Color>` — CIE xyY, not RGB. */
function parseColor(raw: string): CieXyY | undefined {
  if (!raw.trim()) return undefined;
  const parts = raw.split(',').map((s) => Number.parseFloat(s.trim()));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return { x: parts[0], y: parts[1], Y: parts[2] };
}

function parseTransform(node: XmlNode) {
  const raw = childText(node, 'Matrix');
  return raw ? parseMvrMatrix(raw) : identity();
}

function parseFixture(node: XmlNode, layer: string): MvrFixture {
  const addressesNode = child(node, 'Addresses');
  const addresses = (addressesNode ? childrenNamed(addressesNode, 'Address') : []).map(
    (a) => ({
      ...parseMvrAddress(a.text),
      break: Number.parseInt(attr(a, 'break') || '0', 10) || 0,
    }),
  );

  return {
    uuid: attr(node, 'uuid'),
    name: attr(node, 'name'),
    gdtfSpec: childText(node, 'GDTFSpec'),
    gdtfMode: childText(node, 'GDTFMode'),
    transform: parseTransform(node),
    addresses,
    fixtureId: Number.parseInt(childText(node, 'FixtureID') || '0', 10) || 0,
    unitNumber: Number.parseInt(childText(node, 'UnitNumber') || '0', 10) || 0,
    customId: Number.parseInt(childText(node, 'CustomId') || '0', 10) || 0,
    color: parseColor(childText(node, 'Color')),
    castShadow: childText(node, 'CastShadow').toLowerCase() === 'true',
    layer,
  };
}

/**
 * Model filenames referenced by a `<Geometries>` block, following `Symbol`
 * indirection through the symdef table.
 */
function collectModels(node: XmlNode, symdefs: Map<string, string[]>): string[] {
  const geometries = child(node, 'Geometries');
  if (!geometries) return [];
  const out: string[] = [];

  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === 'Geometry3D') {
        const file = attr(c, 'fileName');
        if (file) out.push(file);
      } else if (c.name === 'Symbol') {
        const files = symdefs.get(attr(c, 'symdef'));
        if (files) out.push(...files);
      }
      walk(c);
    }
  };
  walk(geometries);
  return out;
}

/** Build uuid -> model filenames from `Scene/AUXData/Symdef`. */
function buildSymdefTable(scene: XmlNode): Map<string, string[]> {
  const table = new Map<string, string[]>();
  const aux = child(scene, 'AUXData');
  if (!aux) return table;

  for (const symdef of childrenNamed(aux, 'Symdef')) {
    const files: string[] = [];
    const walk = (n: XmlNode) => {
      for (const c of n.children) {
        if (c.name === 'Geometry3D') {
          const file = attr(c, 'fileName');
          if (file) files.push(file);
        }
        walk(c);
      }
    };
    walk(symdef);
    table.set(attr(symdef, 'uuid'), files);
  }
  return table;
}

/** Parse a `GeneralSceneDescription.xml`. Accepts raw bytes or text. */
export function parseSceneDescription(source: string | Uint8Array): MvrScene {
  const root = loadXml(source);
  const scene = child(root, 'Scene');
  if (!scene) throw new Error('MVR has no <Scene>');

  const symdefs = buildSymdefTable(scene);
  const layers: MvrLayer[] = [];
  const fixtures: MvrFixture[] = [];
  const sceneObjects: MvrSceneObject[] = [];

  const layersNode = child(scene, 'Layers');
  for (const layerNode of layersNode ? childrenNamed(layersNode, 'Layer') : []) {
    const layerUuid = attr(layerNode, 'uuid');
    layers.push({ uuid: layerUuid, name: attr(layerNode, 'name') });

    // Fixtures and objects may sit at any depth inside nested GroupObjects.
    const walk = (n: XmlNode) => {
      for (const c of n.children) {
        if (c.name === 'Fixture') {
          fixtures.push(parseFixture(c, layerUuid));
        } else if (c.name === 'SceneObject') {
          sceneObjects.push({
            uuid: attr(c, 'uuid'),
            name: attr(c, 'name'),
            transform: parseTransform(c),
            models: collectModels(c, symdefs),
            layer: layerUuid,
          });
        }
        walk(c);
      }
    };
    walk(layerNode);
  }

  return {
    version: {
      major: Number.parseInt(attr(root, 'verMajor') || '1', 10),
      minor: Number.parseInt(attr(root, 'verMinor') || '0', 10),
    },
    layers,
    fixtures,
    sceneObjects,
  };
}
