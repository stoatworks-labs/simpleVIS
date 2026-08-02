/**
 * Emitters that glow but do not light the air.
 *
 * An LED wall pixel is rated at 100 lumens. Giving each one a raymarched
 * volumetric cone is absurd — and giving each one its own `Mesh` with its own
 * cloned material is worse: the Demostage has 1,721 emitters, and 1,721 unique
 * materials means 1,721 draw calls and 1,721 shader-program bindings per frame.
 * That measured at under 1 fps with the beam pass contributing nothing at all.
 *
 * So every low-flux emitter in the show is one instance of a single quad, in a
 * single `InstancedMesh`, with per-instance colour. One draw call for the lot.
 */

import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';

/** A point of light with no visible beam. */
export interface GlowInstance {
  readonly position: Vector3;
  readonly color: { r: number; g: number; b: number };
  /** Screen-facing radius, metres. */
  readonly size: number;
}

export class GlowSystem {
  readonly mesh: InstancedMesh;
  private capacity: number;
  private readonly matrix = new Matrix4();
  private readonly colour = new Color();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();

  constructor(initialCapacity = 2048) {
    this.capacity = initialCapacity;
    const geometry = new PlaneGeometry(1, 1);
    const material = new MeshBasicMaterial({
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new InstancedMesh(geometry, material, this.capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /**
   * Rebuild the glow set.
   *
   * `cameraQuaternion` billboards every quad toward the viewer, so a wall of
   * pixels reads as points of light from any angle rather than disappearing
   * when seen edge-on.
   */
  update(glows: readonly GlowInstance[], cameraQuaternion: Quaternion): void {
    if (glows.length > this.capacity) this.grow(glows.length);

    this.quaternion.copy(cameraQuaternion);
    for (let i = 0; i < glows.length; i++) {
      const g = glows[i];
      this.scale.set(g.size, g.size, g.size);
      this.matrix.compose(g.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      this.colour.setRGB(g.color.r, g.color.g, g.color.b);
      this.mesh.setColorAt(i, this.colour);
    }

    this.mesh.count = glows.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private grow(needed: number): void {
    let capacity = this.capacity;
    while (capacity < needed) capacity *= 2;

    const geometry = this.mesh.geometry;
    const material = this.mesh.material;
    this.mesh.dispose();

    const replacement = new InstancedMesh(geometry, material, capacity);
    replacement.instanceMatrix.setUsage(DynamicDrawUsage);
    replacement.frustumCulled = false;
    replacement.count = 0;

    // Swap the internals in place so the caller's scene reference stays valid.
    (this.mesh as { instanceMatrix: InstancedMesh['instanceMatrix'] }).instanceMatrix =
      replacement.instanceMatrix;
    (this.mesh as { instanceColor: InstancedMesh['instanceColor'] }).instanceColor =
      replacement.instanceColor;
    (this.mesh as { count: number }).count = 0;
    this.capacity = capacity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
