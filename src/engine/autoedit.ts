// The auto-editor: turns analysed clips + an analysed song into a beat-synced
// timeline. Pure function of its inputs so it is easy to test and re-run.

import { STYLES } from "./looks.ts";
import type { Clip, Moment, Pace, Project, Segment, Song, StyleId, TextOverlay, TransitionKind } from "./types.ts";
import { NEUTRAL_ADJUST, uid } from "./types.ts";

export interface DirectorPlan {
  /** Moment ids in the order the shots should play. */
  order: string[];
  labels: Record<string, string>;
  title: string;
  caption: string;
  hashtags: string[];
}

export interface AutoEditOptions {
  style: StyleId;
  pace: Pace;
  /** Target length in seconds; "auto" picks one from the amount of good footage. */
  length: number | "auto";
  order: "story" | "energy";
  hook: boolean;
  songStart: number;
  plan?: DirectorPlan | null;
}

// Target seconds per shot; the nearest power-of-two number of beats wins.
const PACE_SHOT: Record<Pace, number> = { chill: 2.4, balanced: 1.1, hype: 0.6 };

export function autoLength(clips: Clip[]): number {
  const moments = clips.reduce((n, c) => n + (c.analysis?.moments.length ?? 0), 0);
  const est = moments * 1.5;
  if (est <= 9) return 7;
  if (est <= 20) return 15;
  return 30;
}

interface Slot {
  start: number;
  end: number;
  energy: number;
  /** Energy jump compared to the previous slot. */
  rise: number;
  downbeat: boolean;
}

/** Split the reel into shots whose edges sit on beats. */
export function planSlots(song: Song | null, songStart: number, length: number, pace: Pace): Slot[] {
  const period = song && song.bpm > 0 ? 60 / song.bpm : 0.5;
  let grid: number[];
  let energy: number[];
  let downs: Set<number>;
  if (song && song.beats.length > 4) {
    const idx: number[] = [];
    song.beats.forEach((b, i) => {
      if (b >= songStart - 0.02 && b <= songStart + length + period * 0.6) idx.push(i);
    });
    grid = idx.map((i) => song.beats[i] - songStart);
    energy = idx.map((i) => song.beatEnergy[i] ?? 0.5);
    const downTimes = song.downbeats.map((d) => d - songStart);
    downs = new Set(
      grid.map((g, k) => (downTimes.some((d) => Math.abs(d - g) < 0.03) ? k : -1)).filter((k) => k >= 0),
    );
  } else {
    grid = [];
    for (let t = 0; t <= length + 0.26; t += period) grid.push(t);
    energy = grid.map(() => 0.6);
    downs = new Set(grid.map((_, k) => (k % 4 === 0 ? k : -1)).filter((k) => k >= 0));
  }
  if (!grid.length) return [{ start: 0, end: length, energy: 0.5, rise: 0, downbeat: true }];
  if (grid[0] > 0.08) {
    grid.unshift(0);
    energy.unshift(energy[0]);
    downs = new Set([...downs].map((k) => k + 1));
  } else grid[0] = 0;

  // The reel ends on the beat closest to the requested length, a bar line if one is near.
  let endIdx = 0;
  let bestD = Infinity;
  grid.forEach((g, k) => {
    const d = Math.abs(g - length) - (downs.has(k) ? period * 1.01 : 0);
    if (d < bestD && g > 0) {
      bestD = d;
      endIdx = k;
    }
  });
  if (endIdx === 0) endIdx = grid.length - 1;

  const base = Math.max(1, Math.min(8, Math.pow(2, Math.round(Math.log2(PACE_SHOT[pace] / period)))));
  const cuts = [0];
  let i = 0;
  while (i < endIdx) {
    const e = energy[i];
    let n = base;
    // Loud passages cut faster only at the fast pace; quiet ones breathe at any pace.
    if (e > 0.78 && pace === "hype") n = Math.max(1, n / 2);
    if (e < 0.3) n = Math.min(8, n * 2);
    let next = i + n;
    // Prefer to land long shots on a bar line.
    if (n >= 4) {
      for (let k = next; k > i + n / 2; k--) {
        if (downs.has(k)) {
          next = k;
          break;
        }
      }
    }
    // Fold a stub of a final shot into the one before it.
    if (next >= endIdx || endIdx - next < Math.max(1, Math.ceil(n * 0.75))) next = endIdx;
    cuts.push(next);
    i = next;
  }
  const slots: Slot[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    let e = 0;
    for (let j = a; j < b; j++) e += energy[j];
    e /= Math.max(1, b - a);
    slots.push({ start: grid[a], end: grid[b], energy: e, rise: 0, downbeat: downs.has(a) });
  }
  slots.forEach((s, k) => {
    s.rise = k > 0 ? s.energy - slots[k - 1].energy : 0;
  });
  return slots;
}

function clipOf(clips: Clip[], id: string): Clip | undefined {
  return clips.find((c) => c.id === id);
}

/** Choose `n` moments, best first, spreading the picks across clips. */
export function selectMoments(clips: Clip[], n: number, plan?: DirectorPlan | null): Moment[] {
  const all: Moment[] = [];
  for (const c of clips) if (c.analysis) all.push(...c.analysis.moments);
  if (!all.length) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const picks: Moment[] = [];
  if (plan) {
    for (const id of plan.order) {
      const m = byId.get(id);
      if (m && picks.length < n) picks.push(m);
    }
  }
  const uses = new Map<string, number>();
  const used = new Set(picks.map((m) => m.id));
  for (const m of picks) uses.set(m.clipId, (uses.get(m.clipId) ?? 0) + 1);
  while (picks.length < n) {
    let best: Moment | null = null;
    let bestScore = -Infinity;
    for (const m of all) {
      if (used.has(m.id)) continue;
      const quality = clipOf(clips, m.clipId)?.analysis?.quality ?? 0.5;
      const s = m.score * (0.75 + 0.25 * quality) * Math.pow(0.8, uses.get(m.clipId) ?? 0);
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    if (!best) {
      // Ran out of distinct moments: reuse the strongest ones again.
      used.clear();
      if (!all.length) break;
      continue;
    }
    picks.push(best);
    used.add(best.id);
    uses.set(best.clipId, (uses.get(best.clipId) ?? 0) + 1);
  }
  return picks;
}

function orderPicks(picks: Moment[], slots: Slot[], clips: Clip[], opts: AutoEditOptions): Moment[] {
  if (opts.plan) return picks;
  const clipRank = new Map(
    [...clips].sort((a, b) => a.createdAt - b.createdAt).map((c, i) => [c.id, i] as const),
  );
  let ordered: Moment[];
  if (opts.order === "energy") {
    // Busiest shots go where the music is loudest.
    const slotOrder = slots.map((s, i) => [s.energy, i] as const).sort((a, b) => b[0] - a[0]);
    const byPunch = [...picks].sort((a, b) => b.motion * 0.6 + b.score * 0.4 - (a.motion * 0.6 + a.score * 0.4));
    ordered = new Array(picks.length);
    slotOrder.forEach(([, slot], k) => {
      ordered[slot] = byPunch[k];
    });
  } else {
    ordered = [...picks].sort(
      (a, b) => (clipRank.get(a.clipId) ?? 0) - (clipRank.get(b.clipId) ?? 0) || a.t - b.t,
    );
  }
  if (opts.hook && ordered.length > 2) {
    let bi = 0;
    ordered.forEach((m, i) => {
      if (m.score > ordered[bi].score) bi = i;
    });
    const [hook] = ordered.splice(bi, 1);
    ordered.unshift(hook);
  }
  // Avoid the same clip twice in a row when a swap fixes it.
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].clipId !== ordered[i - 1].clipId) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].clipId !== ordered[i - 1].clipId && ordered[j].clipId !== ordered[i + 1]?.clipId) {
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        break;
      }
    }
  }
  return ordered;
}

function pickTransition(style: StyleId, slot: Slot, k: number, barCount: number): TransitionKind {
  if (k === 0) return "cut";
  const def = STYLES[style];
  if (slot.rise > 0.22) return def.rise;
  const len = slot.end - slot.start;
  if (slot.energy < 0.42 && def.calm !== "cut" && len >= 0.9) return def.calm;
  if (slot.downbeat) {
    const t = def.bar[barCount % def.bar.length];
    if (t === "fade" && len < 0.8) return "cut";
    return t;
  }
  return "cut";
}

export function autoEdit(clips: Clip[], song: Song | null, base: Project, opts: AutoEditOptions): Project {
  const ready = clips.filter((c) => c.status === "ready" && c.analysis && c.analysis.moments.length);
  if (!ready.length) return base;
  const length = opts.length === "auto" ? autoLength(ready) : opts.length;
  const songStart = song ? Math.max(0, Math.min(opts.songStart, Math.max(0, song.duration - 1))) : 0;
  const usable = song ? Math.min(length, song.duration - songStart) : length;
  const slots = planSlots(song, songStart, Math.max(2, usable), opts.pace);
  const picks = orderPicks(selectMoments(ready, slots.length, opts.plan), slots, ready, opts);
  const def = STYLES[opts.style];

  const usedOffsets = new Map<string, number>();
  let bars = 0;
  const segments: Segment[] = slots.map((slot, k) => {
    const m = picks[k % picks.length];
    const clip = clipOf(ready, m.clipId)!;
    const d = slot.end - slot.start;
    let speed = 1;
    if (def.slowmo && slot.energy < 0.5 && d >= 1) speed = 0.6;
    let need = d * speed;
    if (clip.duration < need) {
      speed = Math.max(0.5, clip.duration / d);
      need = d * speed;
    }
    // A moment used twice shows a later part of the same moment the second time.
    const seen = usedOffsets.get(m.id) ?? 0;
    usedOffsets.set(m.id, seen + 1);
    let srcIn = m.t - need * 0.45 + seen * need;
    srcIn = Math.max(0, Math.min(srcIn, Math.max(0, clip.duration - need)));
    const transition = pickTransition(opts.style, slot, k, bars);
    if (slot.downbeat && k > 0) bars++;
    return {
      id: uid("s"),
      clipId: clip.id,
      momentId: m.id,
      srcIn,
      duration: d,
      speed,
      transition,
      reframe: null,
      zoom: 1,
    };
  });

  const total = segments.reduce((a, s) => a + s.duration, 0);
  const texts: TextOverlay[] = base.texts.filter((t) => !t.id.startsWith("auto-") && t.start < total);
  const title = opts.plan?.title?.trim();
  if (title) {
    const end = Math.min(total, Math.max(1.8, segments.slice(0, 2).reduce((a, s) => a + s.duration, 0)));
    texts.unshift({
      id: "auto-title",
      text: title,
      start: 0,
      end,
      style: opts.style === "vintage" || opts.style === "cinematic" ? "serif" : "bold",
      anim: "pop",
      y: 0.42,
      size: 0.1,
      color: "#ffffff",
    });
  }

  return {
    ...base,
    look: def.look,
    lookAmount: def.lookAmount,
    adjust: { ...NEUTRAL_ADJUST, ...def.adjust },
    beatPulse: def.beatPulse,
    songId: song?.id ?? null,
    songStart,
    segments,
    texts,
    caption: opts.plan?.caption ?? base.caption,
    hashtags: opts.plan?.hashtags ?? base.hashtags,
  };
}

/** A different good moment to swap into a shot ("Try another take"). */
export function alternativeMoment(clips: Clip[], project: Project, seg: Segment): Moment | null {
  const inUse = new Set(project.segments.map((s) => s.momentId));
  const all: Moment[] = [];
  for (const c of clips) if (c.status === "ready" && c.analysis) all.push(...c.analysis.moments);
  const candidates = all.filter((m) => !inUse.has(m.id) && m.id !== seg.momentId);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  // Rotate through the top few instead of always offering the same one.
  const pool = candidates.slice(0, Math.min(5, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Place a moment into a shot of the given duration. */
export function fitMoment(clip: Clip, m: Moment, duration: number, speed: number): { srcIn: number; speed: number } {
  let need = duration * speed;
  let sp = speed;
  if (clip.duration < need) {
    sp = Math.max(0.5, clip.duration / duration);
    need = duration * sp;
  }
  const srcIn = Math.max(0, Math.min(m.t - need * 0.45, Math.max(0, clip.duration - need)));
  return { srcIn, speed: sp };
}
