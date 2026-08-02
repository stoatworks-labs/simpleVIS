/**
 * Loading the set geometry an MVR carries.
 *
 * MVR stores scene objects — truss, soft goods, speakers, the stage itself — as
 * `.glb` beside the scene description, so three.js's own GLTFLoader reads them
 * with no conversion. (GDTF *fixture* meshes are a different matter: those ship
 * as `.3ds` and are not loaded — see `fixtures.ts`.)
 *
 * Parsing happens from the bytes already in memory, never over the network:
 * the whole archive arrives as one file the user dropped in.
 */

import { LoadingManager, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MvrArchive } from '@simplevis/core';
import { Matrix4 } from 'three';

/** 1x1 transparent PNG, as a data URI. */
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAY27m/MAAAAASUVORK5CYII=';

/**
 * MVR-embedded GLBs frequently reference textures by **external filename**
 * (`vsBlkSatinTexture.png`) that the archive does not contain — Vectorworks
 * writes the material name through even when the image was never packed. Left
 * alone, three.js issues a request per reference against the app's own origin,
 * producing a burst of 404s and console errors on every import.
 *
 * Redirecting anything non-embedded to a blank pixel keeps the geometry and
 * drops the noise. The set reads as untextured, which it already was.
 */
const manager = new LoadingManager();
manager.setURLModifier((url) => (url.startsWith('data:') || url.startsWith('blob:') ? url : BLANK_PNG));

const loader = new GLTFLoader(manager);

/** Parse one GLB blob into a scene graph. */
function parseGlb(data: Uint8Array): Promise<Object3D> {
  // GLTFLoader wants an ArrayBuffer whose bounds match the model exactly; a
  // Uint8Array view into a larger buffer (which is what unzipping produces)
  // makes it read past the end and throw an opaque "Unexpected magic" error.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;

  return new Promise((resolve, reject) => {
    loader.parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

export interface LoadedSceneObjects {
  readonly root: Object3D;
  readonly loaded: number;
  readonly failed: readonly string[];
}

/**
 * Build the set from an opened MVR.
 *
 * Each model is parsed once and reused across every object that references it —
 * a truss export names the same `.glb` dozens of times, and parsing it per
 * instance turns a fast import into a slow one for no visual gain.
 */
export async function loadSceneObjects(archive: MvrArchive): Promise<LoadedSceneObjects> {
  const root = new Object3D();
  root.name = 'SceneObjects';
  const cache = new Map<string, Object3D | null>();
  const failed: string[] = [];
  let loaded = 0;

  for (const object of archive.scene.sceneObjects) {
    if (object.models.length === 0) continue;

    const node = new Object3D();
    node.name = object.name;
    node.matrixAutoUpdate = false;
    node.matrix.fromArray(Array.from(object.transform as Float64Array));

    for (const file of object.models) {
      if (!cache.has(file)) {
        const data = archive.assets.get(file);
        if (!data || !file.toLowerCase().endsWith('.glb')) {
          cache.set(file, null);
        } else {
          try {
            cache.set(file, await parseGlb(data));
          } catch (err) {
            cache.set(file, null);
            failed.push(`${file}: ${(err as Error).message}`);
          }
        }
      }
      const template = cache.get(file);
      if (template) {
        node.add(template.clone(true));
        loaded++;
      }
    }

    if (node.children.length > 0) root.add(node);
  }

  return { root, loaded, failed };
}

/** Convenience for turning a core `Mat4` into a three.js one. */
export function toMatrix4(m: Float64Array): Matrix4 {
  return new Matrix4().fromArray(Array.from(m));
}
