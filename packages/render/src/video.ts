/**
 * Video on the LED walls.
 *
 * The design decision that makes this cheap, and that everything else follows
 * from: **frames are decimated to something near a wall's own pixel count
 * before they are sampled, never after.** A Generic LED Wall 10x10 is a
 * hundred pixels. Sampling a 1920x1080 frame to fill it reads 0.005% of the
 * data and pays for all of it — and on the desktop build, where a future NDI
 * or Syphon source hands frames to the webview across an IPC boundary, paying
 * for all of it is the thing that would make the feature impossible. A frame
 * the size of a thumbnail is a few KB and costs nothing to move.
 *
 * So a source's job is to produce a *small* frame. `ElementVideoSource` does
 * that with a canvas the browser is already scaling into; a native source would
 * do it in Rust before the bytes ever left it. Either way the sampler below is
 * the same code.
 */

import type { PixelUv } from '@simplevis/core';

/** How wide a decimated frame is. See the note above about why it is small. */
const FRAME_WIDTH = 128;

/** One decimated frame. */
export interface WallFrame {
  readonly width: number;
  readonly height: number;
  /**
   * RGBA bytes exactly as `ImageData.data` gives them: stride 4, row-major,
   * top-left origin, **sRGB-encoded**. The encoding matters — see `sampleWall`.
   */
  readonly data: Uint8ClampedArray;
}

/** Anything that can hand the renderer a frame. */
export interface WallVideoSource {
  /** Shown in the UI, e.g. a filename or the captured window's title. */
  readonly label: string;
  /** The newest frame, or `null` before the first one has arrived. */
  frame(): WallFrame | null;
  dispose(): void;
}

/**
 * sRGB byte to linear float.
 *
 * A lookup table because it is called three times per lit pixel per frame, and
 * because the alternative is worse than slow: `state.color` reaches three.js
 * through `Color.setRGB`, which treats its arguments as **linear** working
 * space. Handing it sRGB bytes straight from a canvas divided by 255 makes
 * every video wall visibly washed out — pale, flat, and wrong in a way that is
 * easy to mistake for the exposure control.
 */
const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/** Mutable RGB, reused so sampling allocates nothing on the hot path. */
export interface SampledColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Nearest-neighbour sample of a frame at a pixel's UV, written into `out`.
 *
 * Nearest rather than bilinear on purpose. The destination is an LED pixel —
 * a physically discrete emitter — so filtering between neighbouring source
 * pixels would invent detail the wall cannot show, and blur the hard edges
 * that are the whole reason content is authored for a wall's native grid.
 */
export function sampleWall(frame: WallFrame, uv: PixelUv, out: SampledColor): SampledColor {
  const x = Math.min(frame.width - 1, Math.max(0, Math.round(uv.u * (frame.width - 1))));
  const y = Math.min(frame.height - 1, Math.max(0, Math.round(uv.v * (frame.height - 1))));
  const i = (y * frame.width + x) * 4;
  out.r = SRGB_TO_LINEAR[frame.data[i]];
  out.g = SRGB_TO_LINEAR[frame.data[i + 1]];
  out.b = SRGB_TO_LINEAR[frame.data[i + 2]];
  return out;
}

/**
 * A source backed by an `HTMLVideoElement` — a file, or a `MediaStream` from
 * screen capture or a capture card.
 *
 * This is the browser-native half of the feature, and it is the half that
 * works in **both** builds. NDI and Syphon cannot exist in a tab for exactly
 * the reason Art-Net cannot: one is UDP with mDNS discovery, the other is
 * macOS inter-process texture sharing, and a browser has neither. A dropped
 * file and `getDisplayMedia` have no such problem.
 */
export class ElementVideoSource implements WallVideoSource {
  readonly label: string;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly stream: MediaStream | null;
  private readonly objectUrl: string | null;
  private cached: WallFrame | null = null;
  private disposed = false;

  private constructor(
    label: string,
    video: HTMLVideoElement,
    stream: MediaStream | null,
    objectUrl: string | null,
  ) {
    this.label = label;
    this.video = video;
    this.stream = stream;
    this.objectUrl = objectUrl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = Math.round(FRAME_WIDTH * 9 / 16);
    // `willReadFrequently` is not a micro-optimisation here: without it the
    // canvas lives on the GPU and every `getImageData` is a pipeline stall, so
    // a readback once per frame costs far more than the drawing did.
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** Play a local file. The user's file never leaves the page. */
  static fromFile(file: File): ElementVideoSource {
    const url = URL.createObjectURL(file);
    const video = ElementVideoSource.element();
    video.loop = true;
    video.src = url;
    void video.play().catch(() => {
      /* Autoplay refused; the element stays paused and frame() returns null. */
    });
    return new ElementVideoSource(file.name, video, null, url);
  }

  /** Play a live stream — screen capture, a window, or a capture card. */
  static fromStream(label: string, stream: MediaStream): ElementVideoSource {
    const video = ElementVideoSource.element();
    video.srcObject = stream;
    void video.play().catch(() => {});
    return new ElementVideoSource(label, video, stream, null);
  }

  private static element(): HTMLVideoElement {
    const video = document.createElement('video');
    // Muted and inline, or the browser refuses to play without a gesture and
    // the wall stays black with nothing to say why.
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    return video;
  }

  frame(): WallFrame | null {
    if (this.disposed || !this.context) return null;
    // HAVE_CURRENT_DATA. Drawing before this throws in some browsers and draws
    // a black frame in others; both look like a broken feed.
    if (this.video.readyState < 2) return null;

    // Match the decimated frame to the source's aspect the first time real
    // dimensions are known, so content is not stretched before it is sampled.
    const aspect = this.video.videoHeight / (this.video.videoWidth || 1);
    const height = Math.max(1, Math.round(FRAME_WIDTH * (aspect || 0.5625)));
    if (height !== this.canvas.height) {
      this.canvas.height = height;
      this.cached = null;
    }

    this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const image = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.cached = { width: image.width, height: image.height, data: image.data };
    return this.cached;
  }

  dispose(): void {
    this.disposed = true;
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.cached = null;
  }
}
