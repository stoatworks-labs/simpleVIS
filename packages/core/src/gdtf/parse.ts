/**
 * `description.xml` inside a `.gdtf` -> `GdtfFixtureType`.
 *
 * Structural notes taken from real manufacturer files (Martin MAC Ultra
 * Performance, MAC Aura XB, Robe Robin SuperSpikie, Ayrton MagicDot SX,
 * Prolights, Generic LED Wall), not from the spec alone:
 *
 *  - `DMXFrom` and `Default` are written `value/bytes`, where `value` is at the
 *    **channel's own resolution**: `16384/2` on a 180 -> -180 range is 90 deg,
 *    i.e. one quarter of 65535. Normalising by `2^(8*bytes) - 1` is correct;
 *    treating the number as 8-bit is not.
 *  - `PhysicalFrom` / `PhysicalTo` are sometimes the literal string `"None"`.
 *    `parseFloat` yields NaN, which then poisons every downstream angle.
 *  - Channel `Offset` may be empty (a virtual channel) or list several offsets
 *    (`"2,3"` = 16-bit coarse/fine).
 *  - Channels are **not** in offset order in the file. The MAC Ultra writes
 *    blades 33,34,35,36 before 29,30,31,32. Never infer position from order.
 */

import {
  attr,
  attrNum,
  child,
  childrenNamed,
  descendants,
  loadXml,
  path,
  type XmlNode,
} from '../xml.js';
import { identity, parseGdtfMatrix } from '../matrix.js';
import type {
  BeamData,
  GdtfChannelFunction,
  GdtfDmxChannel,
  GdtfDmxMode,
  GdtfFixtureType,
  GdtfGeometry,
  GdtfLogicalChannel,
  GdtfModel,
  GeometryBreak,
  GeometryKind,
} from './types.js';

const GEOMETRY_KINDS = new Set<string>([
  'Geometry', 'Axis', 'Beam', 'GeometryReference', 'FilterBeam', 'FilterColor',
  'FilterGobo', 'FilterShaper', 'MediaServerLayer', 'MediaServerCamera',
  'MediaServerMaster', 'Display', 'Laser', 'WiringObject', 'Inventory',
  'Structure', 'Support', 'Magnet',
]);

/**
 * Parse a `value/bytes` pair into a 0..1 fraction of full scale.
 *
 * Returns `fallback` for absent, empty or `"None"` values. The byte count is
 * load-bearing: `601/2` is 601/65535, not 601/255.
 */
function parseDmxValue(raw: string | undefined, fallback: number): number {
  if (!raw || raw === 'None') return fallback;
  const [valuePart, bytesPart] = raw.split('/');
  const value = Number.parseFloat(valuePart);
  if (!Number.isFinite(value)) return fallback;
  const bytes = Number.parseInt(bytesPart ?? '1', 10);
  const full = 2 ** (8 * (Number.isFinite(bytes) && bytes > 0 ? bytes : 1)) - 1;
  return value / full;
}

/** Physical values may be the literal string `"None"`. */
function parsePhysical(raw: string | undefined, fallback: number): number {
  if (!raw || raw === 'None') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseModels(ft: XmlNode): GdtfModel[] {
  const container = child(ft, 'Models');
  if (!container) return [];
  return childrenNamed(container, 'Model').map((m) => ({
    name: attr(m, 'Name'),
    file: attr(m, 'File'),
    primitiveType: attr(m, 'PrimitiveType') || 'Undefined',
    length: attrNum(m, 'Length', 0),
    width: attrNum(m, 'Width', 0),
    height: attrNum(m, 'Height', 0),
  }));
}

function parseBeam(node: XmlNode): BeamData {
  return {
    beamAngle: attrNum(node, 'BeamAngle', 25),
    fieldAngle: attrNum(node, 'FieldAngle', attrNum(node, 'BeamAngle', 25)),
    luminousFlux: attrNum(node, 'LuminousFlux', 0),
    colorTemperature: attrNum(node, 'ColorTemperature', 6500),
    beamRadius: attrNum(node, 'BeamRadius', 0.05),
    beamType: (attr(node, 'BeamType') || 'Wash') as BeamData['beamType'],
    lampType: attr(node, 'LampType'),
    powerConsumption: attrNum(node, 'PowerConsumption', 0),
  };
}

function parseBreaks(node: XmlNode): GeometryBreak[] {
  return childrenNamed(node, 'Break').map((b) => ({
    dmxOffset: attrNum(b, 'DMXOffset', 1),
    // "Overwrite" means "use the referenced geometry's own break"; we
    // normalise that to break 1, which is what every real file so far means.
    dmxBreak: attrNum(b, 'DMXBreak', 1),
  }));
}

function parseGeometry(node: XmlNode): GdtfGeometry {
  const kind = node.name as GeometryKind;
  const children = node.children
    .filter((c) => GEOMETRY_KINDS.has(c.name))
    .map(parseGeometry);

  const positionRaw = attr(node, 'Position');
  const base: GdtfGeometry = {
    kind,
    name: attr(node, 'Name'),
    model: attr(node, 'Model'),
    position: positionRaw ? parseGdtfMatrix(positionRaw) : identity(),
    children,
  };

  if (kind === 'Beam') return { ...base, beam: parseBeam(node) };
  if (kind === 'GeometryReference') {
    return {
      ...base,
      referencedGeometry: attr(node, 'Geometry'),
      breaks: parseBreaks(node),
    };
  }
  return base;
}

/**
 * Index `<Relations>` by the channel they modify, so a ChannelFunction can be
 * told which master channel gates it.
 *
 * A `Mode` relation names a `Master` (a ChannelFunction) and a `Follower` (a
 * ChannelFunction), meaning the follower is only live while the master's
 * channel sits inside the master function's DMX span. This is the only thing
 * distinguishing the MAC Ultra's four different `Gobo1Pos` functions, all of
 * which start at DMX 0.
 */
interface ModeRelation {
  readonly masterChannel: string;
  readonly from: number;
  readonly to: number;
}

function parseModeRelations(mode: XmlNode): Map<string, ModeRelation> {
  const byFollower = new Map<string, ModeRelation>();
  const container = child(mode, 'Relations');
  if (!container) return byFollower;

  for (const rel of childrenNamed(container, 'Relation')) {
    if (attr(rel, 'Type') !== 'Mode') continue;
    const follower = attr(rel, 'Follower');
    const master = attr(rel, 'Master');
    if (!follower || !master) continue;
    // Master is a node path like "Gobo1.Gobo1.Gobo 1 Wheel"; the first segment
    // is the DMXChannel's owning geometry-qualified channel name.
    byFollower.set(follower, {
      masterChannel: master.split('.')[0] ?? master,
      from: 0,
      to: 1,
    });
  }
  return byFollower;
}

function parseChannelFunctions(
  logical: XmlNode,
  relations: Map<string, ModeRelation>,
  channelName: string,
): GdtfChannelFunction[] {
  return childrenNamed(logical, 'ChannelFunction').map((cf) => {
    const name = attr(cf, 'Name');
    const rel = relations.get(`${channelName}.${attr(logical, 'Attribute')}.${name}`);
    const fn: GdtfChannelFunction = {
      name,
      attribute: attr(cf, 'Attribute') || attr(logical, 'Attribute'),
      dmxFrom: parseDmxValue(attr(cf, 'DMXFrom'), 0),
      dmxDefault: parseDmxValue(attr(cf, 'Default'), 0),
      physicalFrom: parsePhysical(attr(cf, 'PhysicalFrom'), 0),
      physicalTo: parsePhysical(attr(cf, 'PhysicalTo'), 1),
    };
    if (!rel) return fn;
    return { ...fn, modeMaster: { channel: rel.masterChannel, from: rel.from, to: rel.to } };
  });
}

/**
 * Parse `Offset="2,3"` into `[2, 3]`.
 *
 * An empty or absent value yields `[]`, which the rest of the pipeline reads
 * as "virtual channel, consumes no DMX".
 */
function parseOffsets(raw: string): number[] {
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseMode(mode: XmlNode): GdtfDmxMode {
  const relations = parseModeRelations(mode);
  const container = child(mode, 'DMXChannels');
  const channels: GdtfDmxChannel[] = [];

  for (const ch of container ? childrenNamed(container, 'DMXChannel') : []) {
    const geometry = attr(ch, 'Geometry');
    const logicalChannels: GdtfLogicalChannel[] = childrenNamed(ch, 'LogicalChannel').map(
      (lc) => {
        const attribute = attr(lc, 'Attribute');
        return {
          attribute,
          functions: parseChannelFunctions(lc, relations, `${geometry}_${attribute}`),
        };
      },
    );

    // A channel's initial value is the default of its first function; the
    // DMXChannel's own `Default` attribute was dropped after GDTF 1.0 but is
    // still written by some tools, so prefer it when present.
    const firstDefault = logicalChannels[0]?.functions[0]?.dmxDefault ?? 0;

    channels.push({
      offsets: parseOffsets(attr(ch, 'Offset')),
      geometry,
      dmxBreak: attrNum(ch, 'DMXBreak', 1),
      logicalChannels,
      initialValue: parseDmxValue(attr(ch, 'Default'), firstDefault),
    });
  }

  return {
    name: attr(mode, 'Name'),
    geometry: attr(mode, 'Geometry'),
    channels,
  };
}

/** Parse a GDTF `description.xml`. Accepts raw bytes or text. */
export function parseGdtfDescription(source: string | Uint8Array): GdtfFixtureType {
  const root = loadXml(source);
  const ft = child(root, 'FixtureType');
  if (!ft) throw new Error('GDTF description has no <FixtureType>');

  const geometriesNode = child(ft, 'Geometries');
  const geometries = geometriesNode
    ? geometriesNode.children.filter((c) => GEOMETRY_KINDS.has(c.name)).map(parseGeometry)
    : [];

  const modesNode = path(ft, 'DMXModes');
  const modes = modesNode ? childrenNamed(modesNode, 'DMXMode').map(parseMode) : [];

  return {
    name: attr(ft, 'Name'),
    shortName: attr(ft, 'ShortName'),
    manufacturer: attr(ft, 'Manufacturer'),
    models: parseModels(ft),
    geometries,
    modes,
  };
}

/* --------------------------------------------------------- tree utilities */

/** Depth-first walk of a geometry forest. */
export function walkGeometries(
  roots: readonly GdtfGeometry[],
  visit: (g: GdtfGeometry, ancestors: readonly GdtfGeometry[]) => void,
): void {
  const recurse = (nodes: readonly GdtfGeometry[], ancestors: GdtfGeometry[]) => {
    for (const g of nodes) {
      visit(g, ancestors);
      recurse(g.children, [...ancestors, g]);
    }
  };
  recurse(roots, []);
}

/** Find a geometry by name anywhere in the forest. */
export function findGeometry(
  roots: readonly GdtfGeometry[],
  name: string,
): GdtfGeometry | undefined {
  let found: GdtfGeometry | undefined;
  walkGeometries(roots, (g) => {
    if (!found && g.name === name) found = g;
  });
  return found;
}

/** Every `Beam` geometry in the forest, with its accumulated ancestors. */
export function findBeams(
  roots: readonly GdtfGeometry[],
): { geometry: GdtfGeometry; ancestors: readonly GdtfGeometry[] }[] {
  const out: { geometry: GdtfGeometry; ancestors: readonly GdtfGeometry[] }[] = [];
  walkGeometries(roots, (g, ancestors) => {
    if (g.kind === 'Beam') out.push({ geometry: g, ancestors });
  });
  return out;
}

/** Raw `<Relation>` nodes, exposed for diagnostics. */
export function rawRelations(source: string | Uint8Array): XmlNode[] {
  return descendants(loadXml(source), 'Relation');
}
