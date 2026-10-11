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

export function autoLength(clips: Clip[]): number {
  const moments = clips.reduce((n, c) => n + (c.analysis?.moments.length ?? 0), 0);
  if (moments < 6) return 9;
  if (moments < 14) return 12;
  return 15;
}

export interface Slot {
  start: number;
  end: number;
  energy: number;
  /** Energy jump compared to the previous slot. */
  rise: number;
  downbeat: boolean;
  /** This shot starts where the song kicks in (the drop). */
  drop: boolean;
  /** Length in beats. */
  beats: number;
}

// Shot lengths in beats for the relaxed "story" pace, cycled through. Matches
// the road-trip reference: mostly two beats, some longer holds, a few quick ones.
const STORY = [3, 2, 4, 2, 1, 1, 2, 4, 2, 3, 2, 2];

/**
 * Split the reel into shots whose edges sit on beats. At the "beat" pace every
 * beat is a cut, except a short hold on the opening shot, on the drop and on
 * the final shot, which is how the reference montages breathe.
 */
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
  if (!grid.length) return [{ start: 0, end: length, energy: 0.5, rise: 0, downbeat: true, drop: false, beats: 1 }];
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

  // The drop: the bar line where the next bars get clearly louder than the last ones.
  let dropIdx = -1;
  let bestRise = 0.15;
  for (const k of downs) {
    if (k < 4 || k > endIdx - 4) continue;
    const mean = (a: number, b: number) => {
      let s = 0;
      for (let j = a; j < b; j++) s += energy[j];
      return s / Math.max(1, b - a);
    };
    const rise = mean(k, Math.min(endIdx, k + 8)) - mean(Math.max(0, k - 8), k);
    if (rise > bestRise) {
      bestRise = rise;
      dropIdx = k;
    }
  }

  // Faster than ~200 BPM the beat is too quick to cut on; double up.
  const fast = period < 0.3 ? 2 : 1;
  const cuts = [0];
  let i = 0;
  let shot = 0;
  while (i < endIdx) {
    let n: number;
    if (pace === "story") n = STORY[shot % STORY.length] * fast;
    else {
      n = (pace === "two" ? 2 : 1) * fast;
      if (shot === 0 || i === dropIdx) n *= 2;
    }
    let next = i + n;
    // Never cut just before the drop: land on it so the drop starts a new shot.
    if (dropIdx > i && dropIdx < next) next = dropIdx;
    // The last shot holds for at least two beats.
    if (next >= endIdx || endIdx - next < 2 * fast) next = endIdx;
    cuts.push(next);
    i = next;
    shot++;
  }
  const slots: Slot[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    let e = 0;
    for (let j = a; j < b; j++) e += energy[j];
    e /= Math.max(1, b - a);
    slots.push({ start: grid[a], end: grid[b], energy: e, rise: 0, downbeat: downs.has(a), drop: a === dropIdx, beats: b - a });
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
  // Moments picked by hand always make the cut.
  for (const m of all) if (m.manual && picks.length < n && !picks.includes(m)) picks.push(m);
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

const POV_LINES = [
  "POV: the summer you'll talk about forever",
  "POV: you said yes to every plan",
  "POV: a week you never want to end",
  "POV: you and your favourite people",
];

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
  const segments: Segment[] = [];
  let pick = 0;
  slots.forEach((slot, k) => {
    const d = slot.end - slot.start;
    const prev = segments[segments.length - 1];
    // Punch-in: keep rolling the previous take but cut in tighter on the beat.
    if (def.punchIn > 0 && prev && k % def.punchIn === 0 && prev.zoom === 1 && !slot.drop && slot.beats <= 2) {
      const clip = clipOf(ready, prev.clipId);
      const srcIn = prev.srcIn + prev.duration * prev.speed;
      if (clip && srcIn + d * prev.speed <= clip.duration) {
        segments.push({ ...prev, id: uid("s"), srcIn, duration: d, transition: "cut", zoom: 1.3 });
        return;
      }
    }
    const m = picks[pick++ % picks.length];
    const clip = clipOf(ready, m.clipId)!;
    let speed = 1;
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
    const transition: TransitionKind = k > 0 && slot.drop && def.smear ? "smear" : "cut";
    segments.push({
      id: uid("s"),
      clipId: clip.id,
      momentId: m.id,
      srcIn,
      duration: d,
      speed,
      transition,
      reframe: null,
      zoom: 1,
    });
  });

  const total = segments.reduce((a, s) => a + s.duration, 0);
  const texts: TextOverlay[] = base.texts.filter((t) => !t.id.startsWith("auto-") && t.start < total);
  if (def.caption) {
    const line = opts.plan?.title?.trim() || POV_LINES[Math.floor((songStart * 7 + segments.length) % POV_LINES.length)];
    texts.unshift(captionText(line, total));
  }

  return {
    ...base,
    frame: def.frame,
    look: def.look,
    lookAmount: def.lookAmount,
    adjust: { ...NEUTRAL_ADJUST, ...def.adjust },
    beatPulse: 0,
    songId: song?.id ?? null,
    songStart,
    segments,
    texts,
    caption: opts.plan?.caption ?? base.caption,
    hashtags: opts.plan?.hashtags ?? base.hashtags,
  };
}

/** The small serif line that sits in the black space above the picture. */
export function captionText(text: string, total: number, id = "auto-caption"): TextOverlay {
  return { id, text, start: 0, end: total, style: "caption", anim: "none", place: "above", y: 0.2, size: 0.042, color: "#ffffff" };
}

type Content = Pick<Segment, "clipId" | "momentId" | "srcIn" | "speed" | "reframe" | "zoom"> & { duration: number };

/** Re-fit a shot's footage to a new length, keeping the same moment centred. */
export function refit(c: Content, clip: Clip | undefined, duration: number): Pick<Segment, "srcIn" | "speed"> {
  const dur = clip?.duration ?? Infinity;
  let speed = c.speed;
  if (dur < duration * speed) speed = Math.max(0.5, dur / duration);
  const center = c.srcIn + (c.duration * c.speed) / 2;
  const need = duration * speed;
  const srcIn = Math.max(0, Math.min(center - need / 2, Math.max(0, dur - need)));
  return { srcIn, speed };
}

/**
 * Move a shot's footage to another position while the beat slots stay put:
 * the rhythm (holds on the intro, the drop and the end) belongs to the music,
 * so only the pictures change places.
 */
export function moveContent(segments: Segment[], from: number, to: number, clips: Clip[]): Segment[] {
  if (from === to || from < 0 || from >= segments.length) return segments;
  const contents: Content[] = segments.map((s) => ({ clipId: s.clipId, momentId: s.momentId, srcIn: s.srcIn, speed: s.speed, reframe: s.reframe, zoom: s.zoom, duration: s.duration }));
  const [c] = contents.splice(from, 1);
  contents.splice(Math.max(0, Math.min(contents.length, to)), 0, c);
  return segments.map((slot, i) => {
    const ct = contents[i];
    const clip = clips.find((x) => x.id === ct.clipId);
    return { ...slot, clipId: ct.clipId, momentId: ct.momentId, reframe: ct.reframe, zoom: ct.zoom, ...refit(ct, clip, slot.duration) };
  });
}

/**
 * Cut the reel again to (new) music while keeping the order of shots the
 * viewer arranged. Extra slots are filled with unused moments, extra shots drop off.
 */
export function retime(clips: Clip[], song: Song | null, base: Project, opts: AutoEditOptions): Project {
  const ready = clips.filter((c) => c.status === "ready" && c.analysis && c.analysis.moments.length);
  if (!ready.length || !base.segments.length) return autoEdit(clips, song, base, opts);
  const length = opts.length === "auto" ? Math.max(autoLength(ready), Math.round(base.segments.reduce((a, s) => a + s.duration, 0))) : opts.length;
  const songStart = song ? Math.max(0, Math.min(opts.songStart, Math.max(0, song.duration - 1))) : 0;
  const usable = song ? Math.min(length, song.duration - songStart) : length;
  const slots = planSlots(song, songStart, Math.max(2, usable), opts.pace);
  const used = new Set(base.segments.map((s) => s.momentId));
  const spare = selectMoments(ready, slots.length + used.size).filter((m) => !used.has(m.id));
  const segments: Segment[] = slots.map((slot, k) => {
    const d = slot.end - slot.start;
    const old = base.segments[k];
    if (old) {
      const clip = ready.find((c) => c.id === old.clipId);
      return { ...old, id: uid("s"), duration: d, transition: k === 0 ? "cut" : old.transition, ...refit(old, clip, d) };
    }
    const m = spare[(k - base.segments.length) % Math.max(1, spare.length)] ?? selectMoments(ready, 1)[0];
    const clip = ready.find((c) => c.id === m.clipId)!;
    return { id: uid("s"), clipId: clip.id, momentId: m.id, ...fitMoment(clip, m, d, 1), duration: d, transition: "cut", reframe: null, zoom: 1 };
  });
  const total = segments.reduce((a, s) => a + s.duration, 0);
  const texts = base.texts
    .filter((t) => t.start < total)
    .map((t) => (t.id.startsWith("auto-") || t.end > total ? { ...t, end: t.id.startsWith("auto-") ? total : Math.min(t.end, total) } : t));
  return { ...base, songId: song?.id ?? null, songStart, segments, texts };
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
