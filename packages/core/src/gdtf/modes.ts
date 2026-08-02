/**
 * Resolve a GDTF DMX mode into a flat list of channels at concrete offsets.
 *
 * This is the step most easily got wrong, because a mode's channel list is a
 * **template**, not the footprint. When the geometry a channel drives is
 * instantiated more than once through `GeometryReference`, that channel exists
 * once per instance, at an offset taken from the instance's `<Break>`.
 *
 * The Generic LED Wall 10x10 in MA's Demostage is the case in point: its
 * `Default` mode declares **4** channels (a virtual Dimmer plus RGB), the body
 * holds **100** `GeometryReference`s at `DMXOffset` 1, 4, 7 …, and the fixture
 * therefore occupies **300** DMX channels. Reading the mode literally gives a
 * 3-channel fixture and a wall where only the first pixel ever lights.
 *
 * Rebasing rule, confirmed against that file:
 *
 *     absoluteOffset = break.dmxOffset + (templateOffset - 1)
 *
 * so reference 2 (`DMXOffset=4`) puts R/G/B — template offsets 1,2,3 — at
 * 4,5,6.
 */

import type {
  GdtfChannelFunction,
  GdtfDmxMode,
  GdtfFixtureType,
  GdtfGeometry,
} from './types.js';
import type { Mat4 } from '../matrix.js';
import { identity, multiply } from '../matrix.js';
import { walkGeometries } from './parse.js';

/** A channel placed at a concrete offset within the fixture's footprint. */
export interface ResolvedChannel {
  /** Attribute this channel drives, e.g. `Pan`, `Dimmer`, `ColorAdd_R`. */
  readonly attribute: string;
  /** Geometry name the attribute acts on — `Yoke` for Pan, `Head` for Tilt. */
  readonly geometry: string;
  /**
   * Which instance of that geometry. `''` for a fixture with no
   * `GeometryReference`; otherwise the reference node's name, e.g.
   * `GeometryReference 7`.
   */
  readonly instance: string;
  /**
   * 1-based offsets within the fixture footprint, coarse first.
   * Empty means virtual — no DMX, holds `initialValue`.
   */
  readonly offsets: readonly number[];
  readonly dmxBreak: number;
  readonly initialValue: number;
  readonly functions: readonly GdtfChannelFunction[];
}

/** One instantiation of a geometry subtree. */
export interface GeometryInstance {
  /** `''` for the fixture's own geometry, else the reference node's name. */
  readonly name: string;
  /** Geometry that was instantiated. */
  readonly geometry: string;
  /** Transform of this instance relative to the fixture root, metres. */
  readonly transform: Mat4;
  /** DMX offset base from the instance's `<Break>`; 1 for the direct instance. */
  readonly offsetBase: number;
}

export interface ResolvedMode {
  readonly name: string;
  readonly rootGeometry: string;
  readonly channels: readonly ResolvedChannel[];
  readonly instances: readonly GeometryInstance[];
  /** Highest offset used — the fixture's DMX footprint, in channels. */
  readonly footprint: number;
}

/** Names of every geometry in a subtree, including the root itself. */
function subtreeNames(root: GdtfGeometry): Set<string> {
  const names = new Set<string>([root.name]);
  walkGeometries(root.children, (g) => names.add(g.name));
  return names;
}

function findByName(
  roots: readonly GdtfGeometry[],
  name: string,
): { node: GdtfGeometry; transform: Mat4 } | undefined {
  let hit: { node: GdtfGeometry; transform: Mat4 } | undefined;
  const recurse = (nodes: readonly GdtfGeometry[], parent: Mat4) => {
    for (const g of nodes) {
      const world = multiply(parent, g.position);
      if (!hit && g.name === name) hit = { node: g, transform: world };
      recurse(g.children, world);
    }
  };
  recurse(roots, identity());
  return hit;
}

/**
 * Collect every `GeometryReference` reachable from `root`, with its transform
 * relative to the fixture root.
 */
function collectReferences(
  roots: readonly GdtfGeometry[],
  rootName: string,
): { node: GdtfGeometry; transform: Mat4 }[] {
  const start = findByName(roots, rootName);
  const out: { node: GdtfGeometry; transform: Mat4 }[] = [];
  const search = start ? [start] : roots.map((g) => ({ node: g, transform: g.position }));

  const recurse = (node: GdtfGeometry, parent: Mat4) => {
    for (const g of node.children) {
      const world = multiply(parent, g.position);
      if (g.kind === 'GeometryReference') out.push({ node: g, transform: world });
      recurse(g, world);
    }
  };
  for (const s of search) {
    if (s.node.kind === 'GeometryReference') out.push(s);
    recurse(s.node, s.transform);
  }
  return out;
}

/**
 * Expand a mode into concrete channels.
 *
 * `modeName` is matched case-insensitively — MVR files reference modes by the
 * exact string the console wrote, and casing drifts between tools (the
 * Demostage patches a Prolights fixture as `STANDARD` where other exports of
 * the same fixture say `Standard`).
 */
export function resolveMode(
  fixtureType: GdtfFixtureType,
  modeName: string,
): ResolvedMode | undefined {
  const wanted = modeName.trim().toLowerCase();
  const mode: GdtfDmxMode | undefined =
    fixtureType.modes.find((m) => m.name.trim().toLowerCase() === wanted) ??
    fixtureType.modes[0];
  if (!mode) return undefined;

  const references = collectReferences(fixtureType.geometries, mode.geometry);

  // Which geometries are reachable only through a reference, and via which.
  const expansions = new Map<string, { node: GdtfGeometry; transform: Mat4 }[]>();
  for (const ref of references) {
    const targetName = ref.node.referencedGeometry ?? '';
    const target = findByName(fixtureType.geometries, targetName);
    if (!target) continue;
    for (const name of subtreeNames(target.node)) {
      const list = expansions.get(name) ?? [];
      list.push(ref);
      expansions.set(name, list);
    }
  }

  const channels: ResolvedChannel[] = [];
  const instances: GeometryInstance[] = [];
  const seenInstances = new Set<string>();
  let footprint = 0;

  const emit = (
    template: (typeof mode.channels)[number],
    instance: string,
    offsetBase: number,
  ) => {
    // A virtual channel keeps its empty offset list at every instance.
    const offsets = template.offsets.map((o) => offsetBase + (o - 1));
    for (const o of offsets) footprint = Math.max(footprint, o);

    for (const logical of template.logicalChannels) {
      channels.push({
        attribute: logical.attribute,
        geometry: template.geometry,
        instance,
        offsets,
        dmxBreak: template.dmxBreak,
        initialValue: template.initialValue,
        functions: logical.functions,
      });
    }
  };

  for (const template of mode.channels) {
    const refs = expansions.get(template.geometry);
    if (!refs || refs.length === 0) {
      emit(template, '', 1);
      continue;
    }
    for (const ref of refs) {
      const breakEntry =
        ref.node.breaks?.find((b) => b.dmxBreak === template.dmxBreak) ??
        ref.node.breaks?.[0];
      const base = breakEntry?.dmxOffset ?? 1;
      const instanceName = ref.node.name;
      emit(template, instanceName, base);

      if (!seenInstances.has(instanceName)) {
        seenInstances.add(instanceName);
        instances.push({
          name: instanceName,
          geometry: ref.node.referencedGeometry ?? '',
          transform: ref.transform,
          offsetBase: base,
        });
      }
    }
  }

  if (instances.length === 0) {
    instances.push({
      name: '',
      geometry: mode.geometry,
      transform: identity(),
      offsetBase: 1,
    });
  }

  return {
    name: mode.name,
    rootGeometry: mode.geometry,
    channels,
    instances,
    footprint,
  };
}
