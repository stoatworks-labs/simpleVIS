/**
 * Sampling a decimated frame onto a wall pixel.
 *
 * `ElementVideoSource` needs a DOM and is exercised in a real browser by
 * `scripts/verify-render.mjs`; the sampler is pure and is pinned here, because
 * the two things it gets right are both invisible when they go wrong. A
 * missing sRGB decode does not throw — it just washes every video wall out in
 * a way that reads as an exposure problem. And an off-by-one at the frame edge
 * shows up only on the last row of pixels, which on a 10x10 wall is one row in
 * ten.
 */

import { describe, expect, it } from 'vitest';
import { sampleWall, type WallFrame } from '../src/video.js';

/** A frame whose every pixel encodes its own coordinates. */
function grid(width: number, height: number): WallFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const out = () => ({ r: 0, g: 0, b: 0 });

describe('sampleWall', () => {
  it('maps v=0 to the first row and v=1 to the last', () => {
    // The whole orientation contract in one assertion: an image's first row is
    // its top, and v=0 is the top of the wall.
    const frame = grid(4, 4);
    expect(sampleWall(frame, { u: 0, v: 0 }, out()).g).toBeCloseTo(0, 6);
    // Row 3 of 4, sRGB-decoded: the raw byte is 3.
    const last = sampleWall(frame, { u: 0, v: 1 }, out()).g;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(0.01);
  });

  it('decodes sRGB rather than dividing by 255', () => {
    // Mid grey is the case that makes the difference obvious: 128/255 is 0.502
    // linear only if you skip the decode, and 0.216 if you do it. Getting this
    // wrong makes every wall look pale and flat.
    const data = new Uint8ClampedArray([128, 128, 128, 255]);
    const c = sampleWall({ width: 1, height: 1, data }, { u: 0, v: 0 }, out());
    expect(c.r).toBeCloseTo(0.2158, 3);
    expect(c.r).not.toBeCloseTo(128 / 255, 2);
  });

  it('keeps white white and black black', () => {
    const white = new Uint8ClampedArray([255, 255, 255, 255]);
    const black = new Uint8ClampedArray([0, 0, 0, 255]);
    expect(sampleWall({ width: 1, height: 1, data: white }, { u: 0.5, v: 0.5 }, out()).r)
      .toBeCloseTo(1, 6);
    expect(sampleWall({ width: 1, height: 1, data: black }, { u: 0.5, v: 0.5 }, out()).r)
      .toBeCloseTo(0, 6);
  });

  it('stays inside the buffer for out-of-range coordinates', () => {
    // A UV should never be outside 0..1, but a clamp here is the difference
    // between a wrong pixel and reading past the end of the array, which is
    // undefined rather than merely incorrect.
    const frame = grid(8, 8);
    for (const uv of [{ u: -1, v: -1 }, { u: 2, v: 2 }, { u: 1, v: 1 }]) {
      const c = sampleWall(frame, uv, out());
      expect(Number.isFinite(c.r)).toBe(true);
      expect(Number.isFinite(c.g)).toBe(true);
    }
  });

  it('picks the nearest source pixel rather than blending', () => {
    // Nearest is deliberate: an LED pixel is a discrete emitter, so filtering
    // between neighbours would invent detail the wall cannot show.
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const frame: WallFrame = { width: 2, height: 1, data };
    expect(sampleWall(frame, { u: 0.4, v: 0 }, out()).r).toBeCloseTo(0, 6);
    expect(sampleWall(frame, { u: 0.6, v: 0 }, out()).r).toBeCloseTo(1, 6);
  });
});
