// Timeline arithmetic shared by the player, the exporter and the UI.

import type { Segment, Song, TransitionKind } from "./types.ts";

/** How long each transition takes, seconds. Centred on the cut. */
export const TRANSITION_LEN: Record<TransitionKind, number> = {
  cut: 0,
  fade: 0.5,
  flash: 0.26,
  smear: 0.3,
};

export const TRANSITION_LABEL: Record<TransitionKind, string> = {
  cut: "Cut",
  fade: "Dissolve",
  flash: "Flash",
  smear: "Blur flash",
};

export function segmentStarts(segs: Segment[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of segs) {
    out.push(t);
    t += s.duration;
  }
  return out;
}

export function totalDuration(segs: Segment[]): number {
  let t = 0;
  for (const s of segs) t += s.duration;
  return t;
}

export function indexAt(starts: number[], segs: Segment[], t: number): number {
  if (!segs.length) return -1;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Transition length into shot i, limited so it never eats more than half of either shot. */
export function transitionLen(segs: Segment[], i: number): number {
  if (i <= 0 || i >= segs.length) return 0;
  const base = TRANSITION_LEN[segs[i].transition];
  return Math.min(base, segs[i].duration * 0.5, segs[i - 1].duration * 0.5);
}

/** Source-clip time shown for shot `seg` (which starts at `start`) at timeline time t. */
export function sourceTime(seg: Segment, start: number, t: number): number {
  return seg.srcIn + (t - start) * seg.speed;
}

export interface Layer {
  index: number;
  /** 0..1 opacity for dissolves. */
  weight: number;
}

/**
 * Which shots are visible at time t. Usually one; two during a dissolve,
 * where the outgoing shot keeps playing past its end and the incoming one
 * starts early.
 */
export function layersAt(segs: Segment[], starts: number[], t: number): Layer[] {
  const i = indexAt(starts, segs, t);
  if (i < 0) return [];
  const start = starts[i];
  const end = start + segs[i].duration;
  const next = segs[i + 1];
  if (next && next.transition === "fade") {
    const len = transitionLen(segs, i + 1);
    if (len > 0 && t > end - len / 2) {
      const a = (t - (end - len / 2)) / len;
      return [
        { index: i, weight: 1 },
        { index: i + 1, weight: a },
      ];
    }
  }
  if (segs[i].transition === "fade") {
    const len = transitionLen(segs, i);
    if (len > 0 && t < start + len / 2) {
      const a = (t - (start - len / 2)) / len;
      return [
        { index: i - 1, weight: 1 },
        { index: i, weight: a },
      ];
    }
  }
  return [{ index: i, weight: 1 }];
}

/** Beat times of the song mapped onto the timeline (0 = start of the reel). */
export function timelineBeats(song: Song | null, songStart: number, length: number): number[] {
  if (!song || !song.beats.length) {
    const out: number[] = [];
    for (let t = 0; t <= length + 0.001; t += 0.5) out.push(t);
    return out;
  }
  return song.beats.map((b) => b - songStart).filter((b) => b >= -0.001 && b <= length + 0.001);
}

export function timelineDownbeats(song: Song | null, songStart: number, length: number): number[] {
  if (!song || !song.downbeats.length) {
    const out: number[] = [];
    for (let t = 0; t <= length + 0.001; t += 2) out.push(t);
    return out;
  }
  return song.downbeats.map((b) => b - songStart).filter((b) => b >= -0.001 && b <= length + 0.001);
}

export function nearest(values: number[], t: number): number {
  let best = t;
  let bd = Infinity;
  for (const v of values) {
    const d = Math.abs(v - t);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

export function formatTime(t: number, withHundredths = true): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const hs = Math.floor((s * 100) % 100);
  const base = `${m}:${sec.toString().padStart(2, "0")}`;
  return withHundredths ? `${base}.${hs.toString().padStart(2, "0")}` : base;
}
