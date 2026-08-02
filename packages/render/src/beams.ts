/**
 * The volumetric beam system.
 *
 * One instanced cone mesh carries every beam in the show. Per-frame the
 * evaluator hands us emitter states; we write them into the instance
 * attributes and upload. No allocation on the hot path, one draw call.
 *
 * Capacity grows by doubling and is never shrunk — the Demostage evaluates to
 * 1,721 emitters, and an LED wall's pixels churn the count as walls come and go.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  ConeGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from 'three';
import { beamFragmentShader, beamVertexShader } from './beams.glsl.js';

/** One beam, in world space, ready to draw. */
export interface BeamInstance {
  readonly origin: Vector3;
  /** Unit emission direction. */
  readonly direction: Vector3;
  /** Linear RGB already multiplied by intensity. */
  readonly color: { r: number; g: number; b: number };
  /** Full cone angle at 50% intensity, degrees. */
  readonly beamAngle: number;
  /** Full cone angle at 10% intensity, degrees. */
  readonly fieldAngle: number;
  /** How far the beam is drawn, metres. */
  readonly range: number;
  /** Emitting aperture radius, metres. */
  readonly apertureRadius: number;
}

export interface BeamSystemOptions {
  /** Scattering density. 0 gives clean air and effectively no visible beam. */
  haze?: number;
  exposure?: number;
  /** Raymarch steps. Capped at 64 by the shader's loop bound. */
  steps?: number;
}

export class BeamSystem {
  readonly mesh: Mesh;
  private geometry: InstancedBufferGeometry;
  private material: ShaderMaterial;
  private capacity = 0;

  private origins!: Float32Array;
  private dirs!: Float32Array;
  private colors!: Float32Array;
  private shapes!: Float32Array;

  constructor(options: BeamSystemOptions = {}) {
    this.material = new ShaderMaterial({
      vertexShader: beamVertexShader,
      fragmentShader: beamFragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      // Beams must not occlude each other or the scene, and the camera has to
      // be able to sit inside one. Occlusion is handled per-sample against the
      // depth texture instead.
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCameraPos: { value: new Vector3() },
        uResolution: { value: new Vector2(1, 1) },
        uSceneDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 500 },
        uHaze: { value: options.haze ?? 0.35 },
        uExposure: { value: options.exposure ?? 1 },
        uSteps: { value: Math.min(64, options.steps ?? 32) },
        uProjectionInverse: { value: new Matrix4() },
        uCameraWorld: { value: new Matrix4() },
        uViewForward: { value: new Vector3(0, 0, -1) },
      },
    });

    this.geometry = new InstancedBufferGeometry();
    const template = new ConeGeometry(1, 1, 24, 1, true);
    // ConeGeometry is Y-up with its apex at +0.5. The shader wants a template
    // whose apex is the origin and whose axis is +Z in [0,1].
    template.rotateX(Math.PI / 2);
    template.translate(0, 0, 0.5);
    template.scale(1, 1, 1);

    const pos = template.getAttribute('position') as BufferAttribute;
    this.geometry.setAttribute('position', pos);
    if (template.index) this.geometry.setIndex(template.index);

    this.grow(256);

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // instances move every frame
    this.mesh.renderOrder = 10;
  }

  private grow(needed: number): void {
    if (needed <= this.capacity) return;
    let capacity = Math.max(256, this.capacity);
    while (capacity < needed) capacity *= 2;

    this.origins = new Float32Array(capacity * 3);
    this.dirs = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.shapes = new Float32Array(capacity * 4);

    this.geometry.setAttribute(
      'iOrigin',
      new InstancedBufferAttribute(this.origins, 3).setUsage(35048 /* DynamicDrawUsage */),
    );
    this.geometry.setAttribute(
      'iDir',
      new InstancedBufferAttribute(this.dirs, 3).setUsage(35048),
    );
    this.geometry.setAttribute(
      'iColor',
      new InstancedBufferAttribute(this.colors, 3).setUsage(35048),
    );
    this.geometry.setAttribute(
      'iShape',
      new InstancedBufferAttribute(this.shapes, 4).setUsage(35048),
    );
    this.capacity = capacity;
  }

  /** Replace the beam set for this frame. */
  update(beams: readonly BeamInstance[]): void {
    this.grow(beams.length);

    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      this.origins[i * 3] = b.origin.x;
      this.origins[i * 3 + 1] = b.origin.y;
      this.origins[i * 3 + 2] = b.origin.z;

      this.dirs[i * 3] = b.direction.x;
      this.dirs[i * 3 + 1] = b.direction.y;
      this.dirs[i * 3 + 2] = b.direction.z;

      this.colors[i * 3] = b.color.r;
      this.colors[i * 3 + 1] = b.color.g;
      this.colors[i * 3 + 2] = b.color.b;

      // Half-angles, as cosines, because the shader compares against a dot
      // product. GDTF quotes the FULL cone angle.
      const halfBeam = (Math.max(0.5, b.beamAngle) * Math.PI) / 360;
      const halfField = (Math.max(b.beamAngle, b.fieldAngle) * Math.PI) / 360;
      this.shapes[i * 4] = Math.cos(halfBeam);
      this.shapes[i * 4 + 1] = Math.cos(halfField);
      this.shapes[i * 4 + 2] = b.range;
      this.shapes[i * 4 + 3] = b.apertureRadius;
    }

    for (const name of ['iOrigin', 'iDir', 'iColor', 'iShape']) {
      const attribute = this.geometry.getAttribute(name) as InstancedBufferAttribute;
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = beams.length;
  }

  /** Per-frame uniforms from the camera and the opaque pass. */
  setFrame(
    camera: PerspectiveCamera,
    width: number,
    height: number,
    depth: Texture | null,
  ): void {
    const u = this.material.uniforms;
    (u.uCameraPos.value as Vector3).copy(camera.position);
    (u.uResolution.value as Vector2).set(width, height);
    u.uSceneDepth.value = depth;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;

    // three.js keeps these current; recomputing them per fragment would be a
    // 4x4 inverse per pixel per beam.
    (u.uProjectionInverse.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCameraWorld.value as Matrix4).copy(camera.matrixWorld);
    (u.uViewForward.value as Vector3).set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  }

  set haze(value: number) {
    this.material.uniforms.uHaze.value = value;
  }
  get haze(): number {
    return this.material.uniforms.uHaze.value as number;
  }

  set exposure(value: number) {
    this.material.uniforms.uExposure.value = value;
  }
  get exposure(): number {
    return this.material.uniforms.uExposure.value as number;
  }

  set steps(value: number) {
    this.material.uniforms.uSteps.value = Math.max(4, Math.min(64, Math.round(value)));
  }
  get steps(): number {
    return this.material.uniforms.uSteps.value as number;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
