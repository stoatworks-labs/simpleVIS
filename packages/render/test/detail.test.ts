/**
 * The detail curve.
 *
 * Two things here are load-bearing and neither is visible from the slider:
 * **0.5 must reproduce the tuning the renderer shipped with** — 48 steps, a
 * half-resolution beam buffer, 400 cones — because that is the configuration
 * the Demostage's 60-70 fps was measured against, and a default that quietly
 * drifted off it would move that number with nothing to say why. And the curve
 * must stay monotonic: a "detail" slider that costs less as it goes up is
 * worse than no slider.
 */

import { describe, expect, it } from 'vitest';
import { detailSettings } from '../src/detail.js';

describe('detailSettings', () => {
  it('reproduces the shipped tuning at the midpoint', () => {
    expect(detailSettings(0.5)).toEqual({
      steps: 48,
      beamScale: 0.5,
      maxBeams: 400,
      pixelRatio: 2,
    });
  });

  it('never exceeds the shader loop bound', () => {
    // The beam shader caps its march at 64; asking for more silently does
    // nothing, which would read as a slider with a dead top end.
    for (let d = 0; d <= 1.0001; d += 0.05) {
      expect(detailSettings(d).steps).toBeLessThanOrEqual(64);
    }
  });

  it('is monotonic in every cost it controls', () => {
    let previous = detailSettings(0);
    for (let d = 0.05; d <= 1.0001; d += 0.05) {
      const next = detailSettings(d);
      expect(next.steps).toBeGreaterThanOrEqual(previous.steps);
      expect(next.beamScale).toBeGreaterThanOrEqual(previous.beamScale);
      expect(next.maxBeams).toBeGreaterThanOrEqual(previous.maxBeams);
      expect(next.pixelRatio).toBeGreaterThanOrEqual(previous.pixelRatio);
      previous = next;
    }
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(detailSettings(-5)).toEqual(detailSettings(0));
    expect(detailSettings(99)).toEqual(detailSettings(1));
    // A control that has never been touched can hand over NaN via Number('');
    // falling back to the midpoint keeps that from blanking the beam buffer.
    expect(detailSettings(Number.NaN)).toEqual(detailSettings(0.5));
  });

  it('keeps the beam buffer at least a quarter of the canvas', () => {
    // Below that the composite's own blur stops hiding the raymarch steps and
    // beams read as banded blocks rather than as soft light.
    expect(detailSettings(0).beamScale).toBeGreaterThanOrEqual(0.25);
  });

  it('stops short of full-resolution beams', () => {
    // Not a stylistic cap. At 1.0 beam scale and a 2x pixel ratio the beam
    // pass is 16x the default's fragments, and on the Demostage that wedged
    // the page rather than merely slowing it. See the note on DETAIL_STOPS.
    expect(detailSettings(1).beamScale).toBeLessThanOrEqual(0.75);
  });
});
