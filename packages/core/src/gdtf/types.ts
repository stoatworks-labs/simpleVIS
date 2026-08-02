/**
 * The subset of GDTF that a visualiser actually needs.
 *
 * GDTF describes a fixture exhaustively — wheels, macros, electrical
 * connectors, CRIs, thermal data. simpleVIS models what changes what you see:
 * the geometry tree (so the yoke and head articulate), the beam (so the cone is
 * the right size and colour), and the DMX modes (so a channel value means
 * something). Everything else is deliberately skipped rather than half-parsed.
 */

import type { Mat4 } from '../matrix.js';

/** Geometry node kinds that affect the picture. */
export type GeometryKind =
  | 'Geometry'
  | 'Axis'
  | 'Beam'
  | 'GeometryReference'
  | 'FilterBeam'
  | 'FilterColor'
  | 'FilterGobo'
  | 'FilterShaper'
  | 'MediaServerLayer'
  | 'MediaServerCamera'
  | 'MediaServerMaster'
  | 'Display'
  | 'Laser'
  | 'WiringObject'
  | 'Inventory'
  | 'Structure'
  | 'Support'
  | 'Magnet';

/** Beam data, present only on a `Beam` geometry. All angles in degrees. */
export interface BeamData {
  /** Angle at 50% intensity. The cone most people mean by "beam angle". */
  readonly beamAngle: number;
  /** Angle at 10% intensity — the outer, softer edge. */
  readonly fieldAngle: number;
  /** Total output in lumens. Drives how bright the volumetric beam reads. */
  readonly luminousFlux: number;
  /** Native colour temperature in kelvin, before any CTO/CTB. */
  readonly colorTemperature: number;
  /** Radius of the emitting aperture, in metres. */
  readonly beamRadius: number;
  readonly beamType: 'Wash' | 'Spot' | 'None' | 'Rectangle' | 'PC' | 'Fresnel' | 'Glow';
  readonly lampType: string;
  readonly powerConsumption: number;
}

/** One `<Break>` inside a `GeometryReference`. */
export interface GeometryBreak {
  /** 1-based starting DMX offset for this instance's channels. */
  readonly dmxOffset: number;
  /** Which DMX break (universe/footprint segment) this applies to. */
  readonly dmxBreak: number;
}

/** A node in the fixture's geometry tree. */
export interface GdtfGeometry {
  readonly kind: GeometryKind;
  readonly name: string;
  /** Name of the `Model` supplying the mesh, or '' for an invisible node. */
  readonly model: string;
  /** Transform relative to the parent, metres, column-major. */
  readonly position: Mat4;
  readonly children: readonly GdtfGeometry[];
  /** Present only when `kind === 'Beam'`. */
  readonly beam?: BeamData;
  /** For `GeometryReference`: the name of the geometry being instantiated. */
  readonly referencedGeometry?: string;
  /** For `GeometryReference`: per-break DMX offsets. */
  readonly breaks?: readonly GeometryBreak[];
}

/** A mesh or primitive the geometry tree can point at. */
export interface GdtfModel {
  readonly name: string;
  /** Base filename, without extension, inside `models/<fmt>/`. */
  readonly file: string;
  /**
   * `Undefined` means "use the mesh file". Anything else is a built-in
   * primitive (Cylinder, Cube, Sphere, Base, Yoke, Head, Pigtail, …) that we
   * can draw without loading a mesh at all.
   */
  readonly primitiveType: string;
  /** Bounding size in metres — usable as a fallback box when no mesh loads. */
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One `ChannelFunction`: a span of the channel's DMX range mapped onto a
 * physical quantity.
 */
export interface GdtfChannelFunction {
  readonly name: string;
  /** e.g. `Pan`, `Dimmer`, `ColorSub_C`, `Shutter1Strobe`, `NoFeature`. */
  readonly attribute: string;
  /** Start of this function's DMX span, normalised to 0..1 of full scale. */
  readonly dmxFrom: number;
  /** Default DMX value, normalised 0..1. Used for virtual channels. */
  readonly dmxDefault: number;
  /**
   * Physical value at the start and end of the span.
   *
   * ⚠️ `physicalFrom` is frequently **greater** than `physicalTo` — Pan runs
   * 270 → -270, Zoom 50.2 → 6.6, CTO 5800 → 2850. Interpolate; never sort
   * these or take an absolute range, or every fixture mirrors its movement.
   */
  readonly physicalFrom: number;
  readonly physicalTo: number;
  /**
   * When set, this function is only active while the named channel sits in
   * the given DMX span — GDTF's `ModeMaster`. Several functions on one channel
   * legitimately share `dmxFrom = 0`, and this is the only thing that
   * distinguishes them.
   */
  readonly modeMaster?: {
    readonly channel: string;
    readonly from: number;
    readonly to: number;
  };
}

/** A `LogicalChannel` — one attribute's worth of functions. */
export interface GdtfLogicalChannel {
  readonly attribute: string;
  readonly functions: readonly GdtfChannelFunction[];
}

/** A `DMXChannel` as written in the mode, before geometry expansion. */
export interface GdtfDmxChannel {
  /**
   * 1-based DMX offsets, coarse first: `[2, 3]` is a 16-bit channel.
   *
   * **Empty means the channel is virtual** — it occupies no DMX and holds its
   * default. The Generic LED Wall's Dimmer is written exactly this way, with
   * `Offset=""`, and treating that as offset 0 shifts every following channel.
   */
  readonly offsets: readonly number[];
  /** Name of the geometry this channel drives — `Yoke` for Pan, `Head` for Tilt. */
  readonly geometry: string;
  readonly dmxBreak: number;
  readonly logicalChannels: readonly GdtfLogicalChannel[];
  /** Initial value, normalised 0..1. */
  readonly initialValue: number;
}

export interface GdtfDmxMode {
  readonly name: string;
  /** Root geometry the mode applies to. */
  readonly geometry: string;
  readonly channels: readonly GdtfDmxChannel[];
}

export interface GdtfFixtureType {
  readonly name: string;
  readonly shortName: string;
  readonly manufacturer: string;
  readonly models: readonly GdtfModel[];
  readonly geometries: readonly GdtfGeometry[];
  readonly modes: readonly GdtfDmxMode[];
}
