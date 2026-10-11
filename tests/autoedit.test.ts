import { test } from "node:test";
import assert from "node:assert/strict";
import { autoEdit, planSlots, selectMoments } from "../src/engine/autoedit.ts";
import { pickMoments, scoreSamples, type RawSample } from "../src/engine/metrics.ts";
import { emptyProject, type Clip, type Song } from "../src/engine/types.ts";

function fakeClip(id: string, duration: number, peakAt: number, createdAt: number): Clip {
  const raw: RawSample[] = [];
  for (let t = 0; t <= duration; t += 0.5) {
    const near = Math.exp(-((t - peakAt) ** 2) / 2);
    raw.push({ t, mean: 0.45, std: 0.2, sharp: 0.02 + 0.06 * near, color: 0.1 + 0.2 * near, motion: 0.01 + 0.04 * near, audio: null, faces: 0, fx: 0.5, fy: 0.5, cut: false });
  }
  const samples = scoreSamples(raw, duration);
  const moments = pickMoments(samples, duration, id);
  return { id, name: id, kind: "demo", duration, width: 1920, height: 1080, thumb: "", hue: 0, createdAt, hasAudio: false, status: "ready", progress: 1, analysis: { step: 0.5, samples, moments, quality: 0.6 } };
}

function song(bpm: number, seconds: number): Song {
  const p = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0.2; t < seconds; t += p) beats.push(t);
  return { id: "song", name: "s", source: "demo", duration: seconds, bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatEnergy: beats.map((_, i) => (i > beats.length / 2 ? 0.9 : 0.4)), peaks: [] };
}

test("moments land on the clip's peak", () => {
  const c = fakeClip("a", 20, 12, 0);
  const best = [...c.analysis!.moments].sort((x, y) => y.score - x.score)[0];
  assert.ok(Math.abs(best.t - 12) <= 1, `best moment at ${best.t}`);
});

test("every cut sits on a beat and the reel matches the requested length", () => {
  const s = song(120, 60);
  const clips = [fakeClip("a", 20, 5, 1), fakeClip("b", 15, 9, 2), fakeClip("c", 30, 20, 3)];
  const p = autoEdit(clips, s, emptyProject(), { style: "clean", pace: "balanced", length: 15, order: "story", hook: true, songStart: s.downbeats[2] });
  assert.ok(p.segments.length >= 6, `${p.segments.length} shots`);
  let t = p.songStart;
  for (const seg of p.segments) {
    t += seg.duration;
    const off = Math.min(...s.beats.map((b) => Math.abs(b - t)));
    assert.ok(off < 0.002, `cut ${t} is ${off}s off the beat`);
    const clip = clips.find((c) => c.id === seg.clipId)!;
    assert.ok(seg.srcIn >= 0 && seg.srcIn + seg.duration * seg.speed <= clip.duration + 1e-6, "shot inside its clip");
  }
  const total = p.segments.reduce((a, x) => a + x.duration, 0);
  assert.ok(Math.abs(total - 15) <= 1.01, `total ${total}`);
});

test("hype pace cuts faster than chill", () => {
  const s = song(120, 60);
  const fast = planSlots(s, 0.2, 15, "hype").length;
  const slow = planSlots(s, 0.2, 15, "chill").length;
  assert.ok(fast > slow * 2, `${fast} vs ${slow}`);
});

test("selection spreads across clips", () => {
  const clips = [fakeClip("a", 40, 5, 1), fakeClip("b", 40, 9, 2), fakeClip("c", 40, 20, 3)];
  const picks = selectMoments(clips, 6);
  const per = new Map<string, number>();
  for (const m of picks) per.set(m.clipId, (per.get(m.clipId) ?? 0) + 1);
  assert.equal(per.size, 3);
});

test("works without music on a 120 BPM grid", () => {
  const clips = [fakeClip("a", 10, 5, 1)];
  const p = autoEdit(clips, null, emptyProject(), { style: "hype", pace: "hype", length: 7, order: "energy", hook: true, songStart: 0 });
  assert.ok(p.segments.length > 3);
  for (const seg of p.segments) assert.ok(Math.abs(seg.duration / 0.5 - Math.round(seg.duration / 0.5)) < 1e-6);
});
