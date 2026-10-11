// Scans a clip frame by frame (on tiny thumbnails) and finds its best moments.

import { drawDemo, DEMO_H, DEMO_W, makeDemoCanvas } from "./demo.ts";
import { focusPoint, frameDiff, histDistance, measureFrame, pickMoments, scoreSamples, type FrameMetrics, type RawSample } from "./metrics.ts";
import type { ClipAnalysis, DemoScene } from "./types.ts";

export interface FrameGrabber {
  width: number;
  height: number;
  duration: number;
  grab(t: number): Promise<CanvasImageSource>;
  dispose(): void;
}

function once(el: HTMLElement, ev: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener(ev, onEv);
      clearTimeout(timer);
      resolve(ok);
    };
    const onEv = () => finish(true);
    el.addEventListener(ev, onEv);
    const timer = setTimeout(() => finish(false), timeout);
  });
}

export async function videoGrabber(url: string): Promise<FrameGrabber> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.setAttribute("playsinline", "");
  const meta = once(v, "loadeddata", 20000);
  const failed = new Promise<boolean>((resolve) => v.addEventListener("error", () => resolve(false), { once: true }));
  v.src = url;
  const ok = await Promise.race([meta, failed]);
  if (!ok || !v.videoWidth) {
    v.removeAttribute("src");
    v.load();
    throw new Error("This browser can't play this video. Try an MP4 (H.264) export of it.");
  }
  // Some browsers only paint seeked frames after the element has played once.
  try {
    await v.play();
    v.pause();
  } catch {
    // Autoplay refused; seeking still works in most browsers.
  }
  return {
    width: v.videoWidth,
    height: v.videoHeight,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    async grab(t: number) {
      const target = Math.max(0, Math.min(t, v.duration - 0.05));
      if (Math.abs(v.currentTime - target) > 0.001) {
        const seeked = once(v, "seeked", 3000);
        v.currentTime = target;
        await seeked;
      }
      return v;
    },
    dispose() {
      v.pause();
      v.removeAttribute("src");
      v.load();
    },
  };
}

export function demoGrabber(scene: DemoScene, duration: number): FrameGrabber {
  const c = makeDemoCanvas();
  const ctx = c.getContext("2d")!;
  return {
    width: DEMO_W,
    height: DEMO_H,
    duration,
    async grab(t: number) {
      drawDemo(ctx, scene, t);
      return c;
    },
    dispose() {},
  };
}

export async function snapshot(g: FrameGrabber, t: number, width = 320, quality = 0.74): Promise<string> {
  const src = await g.grab(t);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.round((width * g.height) / Math.max(1, g.width));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

interface FaceDetectorLike {
  detect(src: CanvasImageSource): Promise<{ boundingBox: DOMRectReadOnly }[]>;
}

function faceDetector(): FaceDetectorLike | null {
  const Ctor = (window as unknown as { FaceDetector?: new (o: object) => FaceDetectorLike }).FaceDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ fastMode: true, maxDetectedFaces: 5 });
  } catch {
    return null;
  }
}

export async function analyzeClip(
  clipId: string,
  g: FrameGrabber,
  loudness: Float32Array | null,
  onProgress: (p: number) => void,
): Promise<ClipAnalysis> {
  const duration = g.duration;
  const step = Math.max(0.25, Math.min(2, duration / 160));
  const landscape = g.width >= g.height;
  const sw = landscape ? 128 : Math.max(16, Math.round((128 * g.width) / g.height));
  const sh = landscape ? Math.max(16, Math.round((128 * g.height) / g.width)) : 128;
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const faces = faceDetector();
  const faceCanvas = faces ? document.createElement("canvas") : null;
  if (faceCanvas) {
    faceCanvas.width = landscape ? 320 : Math.round((320 * g.width) / g.height);
    faceCanvas.height = landscape ? Math.round((320 * g.height) / g.width) : 320;
  }

  const raw: RawSample[] = [];
  let prev: FrameMetrics | null = null;
  const count = Math.max(1, Math.floor(duration / step));
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (i + 0.5) * step);
    const src = await g.grab(t);
    ctx.drawImage(src, 0, 0, sw, sh);
    const m = measureFrame(ctx.getImageData(0, 0, sw, sh).data, sw, sh);
    const cut = prev ? histDistance(prev.hist, m.hist) > 0.38 : false;
    const diff = prev && !cut ? frameDiff(prev.luma, m.luma, sw, sh) : null;
    const focus = focusPoint(m.cells, diff?.cells ?? null);
    let faceCount = 0;
    if (faces && faceCanvas && i % 2 === 0) {
      try {
        const fctx = faceCanvas.getContext("2d")!;
        fctx.drawImage(src, 0, 0, faceCanvas.width, faceCanvas.height);
        const found = await faces.detect(faceCanvas);
        faceCount = found.length;
        if (found.length) {
          const b = found.reduce((a, f) => (f.boundingBox.width > a.boundingBox.width ? f : a)).boundingBox;
          focus.x = (b.x + b.width / 2) / faceCanvas.width;
          focus.y = (b.y + b.height / 2) / faceCanvas.height;
        }
      } catch {
        // Face detection is a bonus; ignore failures.
      }
    }
    let audio: number | null = null;
    if (loudness && loudness.length) {
      const a = Math.max(0, Math.floor((t - step / 2) * 10));
      const b = Math.min(loudness.length - 1, Math.ceil((t + step / 2) * 10));
      audio = -Infinity;
      for (let k = a; k <= b; k++) audio = Math.max(audio, loudness[k]);
      if (!Number.isFinite(audio)) audio = null;
    }
    raw.push({
      t,
      mean: m.mean,
      std: m.std,
      sharp: m.sharp,
      color: m.color,
      motion: diff ? diff.motion * Math.sqrt(0.5 / step) : prev ? 0.02 : 0,
      audio,
      faces: faceCount,
      fx: focus.x,
      fy: focus.y,
      cut,
    });
    prev = m;
    onProgress((0.85 * (i + 1)) / count);
  }
  // The first sample has no motion reference; borrow its neighbour's.
  if (raw.length > 1) raw[0].motion = raw[1].motion;
  const samples = scoreSamples(raw, duration);
  const moments = pickMoments(samples, duration, clipId);
  for (let i = 0; i < moments.length; i++) {
    moments[i].thumb = await snapshot(g, moments[i].t, 240, 0.7);
    onProgress(0.85 + (0.15 * (i + 1)) / moments.length);
  }
  const top = [...moments].sort((a, b) => b.score - a.score).slice(0, 3);
  const quality = top.length ? top.reduce((a, m) => a + m.score, 0) / top.length : 0;
  return { step, samples, moments, quality };
}
