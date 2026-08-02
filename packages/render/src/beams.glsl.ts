/**
 * Volumetric beam shaders.
 *
 * Every beam in the show is one instance of a single cone template, so the
 * whole rig is one draw call regardless of fixture count. The cone is only a
 * *proxy* — it exists to rasterise the right screen area. All the real work
 * happens in the fragment shader, which raymarches the camera ray through the
 * cone volume accumulating scattered light.
 *
 * Two decisions worth keeping:
 *
 *  - **The march interval comes from the axial slab, not from a ray/cone
 *    quadratic.** Solving the quadratic is exact but the double-nappe sign
 *    cases are fiddly, and getting one wrong produces beams that vanish at
 *    certain camera angles — a bug that only shows up when you orbit. Clipping
 *    the ray to `0 <= axial <= range` is trivially correct, and a cheap
 *    per-sample containment test inside the loop handles the radial extent.
 *    Some samples are wasted outside the cone; at 32 steps that is free.
 *
 *  - **Depth comes from a texture, not the depth buffer.** The beams are drawn
 *    with `depthTest: false` so that a camera sitting inside a beam still sees
 *    it, and each sample is instead rejected against the scene depth sampled
 *    per fragment. That gives partial occlusion — a beam correctly stops where
 *    it hits the deck instead of the whole cone popping out of existence.
 */

export const beamVertexShader = /* glsl */ `
precision highp float;

// Per-instance beam description.
attribute vec3  iOrigin;    // apex, world space
attribute vec3  iDir;       // unit emission direction
attribute vec3  iColor;     // linear RGB premultiplied by intensity
attribute vec4  iShape;     // x: cos(halfBeam)  y: cos(halfField)
                            // z: range (m)      w: aperture radius (m)

varying vec3 vOrigin;
varying vec3 vDir;
varying vec3 vColor;
varying vec4 vShape;

/** Any orthonormal basis whose +Z is \`dir\`. */
mat3 basisFrom(vec3 dir) {
  // Picking the reference axis by the smallest component keeps the cross
  // product well conditioned; using a fixed up vector degenerates for
  // straight-down fixtures, which is most of a lighting rig.
  vec3 ref = abs(dir.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 x = normalize(cross(ref, dir));
  vec3 y = cross(dir, x);
  return mat3(x, y, dir);
}

void main() {
  vOrigin = iOrigin;
  vDir    = iDir;
  vColor  = iColor;
  vShape  = iShape;

  float range     = iShape.z;
  float cosField  = iShape.y;
  // Half-angle from its cosine; tan gives the radius at unit distance.
  float tanField  = tan(acos(clamp(cosField, -0.9999, 0.9999)));

  // Template: apex at origin, base at z = 1, unit radius. Widen slightly so
  // the proxy always covers the volume the march will sample.
  vec3 p = position;
  float radius = iShape.w + range * tanField * 1.15;
  vec3 local = vec3(p.xy * radius, p.z * range);

  vec3 world = iOrigin + basisFrom(iDir) * local;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const beamFragmentShader = /* glsl */ `
precision highp float;

varying vec3 vOrigin;
varying vec3 vDir;
varying vec3 vColor;
varying vec4 vShape;

uniform vec3  uCameraPos;
uniform vec2  uResolution;
uniform sampler2D uSceneDepth;
uniform float uNear;
uniform float uFar;
uniform float uHaze;     // scattering density, 0..1
uniform float uExposure;
uniform int   uSteps;

// Ray reconstruction inputs.
//
// three.js only injects projectionMatrix and viewMatrix into the VERTEX stage,
// and GLSL ES 1.00 has no inverse(). Both inverses are therefore supplied from
// JS, where three.js already maintains them - which also avoids inverting a
// 4x4 once per fragment.
uniform mat4  uProjectionInverse;
uniform mat4  uCameraWorld;     // camera.matrixWorld
uniform vec3  uViewForward;     // camera -Z in world space, unit

/**
 * Distance along the ray at which the already-rendered scene sits.
 *
 * three.js writes a logarithmic-friendly perspective depth; this is the
 * standard reciprocal unprojection back to a view-space distance.
 */
float sceneDistance(vec2 uv, vec3 rd) {
  float d = texture2D(uSceneDepth, uv).x;
  if (d >= 1.0) return uFar;                     // nothing drawn here
  float ndc = d * 2.0 - 1.0;
  float viewZ = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  // viewZ is measured along the view axis; the ray is oblique, so undo the
  // foreshortening or beams bend away from the centre of the screen.
  return viewZ;
}

void main() {
  vec3 ro = uCameraPos;
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Rebuild the world ray from the camera through this pixel.
  vec4 ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec4 viewPos = uProjectionInverse * ndc;
  viewPos /= viewPos.w;
  vec3 rd = normalize((uCameraWorld * vec4(viewPos.xyz, 0.0)).xyz);

  float cosBeam  = vShape.x;
  float cosField = vShape.y;
  float range    = vShape.z;

  vec3 co = ro - vOrigin;
  float e = dot(co, vDir);          // axial coordinate at t = 0
  float f = dot(rd, vDir);          // axial rate along the ray

  // Clip the ray to the axial slab 0 <= axial <= range.
  float tNear = 0.0;
  float tFar  = 1e9;
  if (abs(f) < 1e-5) {
    if (e < 0.0 || e > range) discard;   // parallel and outside the slab
  } else {
    float ta = (0.0   - e) / f;
    float tb = (range - e) / f;
    tNear = max(tNear, min(ta, tb));
    tFar  = min(tFar,  max(ta, tb));
  }

  // Stop at whatever the scene already drew. sceneDistance measures along the
  // view axis, so undo the obliqueness or beams appear to bend away from the
  // centre of the screen.
  float sceneT = sceneDistance(uv, rd);
  float cosView = max(1e-4, dot(rd, uViewForward));
  tFar = min(tFar, sceneT / cosView);
  tNear = max(tNear, 0.0);
  if (tFar <= tNear) discard;

  int steps = uSteps;
  float dt = (tFar - tNear) / float(steps);

  // Dither the start so banding becomes noise, which reads as haze grain.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  vec3 acc = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    float t = tNear + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    vec3 rel = p - vOrigin;

    float axial = dot(rel, vDir);
    if (axial <= 0.0 || axial > range) continue;

    float dist = max(length(rel), 0.05);
    float cosA = axial / dist;

    // Radial profile: full inside the beam angle, feathering to nothing by
    // the field angle. This is what makes a hard-edged spot look different
    // from a wash without modelling the optics.
    float radial = smoothstep(cosField, cosBeam, cosA);
    if (radial <= 0.0) continue;

    // Inverse-square along the beam.
    float falloff = 1.0 / (dist * dist);

    acc += vColor * radial * falloff * uHaze * dt;
  }

  // BEAM_GAIN turns the physical integral into a viewable range. The integral
  // of 1/d^2 across a few metres of haze is ~0.01, which is black on screen;
  // this is the constant that makes exposure 1.0 the default look rather than
  // a value the user has to hunt for.
  const float BEAM_GAIN = 8.0;
  gl_FragColor = vec4(acc * uExposure * BEAM_GAIN, 1.0);
}
`;

/** Fullscreen pass that blits the opaque scene target to the canvas. */
export const compositeVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const compositeFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBeams;
uniform vec2 uBeamTexel;

void main() {
  vec3 scene = texture2D(uScene, vUv).rgb;

  // Upsample the half-resolution beam buffer with a small cross blur.
  //
  // The raymarch jitters each pixel's start position, which trades banding for
  // noise — necessary, but at 48 steps the residual still reads as speckle
  // rather than haze. Four extra taps at the beam buffer's own texel spacing
  // cost almost nothing here and turn the grain back into smoke.
  vec3 beams = texture2D(uBeams, vUv).rgb * 0.4;
  beams += texture2D(uBeams, vUv + vec2( uBeamTexel.x, 0.0)).rgb * 0.15;
  beams += texture2D(uBeams, vUv + vec2(-uBeamTexel.x, 0.0)).rgb * 0.15;
  beams += texture2D(uBeams, vUv + vec2(0.0,  uBeamTexel.y)).rgb * 0.15;
  beams += texture2D(uBeams, vUv + vec2(0.0, -uBeamTexel.y)).rgb * 0.15;

  // Roll the highlights off instead of clipping them.
  //
  // Beams add, and a rig aimed at one spot stacks a dozen of them. Hard
  // clipping turns every overlap the same flat white and throws away which
  // fixture is which; this knee keeps low levels linear — so a fixture at 40%
  // still reads as dimmer than one at full — while compressing the pile-up.
  beams = beams / (1.0 + beams * 0.55);

  gl_FragColor = vec4(scene + beams, 1.0);
}
`;
