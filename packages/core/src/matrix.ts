/**
 * Matrix and unit handling for MVR and GDTF.
 *
 * ⚠️ The two formats ship inside the same `.mvr` archive and disagree on
 * **both** the layout of a matrix and the unit of its translation. Getting
 * this wrong does not fail loudly — the rig simply appears at the wrong scale
 * or with fixtures rotated onto their sides, which reads as a renderer bug.
 *
 *   MVR   `<Matrix>`   4 groups of **3**  = {u}{v}{w}{o}
 *                      u,v,w are basis vectors (the rotation columns),
 *                      o is the origin, in **millimetres**.
 *
 *   GDTF  `Position=`  4 groups of **4**  = 4 **rows** of a 4x4,
 *                      translation in the last element of rows 0..2,
 *                      in **metres**.
 *
 * The GDTF layout is rows rather than columns, which is worth stating because
 * both readings parse. Only rows produce meaningful numbers: the MAC Ultra
 * Performance's Pigtail is `{1,0,0,0}{0,1,0,-0.156}{0,0,1,-0.050}{0,0,0,1}`,
 * which as rows means "offset 156 mm in -Y and 50 mm in -Z" — a cable gland on
 * the underside of the base. Read as columns it would be a basis vector with a
 * homogeneous w of -0.156, which is not a thing.
 *
 * Everything downstream of this module is in **metres**, Z-up, matching GDTF's
 * own convention.
 */

/**
 * A 4x4 transform in **column-major** order — `m[col * 4 + row]` — which is
 * what three.js, WebGL and WGSL all expect, so the render layer can hand these
 * straight to `Matrix4.fromArray` without a transpose.
 */
export type Mat4 = Float64Array;

export const MM_TO_M = 0.001;

/** Column-major identity. */
export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/**
 * Pull the numbers out of a `{a,b,c}{d,e,f}...` blob.
 *
 * Both formats use this bracketed style, and real files are inconsistent about
 * whitespace inside and between the groups, so this reads the whole string as
 * one token stream rather than trying to match a rigid shape.
 */
export function parseGroups(source: string): number[][] {
  const groups: number[][] = [];
  const re = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const nums = match[1]
      .split(',')
      .map((s) => Number.parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n));
    groups.push(nums);
  }
  return groups;
}

/**
 * Parse an MVR `<Matrix>`: `{u}{v}{w}{o}`, 3 components each, origin in mm.
 *
 * Returns identity for an empty or malformed value — MVR uses an absent or
 * empty `<Matrix>` to mean "at the origin", and several `SceneObject`s in
 * MA's Demostage do exactly that.
 */
export function parseMvrMatrix(source: string): Mat4 {
  const g = parseGroups(source);
  if (g.length < 4 || g.some((v) => v.length < 3)) return identity();

  const [u, v, w, o] = g;
  const m = new Float64Array(16);
  // Basis vectors become columns 0..2, with homogeneous w = 0.
  m[0] = u[0];  m[1] = u[1];  m[2] = u[2];  m[3] = 0;
  m[4] = v[0];  m[5] = v[1];  m[6] = v[2];  m[7] = 0;
  m[8] = w[0];  m[9] = w[1];  m[10] = w[2]; m[11] = 0;
  // Origin becomes column 3, converted mm -> m.
  m[12] = o[0] * MM_TO_M;
  m[13] = o[1] * MM_TO_M;
  m[14] = o[2] * MM_TO_M;
  m[15] = 1;
  return m;
}

/**
 * Parse a GDTF `Position`: 4 **rows** of 4, already in metres.
 *
 * Returns identity for an empty or malformed value; GDTF geometry nodes are
 * allowed to omit `Position` entirely, meaning "coincident with the parent".
 */
export function parseGdtfMatrix(source: string): Mat4 {
  const g = parseGroups(source);
  if (g.length < 4 || g.some((v) => v.length < 4)) return identity();

  const m = new Float64Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      m[col * 4 + row] = g[row][col];
    }
  }
  return m;
}

/** `out = a * b`, both column-major. Allocates. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      m[col * 4 + row] = sum;
    }
  }
  return m;
}

/** The translation column, in metres. */
export function translationOf(m: Mat4): [number, number, number] {
  return [m[12], m[13], m[14]];
}
