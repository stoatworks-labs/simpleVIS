/**
 * The detail curve: one 0..1 number, and the four costs it stands for.
 *
 * Kept apart from `viewer.ts` because it is pure arithmetic with no three.js
 * in it — the UI reads it to say what a slider position means, and a test can
 * exercise it without a WebGL context.
 */

/** The individual costs one `detail` value resolves to. */
export interface DetailSettings {
  /** Raymarch steps per beam fragment. The shader's loop bound is 64. */
  readonly steps: number;
  /** Beam-buffer resolution as a fraction of the canvas. */
  readonly beamScale: number;
  /** Hard cap on volumetric cones per frame. */
  readonly maxBeams: number;
  /** Requested device pixel ratio, before the display's own is applied. */
  readonly pixelRatio: number;
}

/**
 * The detail curve, as anchors that are interpolated between.
 *
 * **0.5 is exactly the tuning this renderer shipped with**, so the default
 * detail is a no-op against the numbers in `AGENTS.md` — 112 cones and 1,600
 * glows at 60-70 fps on the Demostage. The stops either side are what moves.
 *
 * The two ends are not symmetric, and deliberately so. Downward the cheap wins
 * come from fill rate: quarter-resolution beams and a 1x pixel ratio cut
 * fragments fourfold each, while dropping to 48 cones sheds the overdraw of a
 * hundred overlapping washes. That end measured 50 fps on the Demostage where
 * the default measured 22-27.
 *
 * **The top stop is 0.75 beam scale, not 1.0, and that is a measurement not a
 * taste.** The beam pass is pure overdraw — hundreds of large cones each
 * sampling the volume dozens of times — so it scales with the square of the
 * scale, and at 1.0 with a 2x pixel ratio it is *sixteen times* the fragments
 * of the default. On the Demostage that did not merely drop frames: it wedged
 * the page hard enough that a CDP evaluate against it never returned. A
 * quality slider whose top end hangs the app is a worse control than one that
 * stops short, so it stops short. 0.75 is 2.25x the default's fragments, which
 * is heavy and visible and still interactive.
 */
const DETAIL_STOPS: readonly (DetailSettings & { readonly at: number })[] = [
  { at: 0, steps: 12, beamScale: 0.25, maxBeams: 48, pixelRatio: 1 },
  { at: 0.5, steps: 48, beamScale: 0.5, maxBeams: 400, pixelRatio: 2 },
  { at: 1, steps: 64, beamScale: 0.75, maxBeams: 600, pixelRatio: 2 },
];

/** Resolve a 0..1 detail value to the costs it stands for. */
export function detailSettings(detail: number): DetailSettings {
  const d = Math.min(1, Math.max(0, Number.isFinite(detail) ? detail : 0.5));

  let lo = DETAIL_STOPS[0];
  let hi = DETAIL_STOPS[DETAIL_STOPS.length - 1];
  for (let i = 0; i < DETAIL_STOPS.length - 1; i++) {
    if (d >= DETAIL_STOPS[i].at && d <= DETAIL_STOPS[i + 1].at) {
      lo = DETAIL_STOPS[i];
      hi = DETAIL_STOPS[i + 1];
      break;
    }
  }

  const span = hi.at - lo.at;
  const t = span === 0 ? 0 : (d - lo.at) / span;
  const lerp = (a: number, b: number) => a + (b - a) * t;

  return {
    steps: Math.round(lerp(lo.steps, hi.steps)),
    beamScale: lerp(lo.beamScale, hi.beamScale),
    maxBeams: Math.round(lerp(lo.maxBeams, hi.maxBeams)),
    pixelRatio: lerp(lo.pixelRatio, hi.pixelRatio),
  };
}
