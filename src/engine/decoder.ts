// Frame-accurate decoding of MP4/MOV clips with WebCodecs.
//
// A <video> element has to seek and start playing for every shot, and on a
// phone that takes longer than a one-beat shot lasts: the reel shows frozen or
// black shots. Instead, each shot is decoded ahead of time from its keyframe,
// straight from the file, into small bitmaps at the size it's drawn.

import { readSampleData, videoTrack, type VideoSample, type VideoTrack } from "./mp4.ts";

export interface DecodedFrame {
  /** Presentation time in the clip, seconds. */
  t: number;
  img: ImageBitmap;
}

/** Phones have few hardware decoders: decode one shot at a time. */
let busy: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = busy.then(job, job);
  busy = run.catch(() => undefined);
  return run;
}

export class ClipDecoder {
  /** Picture size after rotation. */
  readonly width: number;
  readonly height: number;
  /** Samples sorted by presentation time, for finding a shot's frames. */
  private shown: { i: number; t: number }[];

  private constructor(
    private readonly file: Blob,
    private readonly track: VideoTrack,
    private readonly config: VideoDecoderConfig,
  ) {
    const turned = track.rotation === 90 || track.rotation === 270;
    this.width = turned ? track.codedHeight : track.codedWidth;
    this.height = turned ? track.codedWidth : track.codedHeight;
    this.shown = track.samples.map((s, i) => ({ i, t: s.t })).sort((a, b) => a.t - b.t);
  }

  /** A decoder for this file, or null when the browser or the file doesn't allow it. */
  static async open(file: Blob): Promise<ClipDecoder | null> {
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;
    const track = await videoTrack(file).catch(() => null);
    if (!track || !track.samples.length) return null;
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      ...(track.description ? { description: track.description } : {}),
    };
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) return null;
    } catch {
      return null;
    }
    return new ClipDecoder(file, track, config);
  }

  /**
   * Every frame shown between t0 and t1 (clip seconds), at most `maxWidth`
   * pixels wide. The first frame is the one on screen at t0.
   */
  frames(t0: number, t1: number, maxWidth: number, signal?: AbortSignal): Promise<DecodedFrame[]> {
    return exclusive(() => this.run(t0, t1, maxWidth, signal));
  }

  private async run(t0: number, t1: number, maxWidth: number, signal?: AbortSignal): Promise<DecodedFrame[]> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const samples = this.track.samples;
    // The frame on screen at t0 is the last one that starts at or before it.
    let lo = 0;
    while (lo + 1 < this.shown.length && this.shown[lo + 1].t <= t0 + 1e-6) lo++;
    let hi = lo;
    while (hi + 1 < this.shown.length && this.shown[hi + 1].t <= t1 + 1e-6) hi++;
    const from = this.shown[lo].t;
    const to = this.shown[hi].t;
    let first = Infinity;
    let last = -1;
    for (let k = lo; k <= hi; k++) {
      first = Math.min(first, this.shown[k].i);
      last = Math.max(last, this.shown[k].i);
    }
    let start = first;
    while (start > 0 && !samples[start].key) start--;
    const feed = samples.slice(start, last + 1);
    const data = await readSampleData(this.file, feed);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const scale = Math.min(1, maxWidth / this.width);
    const w = Math.max(2, Math.round(this.width * scale));
    const h = Math.max(2, Math.round(this.height * scale));
    const pending: Promise<DecodedFrame | null>[] = [];
    let failure: unknown = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const t = frame.timestamp / 1e6;
        if (t < from - 1e-4 || t > to + 1e-4) {
          frame.close();
          return;
        }
        pending.push(
          this.toBitmap(frame, w, h)
            .then((img) => ({ t, img }))
            .catch((e) => {
              failure = e;
              return null;
            })
            .finally(() => frame.close()),
        );
      },
      error: (e) => {
        failure = e;
      },
    });
    try {
      decoder.configure(this.config);
      for (let k = 0; k < feed.length; k++) {
        if (failure) break;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const s: VideoSample = feed[k];
        decoder.decode(
          new EncodedVideoChunk({
            type: k === 0 || s.key ? "key" : "delta",
            timestamp: Math.round(s.t * 1e6),
            duration: Math.round(s.dur * 1e6),
            data: data[k],
          }),
        );
        // Let the decoder catch up instead of queueing a whole GOP at once.
        if (decoder.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      }
      await decoder.flush();
    } finally {
      if (decoder.state !== "closed") decoder.close();
    }
    const out = (await Promise.all(pending)).filter((f): f is DecodedFrame => !!f).sort((a, b) => a.t - b.t);
    if (!out.length) throw failure ?? new Error("No frames decoded");
    return out;
  }

  private async toBitmap(frame: VideoFrame, w: number, h: number): Promise<ImageBitmap> {
    const rot = this.track.rotation;
    if (rot === 0) {
      try {
        return await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
      } catch {
        // Some browsers can't make a bitmap straight from a VideoFrame: draw it instead.
      }
    }
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const turned = rot === 90 || rot === 270;
    const dw = turned ? h : w;
    const dh = turned ? w : h;
    ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    return await createImageBitmap(c);
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
