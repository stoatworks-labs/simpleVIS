/**
 * Fixtures in the scene: bodies, articulation, and where the light comes out.
 *
 * The GDTF geometry tree becomes a three.js hierarchy one-for-one, so pan and
 * tilt are applied to the nodes GDTF *says* they act on — `Yoke` and `Head` for
 * a typical moving head — rather than to a hard-coded skeleton. That is what
 * makes an unfamiliar fixture articulate correctly without special-casing it.
 *
 * Fixture bodies are drawn as proxy boxes sized from the GDTF `Model`
 * dimensions, which are real published measurements. The actual meshes are
 * **not** loaded: these files ship `.3ds`, which needs a loader three.js only
 * provides in its examples bundle, and the beam is what this tool is for. The
 * set geometry from the MVR *is* loaded, because that is `.glb` and it is what
 * the beams land on.
 */

import {
  BoxGeometry,
  Color,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { buildPixelMap, type BeamData, type EmitterState, type PatchedFixture, type PixelUv } from '@simplevis/core';
import type { BeamInstance } from './beams.js';
import type { GlowInstance } from './glow.js';
import type { SampledColor } from './video.js';

/**
 * One material and one geometry for every fixture body in the show.
 *
 * Both are shared deliberately. Allocating a `BoxGeometry` per geometry node
 * and cloning a material per emitter produced ~2,800 meshes and 1,721 unique
 * materials for the Demostage, which is thousands of draw calls and shader
 * binds per frame — it rendered at under 1 fps before the beams drew anything.
 * A shared unit cube scaled per node costs one geometry and one material.
 */
const BODY_MATERIAL = new MeshStandardMaterial({
  color: new Color(0x1a1a1e),
  roughness: 0.85,
  metalness: 0.1,
});

const UNIT_CUBE = new BoxGeometry(1, 1, 1);

interface EmitterNode {
  readonly instance: string;
  /** Node whose world transform is the beam apex and axis. */
  readonly node: Object3D;
  readonly beam: BeamData | undefined;
  /** Node to rotate for pan, if this fixture pans. */
  readonly panNode?: Object3D;
  readonly tiltNode?: Object3D;
  /**
   * Where this emitter sits on its fixture's pixel surface, when the fixture
   * *is* a surface. `undefined` for anything with a single emitter, which is
   * what keeps a moving head from taking a video feed's colour.
   */
  readonly uv?: PixelUv;
}

export interface FixtureNode {
  readonly root: Object3D;
  readonly emitters: readonly EmitterNode[];
  readonly patched: PatchedFixture;
}

function matrixFrom(m: Float64Array): Matrix4 {
  return new Matrix4().fromArray(Array.from(m));
}

/**
 * Build the three.js hierarchy for one patched fixture.
 *
 * Returns nodes keyed so `applyState` can drive them without searching.
 */
export function buildFixture(patched: PatchedFixture): FixtureNode {
  const root = new Object3D();
  root.matrixAutoUpdate = false;
  root.matrix.copy(matrixFrom(patched.fixture.transform as Float64Array));
  root.name = patched.fixture.name;

  const byName = new Map<string, Object3D>();

  // Mirror the GDTF geometry tree. Nodes carry their Position as a fixed
  // matrix; pan and tilt are applied on top as a quaternion, so the file's own
  // transform is never overwritten.
  const build = (
    geometries: readonly PatchedFixture['fixtureType']['geometries'][number][],
    parent: Object3D,
  ): void => {
    for (const g of geometries) {
      const node = new Object3D();
      node.name = g.name;
      node.matrixAutoUpdate = true;
      // Decompose so pan/tilt can compose with the file's transform.
      const m = matrixFrom(g.position as Float64Array);
      m.decompose(node.position, node.quaternion, node.scale);
      node.userData.restQuaternion = node.quaternion.clone();
      parent.add(node);
      if (!byName.has(g.name)) byName.set(g.name, node);

      const model = patched.fixtureType.models.find((mm) => mm.name === g.model);
      if (model && g.kind !== 'Beam' && model.length > 0) {
        const body = new Mesh(UNIT_CUBE, BODY_MATERIAL);
        body.scale.set(model.length, model.width, model.height);
        node.add(body);
      }

      build(g.children, node);
    }
  };
  build(patched.fixtureType.geometries, root);

  // Locate the beam for each emitter instance.
  const emitters: EmitterNode[] = [];
  const beamGeometry = (() => {
    let found: BeamData | undefined;
    const walk = (list: readonly PatchedFixture['fixtureType']['geometries'][number][]) => {
      for (const g of list) {
        if (!found && g.kind === 'Beam') found = g.beam;
        walk(g.children);
      }
    };
    walk(patched.fixtureType.geometries);
    return found;
  })();

  // Computed once per fixture, not once per emitter: a wall has a hundred
  // emitters and the map is derived from all of them together.
  const pixels = buildPixelMap(patched);

  for (const instance of patched.instances) {
    const channels = patched.channels.filter((c) => c.instance === instance.name);
    const panName = channels.find((c) => c.attribute === 'Pan')?.geometry;
    const tiltName = channels.find((c) => c.attribute === 'Tilt')?.geometry;

    let node: Object3D;
    if (instance.name === '') {
      // Single-emitter fixture: the beam node already exists in the tree.
      node =
        [...byName.entries()].find(([, n]) => n.name === 'Beam')?.[1] ??
        byName.get(instance.geometry) ??
        root;
    } else {
      // A GeometryReference instance — one node per pixel, at the reference's
      // own transform. Without this every pixel of a wall sits at the origin
      // and the whole wall renders as one bright dot.
      node = new Object3D();
      node.name = instance.name;
      const m = matrixFrom(instance.transform as Float64Array);
      m.decompose(node.position, node.quaternion, node.scale);
      root.add(node);
    }

    emitters.push({
      instance: instance.name,
      node,
      beam: beamGeometry,
      panNode: panName ? byName.get(panName) : undefined,
      tiltNode: tiltName ? byName.get(tiltName) : undefined,
      uv: pixels?.get(instance.name),
    });
  }

  return { root, emitters, patched };
}

const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _axisZ = new Vector3(0, 0, 1);
const _axisX = new Vector3(1, 0, 0);
const _dir = new Vector3();

/**
 * Drive a fixture from its evaluated state and append its beams to `out`.
 *
 * GDTF's convention is that pan turns the geometry about its own **Z** and tilt
 * about its own **X**, and that light leaves a beam geometry along its
 * **-Z**. All three are properties of the file, not assumptions about what a
 * moving light looks like.
 */
export function applyState(
  fixture: FixtureNode,
  emitterStates: readonly EmitterState[],
  out: BeamInstance[],
  glows: GlowInstance[],
  options: {
    range: number;
    minIntensity: number;
    minFlux: number;
    glowSize: number;
    /**
     * Colour for a pixel-mapped emitter, or `null` when no video is playing.
     * The returned object is reused between calls, so read it before the next.
     */
    sampleVideo?: (uv: PixelUv) => SampledColor | null;
  },
): void {
  // Index once. A 100-pixel LED wall has 100 emitters and 100 states, so a
  // linear search per emitter is 10,000 comparisons per wall per frame — and
  // the Demostage has sixteen walls.
  const stateByInstance = new Map<string, EmitterState>();
  for (const s of emitterStates) stateByInstance.set(s.instance, s);

  for (const emitter of fixture.emitters) {
    const state = stateByInstance.get(emitter.instance);
    if (!state) continue;

    if (emitter.panNode) {
      const rest = emitter.panNode.userData.restQuaternion as Quaternion;
      emitter.panNode.quaternion
        .copy(rest)
        .multiply(_quat.setFromAxisAngle(_axisZ, (state.pan * Math.PI) / 180));
    }
    if (emitter.tiltNode) {
      const rest = emitter.tiltNode.userData.restQuaternion as Quaternion;
      emitter.tiltNode.quaternion
        .copy(rest)
        .multiply(_quat.setFromAxisAngle(_axisX, (state.tilt * Math.PI) / 180));
    }
  }

  fixture.root.updateMatrixWorld(true);

  for (const emitter of fixture.emitters) {
    const state = stateByInstance.get(emitter.instance);
    if (!state) continue;

    const intensity = state.intensity;
    if (intensity <= options.minIntensity) continue;

    // Not every emitter earns a volumetric cone.
    //
    // The Demostage evaluates to 1,721 emitters, but 1,600 of those are LED
    // wall pixels rated at **100 lumens** each. A raymarched cone per pixel is
    // enormous overdraw for something that scatters no visible light in haze —
    // measured at 1 fps with them in and 60 with them out. They still glow,
    // via the emissive lens set above, which is what a wall pixel actually
    // looks like.
    emitter.node.matrixWorld.decompose(_pos, _quat, _scale);

    // Video *replaces* the emitted colour but never the intensity.
    //
    // Replaces, because a wall fed by a media server should show the media
    // server's picture, not that picture tinted by whatever the desk happens
    // to have in the wall's RGB channels. Never the intensity, because the
    // fixture's own dimmer is what a blackout acts through — the same rule
    // sub-emitters already follow, and without it the walls would burn through
    // a blackout with the rest of the rig dark.
    const video = emitter.uv && options.sampleVideo ? options.sampleVideo(emitter.uv) : null;
    const colour = video ?? state.color;

    const flux = emitter.beam?.luminousFlux ?? 0;
    if (flux > 0 && flux < options.minFlux) {
      glows.push({
        position: _pos.clone(),
        color: {
          r: colour.r * intensity,
          g: colour.g * intensity,
          b: colour.b * intensity,
        },
        size: options.glowSize,
      });
      continue;
    }

    // GDTF emits along -Z of the beam geometry.
    _dir.set(0, 0, -1).applyQuaternion(_quat).normalize();

    // Scale by rated output so a 46,500 lm profile reads brighter than a
    // 2,000 lm wash, but compressed — a linear ratio would make everything
    // beside the biggest fixture invisible.
    const gain = flux > 0 ? Math.min(1.8, Math.max(0.4, Math.sqrt(flux / 12000))) : 1;

    out.push({
      origin: _pos.clone(),
      direction: _dir.clone(),
      color: {
        r: colour.r * intensity * gain,
        g: colour.g * intensity * gain,
        b: colour.b * intensity * gain,
      },
      beamAngle: state.beamAngle,
      fieldAngle: Math.max(state.beamAngle, state.fieldAngle),
      range: options.range,
      apertureRadius: emitter.beam?.beamRadius ?? 0.05,
    });
  }
}
