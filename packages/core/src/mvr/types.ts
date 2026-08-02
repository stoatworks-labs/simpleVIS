/**
 * The MVR scene, as much of it as a visualiser needs.
 *
 * simpleVIS imports MVR and does not edit it, so this is a read model: it
 * captures what to draw and what is patched where, and drops the authoring
 * metadata (classes, symdef libraries used only for editing, user data).
 */

import type { Mat4 } from '../matrix.js';
import type { DmxAddress } from '../dmx/address.js';

/**
 * A colour as MVR actually stores it: **CIE 1931 xyY**, not RGB.
 *
 * `<Color>0.312712,0.329008,100.000000</Color>` is D65 white at Y=100, which
 * read as RGB would be a nearly-black blue. Converted at the render boundary,
 * never treated as a triple of channel values.
 */
export interface CieXyY {
  readonly x: number;
  readonly y: number;
  /** Luminance. MVR fixtures conventionally carry 100. */
  readonly Y: number;
}

/** A patched lighting fixture. */
export interface MvrFixture {
  readonly uuid: string;
  readonly name: string;
  /** Filename stem of the GDTF inside the archive, e.g. `Robe Lighting@Robin SuperSpikie`. */
  readonly gdtfSpec: string;
  /** DMX mode name to resolve against that GDTF. */
  readonly gdtfMode: string;
  /** Placement in the venue, metres, Z-up, column-major. */
  readonly transform: Mat4;
  /** One entry per DMX break. Most fixtures have exactly one. */
  readonly addresses: readonly (DmxAddress & { readonly break: number })[];
  /** The number shown on the console. */
  readonly fixtureId: number;
  readonly unitNumber: number;
  readonly customId: number;
  readonly color?: CieXyY;
  readonly castShadow: boolean;
  /** UUID of the containing layer. */
  readonly layer: string;
}

/** Non-emitting scene geometry — truss, set, soft goods, speakers. */
export interface MvrSceneObject {
  readonly uuid: string;
  readonly name: string;
  readonly transform: Mat4;
  /** Model filenames inside the archive, usually `.glb` or `.3ds`. */
  readonly models: readonly string[];
  readonly layer: string;
}

export interface MvrLayer {
  readonly uuid: string;
  readonly name: string;
}

export interface MvrScene {
  readonly version: { readonly major: number; readonly minor: number };
  readonly layers: readonly MvrLayer[];
  readonly fixtures: readonly MvrFixture[];
  readonly sceneObjects: readonly MvrSceneObject[];
}
