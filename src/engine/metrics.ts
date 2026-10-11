// Frame-level measurements for finding the best moments in a clip.
// Works on tiny RGBA thumbnails (about 128 px wide) so a whole clip can be
// scanned in seconds. Pure functions: no DOM, testable in node.

import type { FrameSample, Moment } from "./types.ts";
import { uid } from "./types.ts";

export const GRID = 8;

export interface FrameMetrics {
  luma: Float32Array;
  mean: number;
  std: number;
  /** Mean absolute Laplacian: high = crisp detail, low = blur. */
  sharp: number;
  /** Hasler–Süsstrunk colourfulness on a 0..1 scale. */
  color: number;
  hist: Float32Array;
  /** Detail + saturation per grid cell, used for subject tracking. */
  cells: Float32Array;
}

export function measureFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): FrameMetrics {
  const n = w * h;
  const luma = new Float32Array(n);
  const hist = new Float32Array(16);
  const cells = new Float32Array(GRID * GRID);
  let sum = 0;
  let sum2 = 0;
  let rgS = 0;
  let rgS2 = 0;
  let ybS = 0;
  let ybS2 = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p] / 255;
    const g = rgba[p + 1] / 255;
    const b = rgba[p + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = y;
    sum += y;
    sum2 += y * y;
    hist[Math.min(15, (y * 16) | 0)]++;
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    rgS += rg;
    rgS2 += rg * rg;
    ybS += yb;
    ybS2 += yb * yb;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    const cx = Math.min(GRID - 1, (((i % w) * GRID) / w) | 0);
    const cy = Math.min(GRID - 1, (((i / w) | 0) * GRID) / h | 0);
    cells[cy * GRID + cx] += sat * 0.5;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const mrg = rgS / n;
  const myb = ybS / n;
  const srg = Math.sqrt(Math.max(0, rgS2 / n - mrg * mrg));
  const syb = Math.sqrt(Math.max(0, ybS2 / n - myb * myb));
  const color = Math.sqrt(srg * srg + syb * syb) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);

  let lap = 0;
  let lapN = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w]);
      lap += v;
      lapN++;
      const cx = ((x * GRID) / w) | 0;
      const cy = ((y * GRID) / h) | 0;
      cells[cy * GRID + cx] += v;
    }
  }
  for (let i = 0; i < 16; i++) hist[i] /= n;
  const perCell = n / (GRID * GRID);
  for (let i = 0; i < cells.length; i++) cells[i] /= perCell;
  return { luma, mean, std, sharp: lapN ? lap / lapN : 0, color, hist, cells };
}

/** Mean absolute luma change between two frames, overall and per grid cell. */
export function frameDiff(a: Float32Array, b: Float32Array, w: number, h: number): { motion: number; cells: Float32Array } {
  const cells = new Float32Array(GRID * GRID);
  let s = 0;
  for (let y = 0; y < h; y++) {
    const cy = ((y * GRID) / h) | 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.abs(a[i] - b[i]);
      s += d;
      cells[cy * GRID + (((x * GRID) / w) | 0)] += d;
    }
  }
  const perCell = (w * h) / (GRID * GRID);
  for (let i = 0; i < cells.length; i++) cells[i] /= perCell;
  return { motion: s / (w * h), cells };
}

/** Half the L1 distance between two luma histograms: 0 = same, 1 = disjoint. */
export function histDistance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / 2;
}

/**
 * Where the eye goes: a centre-weighted centroid of detail, colour and
 * movement. Used to keep the subject in frame when cropping 16:9 to 9:16.
 */
export function focusPoint(cells: Float32Array, motion: Float32Array | null): { x: number; y: number } {
  let maxC = 1e-6;
  let maxM = 1e-6;
  for (let i = 0; i < cells.length; i++) {
    maxC = Math.max(maxC, cells[i]);
    if (motion) maxM = Math.max(maxM, motion[i]);
  }
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const i = cy * GRID + cx;
      const px = (cx + 0.5) / GRID;
      const py = (cy + 0.5) / GRID;
      const e = cells[i] / maxC + (motion ? (1.5 * motion[i]) / maxM : 0);
      const prior = Math.exp(-((px - 0.5) ** 2 + (py - 0.5) ** 2) / (2 * 0.3 * 0.3));
      const wgt = e * e * prior;
      sx += px * wgt;
      sy += py * wgt;
      sw += wgt;
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : { x: 0.5, y: 0.5 };
}

export interface RawSample {
  t: number;
  mean: number;
  std: number;
  sharp: number;
  color: number;
  motion: number;
  audio: number | null;
  faces: number;
  fx: number;
  fy: number;
  cut: boolean;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function robustRange(values: number[]): [number, number] {
  if (!values.length) return [0, 1];
  const s = [...values].sort((a, b) => a - b);
  const lo = s[Math.floor((s.length - 1) * 0.1)];
  const hi = s[Math.ceil((s.length - 1) * 0.9)];
  return [lo, Math.max(lo + 1e-6, hi)];
}

/**
 * Turn raw measurements into a 0..1 "would this look good in a reel" score.
 * Half of each feature is absolute (so a sharp clip beats a blurry one) and
 * half is relative to the clip (so every clip still has its own highlights).
 */
export function scoreSamples(raw: RawSample[], duration: number): FrameSample[] {
  if (!raw.length) return [];
  const [mLo, mHi] = robustRange(raw.map((r) => r.motion));
  const [sLo, sHi] = robustRange(raw.map((r) => r.sharp));
  const [cLo, cHi] = robustRange(raw.map((r) => r.color));
  const audios = raw.map((r) => r.audio).filter((v): v is number => v !== null);
  const [aLo, aHi] = robustRange(audios);
  const out: FrameSample[] = raw.map((r) => {
    const sharpAbs = 1 - Math.exp(-r.sharp / 0.045);
    const sharpRel = clamp01((r.sharp - sLo) / (sHi - sLo));
    const sharp = 0.5 * sharpAbs + 0.5 * sharpRel;
    const colorAbs = 1 - Math.exp(-r.color / 0.2);
    const colorRel = clamp01((r.color - cLo) / (cHi - cLo));
    const color = 0.6 * colorAbs + 0.4 * colorRel;
    const exposure = clamp01(1 - Math.pow(Math.abs(r.mean - 0.47) / 0.42, 1.6)) * clamp01(r.std / 0.12);
    const mAbs = r.motion / (r.motion + 0.035);
    const mRel = clamp01((r.motion - mLo) / (mHi - mLo));
    const motion = 0.5 * mAbs + 0.5 * mRel;
    const audio = r.audio === null ? 0.5 : clamp01((r.audio - aLo) / (aHi - aLo));
    // Fast movement only counts when the frame is still crisp; otherwise it is shake.
    const shake = mAbs > 0.6 && sharpAbs < 0.35 ? 0.15 : 0;
    let score =
      0.27 * sharp + 0.17 * exposure + 0.18 * color + 0.2 * motion + 0.12 * audio + 0.06 * clamp01(r.std / 0.25) - shake;
    if (r.faces > 0) score += 0.08 + 0.04 * Math.min(2, r.faces - 1);
    // Camera start/stop wobble at the very edges of a clip.
    const edge = Math.min(r.t, duration - r.t);
    if (edge < 0.4) score *= 0.75 + 0.25 * (edge / 0.4);
    return {
      t: r.t,
      score: clamp01(score),
      sharp,
      motion,
      color,
      exposure,
      audio,
      faces: r.faces,
      fx: r.fx,
      fy: r.fy,
      cut: r.cut,
    };
  });
  // Smooth the framing over time so auto-reframe glides instead of jitters.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i].cut || out[i + 1].cut) continue;
      out[i].fx = 0.25 * out[i - 1].fx + 0.5 * out[i].fx + 0.25 * out[i + 1].fx;
      out[i].fy = 0.25 * out[i - 1].fy + 0.5 * out[i].fy + 0.25 * out[i + 1].fy;
    }
  }
  return out;
}

/** Peaks of the smoothed score, at least `gap` seconds apart, kept inside one scene. */
export function pickMoments(samples: FrameSample[], duration: number, clipId: string): Moment[] {
  if (!samples.length) return [];
  const smooth = samples.map((_, i) => {
    let acc = 0;
    let w = 0;
    for (let k = -2; k <= 2; k++) {
      const v = samples[i + k];
      if (!v) continue;
      const wk = 1 - Math.abs(k) / 3;
      acc += v.score * wk;
      w += wk;
    }
    return acc / w;
  });
  // Montages cut on every beat, so they need many distinct moments per clip.
  const maxMoments = Math.max(1, Math.min(30, Math.round(duration / 1.6)));
  const gap = Math.max(1.2, Math.min(3, duration / 14));
  const order = smooth.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const picked: number[] = [];
  for (const [, i] of order) {
    if (picked.length >= maxMoments) break;
    if (picked.some((j) => Math.abs(samples[j].t - samples[i].t) < gap)) continue;
    picked.push(i);
  }
  const cutTimes = samples.filter((s) => s.cut).map((s) => s.t);
  return picked
    .map((i) => {
      const t = samples[i].t;
      // Stay inside the scene that contains the peak.
      const sceneStart = Math.max(0, ...cutTimes.filter((c) => c <= t));
      const sceneEnd = Math.min(duration, ...cutTimes.filter((c) => c > t));
      const start = Math.max(sceneStart, t - 1.6);
      const end = Math.min(sceneEnd, t + 1.6);
      return {
        id: uid("m"),
        clipId,
        t,
        start,
        end: Math.max(end, Math.min(duration, start + 0.5)),
        score: smooth[i],
        motion: samples[i].motion,
      };
    })
    .sort((a, b) => a.t - b.t);
}

/** Interpolated focus point at time t (for auto-reframe). */
export function focusAt(samples: FrameSample[] | undefined, t: number): { x: number; y: number } {
  if (!samples || !samples.length) return { x: 0.5, y: 0.5 };
  if (t <= samples[0].t) return { x: samples[0].fx, y: samples[0].fy };
  const last = samples[samples.length - 1];
  if (t >= last.t) return { x: last.fx, y: last.fy };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (b.cut) return { x: a.fx, y: a.fy };
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: a.fx + (b.fx - a.fx) * k, y: a.fy + (b.fy - a.fy) * k };
}
