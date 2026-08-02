/**
 * Reading the `.mvr` container.
 *
 * An MVR is a zip holding `GeneralSceneDescription.xml`, the `.gdtf` files for
 * every fixture type used (themselves zips), and the mesh files for the set.
 * Unzipping happens with fflate so this works identically in a browser tab and
 * under Tauri — no Node `zlib`, no filesystem.
 *
 * The `GDTFSpec` in the scene is the GDTF's filename **without** the extension
 * (`Martin Professional@MAC Ultra Performance`), so the lookup here strips it.
 * Matching is also case-insensitive: consoles and CAD tools disagree about the
 * casing of manufacturer names, and a miss shows up as a fixture that imports
 * with a position but no beam, which is easy to misread as a render bug.
 */

import { unzipSync } from 'fflate';
import { parseSceneDescription } from './parse.js';
import { parseGdtfDescription } from '../gdtf/parse.js';
import type { GdtfFixtureType } from '../gdtf/types.js';
import type { MvrScene } from './types.js';

export interface MvrArchive {
  readonly scene: MvrScene;
  /** Parsed fixture types, keyed by lower-cased `GDTFSpec`. */
  readonly fixtureTypes: ReadonlyMap<string, GdtfFixtureType>;
  /** Raw bytes of every non-XML, non-GDTF entry — meshes, textures. */
  readonly assets: ReadonlyMap<string, Uint8Array>;
  /** Raw `.gdtf` bytes, kept so fixture meshes can be pulled out on demand. */
  readonly gdtfArchives: ReadonlyMap<string, Uint8Array>;
  /** Non-fatal problems: a missing GDTF, a fixture type that failed to parse. */
  readonly warnings: readonly string[];
}

const GDTF_SUFFIX = '.gdtf';

/** Strip any directory prefix; MVR entries are conventionally flat. */
function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Open an `.mvr` and parse everything a visualiser needs from it. */
export function openMvr(bytes: Uint8Array): MvrArchive {
  const entries = unzipSync(bytes);
  const warnings: string[] = [];

  let sceneXml: Uint8Array | undefined;
  const gdtfArchives = new Map<string, Uint8Array>();
  const assets = new Map<string, Uint8Array>();

  for (const [rawName, data] of Object.entries(entries)) {
    if (data.length === 0) continue; // directory entry
    const name = basename(rawName);
    const lower = name.toLowerCase();

    if (lower === 'generalscenedescription.xml') {
      sceneXml = data;
    } else if (lower.endsWith(GDTF_SUFFIX)) {
      gdtfArchives.set(name.slice(0, -GDTF_SUFFIX.length).toLowerCase(), data);
    } else {
      assets.set(name, data);
    }
  }

  if (!sceneXml) throw new Error('MVR contains no GeneralSceneDescription.xml');
  const scene = parseSceneDescription(sceneXml);

  // Parse only the fixture types the scene actually patches. A library MVR can
  // carry types nothing references, and parsing a 1.8 MB description.xml that
  // nothing draws is pure cost.
  const wanted = new Set(
    scene.fixtures.map((f) => f.gdtfSpec.trim().toLowerCase()).filter((s) => s.length > 0),
  );

  const fixtureTypes = new Map<string, GdtfFixtureType>();
  for (const spec of wanted) {
    const archive = gdtfArchives.get(spec);
    if (!archive) {
      warnings.push(`GDTF not found in archive for fixture type "${spec}"`);
      continue;
    }
    try {
      fixtureTypes.set(spec, parseGdtfArchive(archive));
    } catch (err) {
      warnings.push(`failed to parse GDTF "${spec}": ${(err as Error).message}`);
    }
  }

  return { scene, fixtureTypes, assets, gdtfArchives, warnings };
}

/** Parse a standalone `.gdtf` (a zip whose root holds `description.xml`). */
export function parseGdtfArchive(bytes: Uint8Array): GdtfFixtureType {
  const entries = unzipSync(bytes, {
    filter: (file) => basename(file.name).toLowerCase() === 'description.xml',
  });
  for (const [name, data] of Object.entries(entries)) {
    if (basename(name).toLowerCase() === 'description.xml') {
      return parseGdtfDescription(data);
    }
  }
  throw new Error('GDTF archive contains no description.xml');
}

/**
 * Pull a model file out of a `.gdtf`.
 *
 * GDTF stores meshes under `models/<format>/<Model.File><ext>`, and the format
 * present varies by manufacturer — the Martin fixtures in MA's Demostage ship
 * **`.3ds` only**, with no glTF at all, so a loader that assumes `.glb` finds
 * nothing and silently draws no fixture body. Formats are tried in order of
 * how cheap they are to load.
 */
export function extractGdtfModel(
  gdtfBytes: Uint8Array,
  modelFile: string,
): { format: 'glb' | 'gltf' | '3ds' | 'obj' | 'svg'; data: Uint8Array } | undefined {
  if (!modelFile) return undefined;
  const target = modelFile.toLowerCase();
  const order = ['glb', 'gltf', '3ds', 'obj', 'svg'] as const;

  const entries = unzipSync(gdtfBytes, {
    filter: (file) => {
      const base = basename(file.name).toLowerCase();
      const dot = base.lastIndexOf('.');
      return dot > 0 && base.slice(0, dot) === target;
    },
  });

  for (const format of order) {
    for (const [name, data] of Object.entries(entries)) {
      if (basename(name).toLowerCase().endsWith(`.${format}`)) return { format, data };
    }
  }
  return undefined;
}
