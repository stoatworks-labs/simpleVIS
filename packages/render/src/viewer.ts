/**
 * The viewer: owns the canvas, the camera and the three render passes.
 *
 * Pass order, and why it is three rather than one:
 *
 *   1. **Opaque scene** into an offscreen target that also carries a depth
 *      texture. Set, truss, fixture bodies, floor.
 *   2. **Composite** that target to the canvas.
 *   3. **Beams**, additively, sampling the depth texture from pass 1.
 *
 * The beams cannot share pass 1's depth buffer because a shader may not sample
 * the depth attachment it is currently rendering against. And they must not
 * simply depth-test, or a camera inside a beam loses it entirely and a beam
 * crossing the deck pops out of existence instead of stopping where it lands.
 *
 * Everything is **Z-up**, matching GDTF and MVR, so no axis conversion happens
 * anywhere in this package. three.js defaults to Y-up; the camera's `up` is set
 * accordingly and `OrbitControls` follows it.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DepthTexture,
  DirectionalLight,
  Fog,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FixtureState, Patch } from '@simplevis/core';
import { BeamSystem, type BeamInstance } from './beams.js';
import { GlowSystem, type GlowInstance } from './glow.js';
import { applyState, buildFixture, type FixtureNode } from './fixtures.js';
import { compositeFragmentShader, compositeVertexShader } from './beams.glsl.js';
import { detailSettings } from './detail.js';
import { sampleWall, type SampledColor, type WallVideoSource } from './video.js';

/**
 * What a wireframed material emits.
 *
 * Emissive rather than albedo, deliberately. This scene is lit at 0.12 ambient
 * because the beams are supposed to be the light in it, and a diffuse surface
 * under that much ambient lands near black whatever colour it is — which is
 * how the first attempt at this produced a wireframe nobody could see. Emissive
 * is added straight to the outgoing radiance, so a wireframe is exactly this
 * colour no matter what the lighting is doing.
 */
const WIREFRAME_EMISSIVE = 0x8ea0c0;

export interface ViewerOptions {
  haze?: number;
  exposure?: number;
  steps?: number;
  /** How far a beam is drawn, metres. */
  beamRange?: number;
  /** Emitters at or below this intensity are skipped entirely. */
  minIntensity?: number;
  /**
   * Emitters rated below this many lumens get no volumetric cone — they glow
   * but do not light the air. Keeps a 1,600-pixel LED wall from costing more
   * than the entire moving-light rig.
   */
  minFlux?: number;
  /** Hard cap on volumetric cones per frame; the brightest win. */
  maxBeams?: number;
  /** Beam-buffer resolution as a fraction of the canvas. 0.5 = quarter cost. */
  beamScale?: number;
  /** Billboard radius for low-flux emitters, metres. */
  glowSize?: number;
  showFloor?: boolean;
  /**
   * One knob for the cost of a frame, 0..1. Resolves to `steps`, `beamScale`,
   * `maxBeams` and the device pixel ratio via {@link detailSettings}; any of
   * those passed explicitly wins over what it derives.
   */
  detail?: number;
  /**
   * Draw the scene as edges only, with no beams and no glows. A navigation and
   * diagnosis mode, not a look: it skips the whole volumetric half of the
   * renderer, so it runs on anything.
   */
  wireframe?: boolean;
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly beams: BeamSystem;
  readonly glows: GlowSystem;

  private target: WebGLRenderTarget;
  private beamTarget: WebGLRenderTarget;
  private beamScene = new Scene();
  private compositeScene = new Scene();
  private compositeCamera = new PerspectiveCamera();
  private compositeMaterial: ShaderMaterial;
  private drawingBufferSize = new Vector2();

  private fixtures: FixtureNode[] = [];
  private rigRoot = new Object3D();
  private beamBuffer: BeamInstance[] = [];
  private glowBuffer: GlowInstance[] = [];
  private options: Required<ViewerOptions>;
  private deck: Mesh | null = null;
  private sceneObjects: Object3D[] = [];
  private video: WallVideoSource | null = null;
  /** Reused across every pixel of every wall, so sampling allocates nothing. */
  private readonly sampled: SampledColor = { r: 0, g: 0, b: 0 };
  private videoPixels = 0;

  constructor(canvas: HTMLCanvasElement, options: ViewerOptions = {}) {
    const detail = options.detail ?? 0.5;
    const derived = detailSettings(detail);
    this.options = {
      haze: options.haze ?? 0.28,
      exposure: options.exposure ?? 1,
      steps: options.steps ?? derived.steps,
      beamRange: options.beamRange ?? 30,
      minIntensity: options.minIntensity ?? 0.002,
      minFlux: options.minFlux ?? 300,
      maxBeams: options.maxBeams ?? derived.maxBeams,
      beamScale: options.beamScale ?? derived.beamScale,
      glowSize: options.glowSize ?? 0.09,
      showFloor: options.showFloor ?? true,
      detail,
      wireframe: options.wireframe ?? false,
    };

    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatioFor(derived.pixelRatio));
    // Beams are additive HDR-ish accumulations; tone mapping would crush the
    // difference between a fixture at 40% and one at full.
    this.renderer.toneMapping = NoToneMapping;
    // three.js resets render stats on every `render()` call, and a frame here
    // is three of them — so the reported count was always just the composite
    // quad. Reset once per frame instead so the number means something.
    this.renderer.info.autoReset = false;

    this.scene = new Scene();
    this.scene.background = new Color(0x05050a);
    this.scene.fog = new Fog(0x05050a, 40, 160);

    this.camera = new PerspectiveCamera(50, 1, 0.1, 500);
    this.camera.up.set(0, 0, 1); // Z-up, as GDTF and MVR both are
    this.camera.position.set(0, -18, 6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 2);

    // A little ambient so unlit fixture bodies are readable as silhouettes
    // rather than pure black shapes on a near-black field.
    this.scene.add(new AmbientLight(0xffffff, 0.12));
    const key = new DirectionalLight(0xffffff, 0.15);
    key.position.set(6, -10, 12);
    this.scene.add(key);

    if (this.options.showFloor) this.addFloor();
    this.scene.add(this.rigRoot);

    this.beams = new BeamSystem({
      haze: this.options.haze,
      exposure: this.options.exposure,
      steps: this.options.steps,
    });
    // The beams live in their own scene so pass 3 can draw them alone. Putting
    // them in the main scene and re-rendering it with autoClear off would
    // redraw every opaque object on top of the composited image.
    this.beamScene.add(this.beams.mesh);

    // Glows are opaque-ish additive quads that belong with the scene, not with
    // the half-resolution beam buffer — they are small and want full detail.
    this.glows = new GlowSystem();
    this.scene.add(this.glows.mesh);

    const depthTexture = new DepthTexture(1, 1);
    depthTexture.type = UnsignedIntType;
    this.target = new WebGLRenderTarget(1, 1, { depthTexture, depthBuffer: true });
    this.beamTarget = new WebGLRenderTarget(1, 1, { depthBuffer: false });

    this.compositeMaterial = new ShaderMaterial({
      vertexShader: compositeVertexShader,
      fragmentShader: compositeFragmentShader,
      uniforms: {
        uScene: { value: this.target.texture },
        uBeams: { value: this.beamTarget.texture },
        uBeamTexel: { value: new Vector2(1 / 960, 1 / 540) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.compositeMaterial);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);

    this.applyWireframe();
    this.resize();
  }

  /**
   * Push the wireframe flag onto every material in the scene.
   *
   * Re-applied whenever geometry arrives, not just when the flag is toggled:
   * the rig and the MVR's set are both added long after construction, so a
   * single pass at toggle time would be quietly undone by the next import.
   *
   * The glows are excluded and hidden outright — they are additive billboards
   * standing in for light, not geometry, and a wireframe quad says nothing.
   */
  private applyWireframe(): void {
    const on = this.options.wireframe;
    this.glows.mesh.visible = !on;
    if (this.deck) this.deck.visible = !on;

    this.scene.traverse((object) => {
      if (object === this.glows.mesh) return;
      const material = (object as Mesh).material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        // GridHelper draws lines, whose material has neither `wireframe` nor
        // `emissive`. It is skipped entirely: it is already edges, and lit to
        // the wireframe colour a 60x60 grid would out-shout the rig on it.
        if (!('wireframe' in m)) continue;
        const standard = m as MeshStandardMaterial;
        standard.wireframe = on;
        if (!standard.emissive) continue;
        // Stashed on the material rather than in a side table, so geometry
        // that arrives with a later import is captured on its own first pass
        // instead of being restored to some other material's value.
        standard.userData.solidEmissive ??= standard.emissive.getHex();
        standard.emissive.setHex(
          on ? WIREFRAME_EMISSIVE : (standard.userData.solidEmissive as number),
        );
      }
    });
  }

  /** Never ask for more pixels than the display actually has. */
  private pixelRatioFor(requested: number): number {
    return Math.min(requested, globalThis.devicePixelRatio ?? 1);
  }

  private addFloor(): void {
    const grid = new GridHelper(60, 60, 0x2a2a38, 0x16161f);
    // GridHelper is built in the XZ plane; stand it up for a Z-up world.
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    const deck = new Mesh(
      new PlaneGeometry(60, 60),
      new MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.95, metalness: 0 }),
    );
    deck.position.z = -0.01;
    this.scene.add(deck);
    // Kept so wireframe mode can hide it: the deck is two triangles, and as
    // edges it is a giant X across the floor that reads as a rendering fault.
    // The grid already says where the floor is.
    this.deck = deck;
  }

  /** Replace the rig. Disposes the previous one. */
  setPatch(patch: Patch): void {
    this.clearRig();
    for (const patched of patch.fixtures) {
      const node = buildFixture(patched);
      this.fixtures.push(node);
      this.rigRoot.add(node.root);
    }
    this.applyWireframe();
    this.frameRig();
  }

  /** Add already-loaded set geometry (GLB from the MVR) to the scene. */
  addSceneObject(object: Object3D): void {
    this.rigRoot.add(object);
    this.sceneObjects.push(object);
    this.applyWireframe();
  }

  /**
   * Drop the previous rig — fixtures **and** set geometry.
   *
   * The set has to go too, and did not before: `setPatch` replaced the
   * fixtures while `addSceneObject`'s truss, deck and soft goods stayed in the
   * scene forever, so importing a second MVR drew both plots on top of each
   * other. It reads as a draw-call number that climbs 69 at a time — the
   * Demostage's set-mesh count — with nothing visibly wrong until two rigs'
   * trusses overlap.
   */
  private clearRig(): void {
    for (const fixture of this.fixtures) this.rigRoot.remove(fixture.root);
    this.fixtures = [];
    for (const object of this.sceneObjects) this.rigRoot.remove(object);
    this.sceneObjects = [];
  }

  /** Point the camera at the whole rig. */
  frameRig(): void {
    if (this.fixtures.length === 0) return;
    const box = new Box3().setFromObject(this.rigRoot);
    if (box.isEmpty()) return;

    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const distance = radius / Math.tan((this.camera.fov * Math.PI) / 360);

    this.controls.target.copy(centre);
    this.camera.position.set(
      centre.x,
      centre.y - distance * 1.15,
      centre.z + distance * 0.45,
    );
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Play a video feed on every pixel-mapped fixture in the rig.
   *
   * Pass `null` to stop. The previous source is disposed, which stops a screen
   * capture's tracks and hands the browser's "you are sharing" banner back —
   * leaking that would be a privacy bug, not an untidiness.
   */
  setWallVideo(source: WallVideoSource | null): void {
    if (this.video && this.video !== source) this.video.dispose();
    this.video = source;
    if (!source) this.videoPixels = 0;
  }

  /** The feed currently playing on the walls, if any. */
  get wallVideo(): WallVideoSource | null {
    return this.video;
  }

  /** Emitters that took their colour from video on the last update. */
  get videoPixelCount(): number {
    return this.videoPixels;
  }

  /** Feed a frame of evaluated fixture state. */
  update(states: readonly FixtureState[]): void {
    this.beamBuffer.length = 0;
    this.glowBuffer.length = 0;
    const byUuid = new Map(states.map((s) => [s.uuid, s]));

    // Pulled once per frame, not once per pixel: a source decodes and reads
    // back a frame, and doing that 1,600 times would cost more than the entire
    // rest of the renderer.
    const frame = this.video?.frame() ?? null;
    let pixels = 0;
    const sampleVideo = frame
      ? (uv: Parameters<typeof sampleWall>[1]) => {
          pixels++;
          return sampleWall(frame, uv, this.sampled);
        }
      : undefined;

    for (const fixture of this.fixtures) {
      const state = byUuid.get(fixture.patched.fixture.uuid);
      if (!state) continue;
      applyState(fixture, state.emitters, this.beamBuffer, this.glowBuffer, {
        range: this.options.beamRange,
        minIntensity: this.options.minIntensity,
        minFlux: this.options.minFlux,
        glowSize: this.options.glowSize,
        sampleVideo,
      });
    }
    this.videoPixels = pixels;

    // Wireframe draws neither, and dropping them here rather than at draw time
    // means the status bar reports 0 beams and 0 glows — which is the truth,
    // where a stale count would read as beams that failed to appear.
    if (this.options.wireframe) {
      this.beamBuffer.length = 0;
      this.glowBuffer.length = 0;
    }

    // Above the cap, keep the beams that contribute most. Sorting only when the
    // cap is exceeded keeps the common case allocation- and comparison-free.
    if (this.beamBuffer.length > this.options.maxBeams) {
      this.beamBuffer.sort((a, b) => brightness(b) - brightness(a));
      this.beamBuffer.length = this.options.maxBeams;
    }
    this.beams.update(this.beamBuffer);
    this.glows.update(this.glowBuffer, this.camera.quaternion);
  }

  /** Draw calls issued on the last rendered frame. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  /** Low-flux emitters drawn as billboards rather than volumetric cones. */
  get activeGlowCount(): number {
    return this.glowBuffer.length;
  }

  /** Number of beams drawn on the last update — useful in a status bar. */
  get activeBeamCount(): number {
    return this.beamBuffer.length;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const ratio = this.renderer.getPixelRatio();
    const w = Math.floor(width * ratio);
    const h = Math.floor(height * ratio);
    this.target.setSize(w, h);
    const bw = Math.max(1, Math.floor(w * this.options.beamScale));
    const bh = Math.max(1, Math.floor(h * this.options.beamScale));
    this.beamTarget.setSize(bw, bh);
    (this.compositeMaterial.uniforms.uBeamTexel.value as Vector2).set(1 / bw, 1 / bh);
  }

  render(): void {
    this.controls.update();
    this.renderer.info.reset();

    // Wireframe skips the volumetric half of the renderer entirely, and with
    // no beams to add there is nothing for the offscreen target or the
    // composite to do either — one pass, straight to the canvas. The clear
    // colour is restored because the beam pass below leaves it transparent.
    if (this.options.wireframe) {
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // 1. Opaque scene at full resolution, which also fills the depth texture
    //    the beams need.
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // 2. Beams into their own, smaller buffer.
    //
    //    This is the difference between the Demostage running and not. Each
    //    cone is drawn with depth testing off and raymarched per fragment, so
    //    the cost is pure overdraw — hundreds of large cones each sampling the
    //    volume dozens of times. At full resolution that measured seconds per
    //    frame. Beams are low-frequency glow, so a half-resolution buffer is
    //    visually indistinguishable and a quarter of the fragments.
    const beamSize = this.beamTarget;
    this.beams.setFrame(this.camera, beamSize.width, beamSize.height, this.target.depthTexture);
    this.renderer.setRenderTarget(this.beamTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.beamScene, this.camera);

    // 3. Add them together onto the canvas.
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.compositeScene, this.compositeCamera);
  }

  set haze(value: number) {
    this.options.haze = value;
    this.beams.haze = value;
  }
  get haze(): number {
    return this.options.haze;
  }

  set exposure(value: number) {
    this.options.exposure = value;
    this.beams.exposure = value;
  }
  get exposure(): number {
    return this.options.exposure;
  }

  /**
   * Move the whole quality curve at once. See {@link detailSettings}.
   *
   * Both the pixel ratio and the beam scale decide a render target's size, so
   * the buffers are rebuilt here rather than left to the next window resize.
   */
  set detail(value: number) {
    const resolved = detailSettings(value);
    this.options.detail = value;
    this.options.steps = resolved.steps;
    this.options.maxBeams = resolved.maxBeams;
    this.options.beamScale = resolved.beamScale;
    this.beams.steps = resolved.steps;
    this.renderer.setPixelRatio(this.pixelRatioFor(resolved.pixelRatio));
    this.resize();
  }
  get detail(): number {
    return this.options.detail;
  }

  set wireframe(value: boolean) {
    this.options.wireframe = value;
    this.applyWireframe();
  }
  get wireframe(): boolean {
    return this.options.wireframe;
  }

  dispose(): void {
    this.video?.dispose();
    this.video = null;
    this.beams.dispose();
    this.glows.dispose();
    this.target.dispose();
    this.beamTarget.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

/** Rough perceptual weight of a beam, for choosing which to keep under a cap. */
function brightness(b: BeamInstance): number {
  return b.color.r * 0.2126 + b.color.g * 0.7152 + b.color.b * 0.0722;
}
