/**
 * Where each pixel of a pixel-mapped fixture sits on its own surface.
 *
 * A GDTF LED wall is not a video surface in the file — it is a list of
 * `GeometryReference` instances, each with a transform and its own DMX slot.
 * The Generic LED Wall 10x10 has a hundred of them. That is exactly the
 * information needed to treat the wall as a raster: the instances *are* the
 * pixels, and their positions *are* the grid. This module turns that scattered
 * set of 3D positions back into 2D texture coordinates so a video frame can be
 * sampled per pixel.
 *
 * Deliberately geometric rather than index-based. Instance order in a GDTF is
 * document order, and document order is not reading order — the MAC Ultra
 * writes its blade channels 33,34,35,36 before 29,30,31,32, and nothing says a
 * wall must be any better behaved. Positions cannot lie about where a pixel
 * is; an index can.
 *
 * ---
 *
 * **A fixture's local axes do not know which way is up. Only its placement
 * does.** This cost a rendered frame to find out: the Demostage's LED Wall is
 * authored flat in its own XY plane, and the MVR stands it up with a transform
 * whose local **+Y maps to world −Z** — so the pixel with the largest local Y
 * is the *bottom* of the wall as hung. Deriving "down the picture" from the
 * local axis alone played every wall in the show upside down, which is subtle
 * enough on abstract content to pass a glance and obvious the moment anything
 * has a top.
 *
 * So the surface is found in local space, where the grid is regular and the
 * arithmetic is cheap, and then **which of its two axes runs down the picture
 * is decided in world space, against world up**. Content ends up upright in
 * the room whatever attitude the wall is hung at, which is what a media server
 * feeding a real wall does.
 *
 * The left-right sense is *not* determined here, and cannot be: nothing in an
 * MVR says which face of a wall is its front, so "mirrored" and "not mirrored"
 * are indistinguishable from the file. It follows the fixture's own axis
 * order. If that ever needs overriding it wants a per-fixture flip, not a
 * cleverer guess.
 */

import type { PatchedFixture } from './patch.js';
import type { Mat4 } from './matrix.js';

/** Where one emitter sits on its fixture's pixel surface. Both 0..1. */
export interface PixelUv {
  /** Across the surface, 0 at one edge and 1 at the other. */
  readonly u: number;
  /** Down the surface: **0 is the top**, matching an image's first row. */
  readonly v: number;
}

/** UVs for one pixel-mapped fixture, keyed by geometry-instance name. */
export type PixelMap = ReadonlyMap<string, PixelUv>;

/** An extent smaller than this is treated as no extent at all: 0.1 mm. */
const FLAT = 1e-4;

/**
 * A world direction this close to horizontal counts as horizontal.
 *
 * Generous on purpose. A wall raked a few degrees off vertical is still a wall
 * and still wants its content upright; the test only has to separate "roughly
 * upright" from "lying down".
 */
const LEVEL = 1e-3;

/**
 * The world direction a fixture's local axis points, as a `[x, y, z]` triple.
 *
 * The transform is column-major, so the image of local axis `a` is column `a`
 * of the matrix — no inverse, no transpose, and no need to normalise, because
 * every use here is a comparison between components of the same vector.
 */
function axisInWorld(transform: Mat4, axis: number): [number, number, number] {
  return [transform[axis * 4], transform[axis * 4 + 1], transform[axis * 4 + 2]];
}

/**
 * Derive texture coordinates for a fixture's emitters.
 *
 * Returns `null` for anything that is not a surface — a single-emitter
 * fixture, or a set of instances that all sit at one point. A moving head is
 * not a video wall and must not be given a UV, or it would take the video
 * feed's colour the moment one was playing.
 */
export function buildPixelMap(fixture: PatchedFixture): PixelMap | null {
  const instances = fixture.instances;
  if (instances.length < 2) return null;

  // Column-major, so the translation is the last column: indices 12, 13, 14.
  const points = instances.map((i) => [
    i.transform[12],
    i.transform[13],
    i.transform[14],
  ] as const);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let axis = 0; axis < 3; axis++) {
      if (p[axis] < min[axis]) min[axis] = p[axis];
      if (p[axis] > max[axis]) max[axis] = p[axis];
    }
  }
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

  // The two axes the pixels actually spread along are the surface; the third
  // is its normal. Ranking by extent finds them without assuming the geometry
  // is authored in any particular plane — the Demostage's wall is built in XY
  // and stood up by its placement, and another exporter may well not be.
  const ranked = [0, 1, 2].sort((a, b) => extent[b] - extent[a]);
  const [first, second] = ranked;
  if (extent[first] <= FLAT) return null; // every pixel at one point

  const placement = fixture.fixture.transform as Mat4;
  const firstUp = axisInWorld(placement, first)[2];
  const secondUp = axisInWorld(placement, second)[2];

  // Whichever of the surface's two axes leans more towards world up is the one
  // that runs down the picture.
  let vertical = Math.abs(firstUp) >= Math.abs(secondUp) ? first : second;
  let rises = (vertical === first ? firstUp : secondUp) > 0;

  if (Math.abs(vertical === first ? firstUp : secondUp) <= LEVEL) {
    // A horizontal surface — a pixel floor or ceiling. Neither axis is "up",
    // so nothing about the room can settle it. Run the picture along world Y,
    // upstage to downstage, which at least makes two such surfaces in the same
    // rig agree with each other.
    const firstDepth = axisInWorld(placement, first)[1];
    const secondDepth = axisInWorld(placement, second)[1];
    vertical = Math.abs(firstDepth) >= Math.abs(secondDepth) ? first : second;
    rises = (vertical === first ? firstDepth : secondDepth) > 0;
  }

  const horizontal = vertical === first ? second : first;

  const uv = new Map<string, PixelUv>();
  for (let i = 0; i < instances.length; i++) {
    const p = points[i];
    // A single row or column of pixels is a legitimate fixture — a batten, a
    // pixel bar, the two cells of a Sunrise2IP. It has no extent across, so
    // every pixel sits down the middle of the frame rather than dividing by
    // zero.
    const u =
      extent[horizontal] > FLAT
        ? (p[horizontal] - min[horizontal]) / extent[horizontal]
        : 0.5;
    const along =
      extent[vertical] > FLAT
        ? (p[vertical] - min[vertical]) / extent[vertical]
        : 0.5;
    // `rises` means the local axis increases *upward* in the room, so its top
    // end is the picture's first row and the coordinate has to be flipped.
    uv.set(instances[i].name, { u, v: rises ? 1 - along : along });
  }
  return uv;
}
