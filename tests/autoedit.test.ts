import { test } from "node:test";
import assert from "node:assert/strict";
import { autoEdit, moveContent, planSlots, retime, selectMoments } from "../src/engine/autoedit.ts";
import { pickMoments, scoreSamples, type RawSample } from "../src/engine/metrics.ts";
import { bandRect, emptyProject, type Clip, type Song } from "../src/engine/types.ts";

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
  const p = autoEdit(clips, s, emptyProject(), { style: "cinema", pace: "beat", length: 15, order: "story", hook: true, songStart: s.downbeats[2] });
  assert.ok(p.segments.length >= 20, `${p.segments.length} shots`);
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

test("every-beat pace cuts faster than the relaxed pace", () => {
  const s = song(120, 60);
  const fast = planSlots(s, 0.2, 15, "beat").length;
  const slow = planSlots(s, 0.2, 15, "story").length;
  assert.ok(fast > slow * 1.8, `${fast} vs ${slow}`);
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
  const p = autoEdit(clips, null, emptyProject(), { style: "cinema", pace: "beat", length: 7, order: "energy", hook: true, songStart: 0 });
  assert.ok(p.segments.length > 3);
  for (const seg of p.segments) assert.ok(Math.abs(seg.duration / 0.5 - Math.round(seg.duration / 0.5)) < 1e-6);
});

test("every-beat montage: one beat per shot, holding the opening, the drop and the end", () => {
  const s = song(115, 60); // energy jumps half way through: that bar is the drop
  const start = s.downbeats.find((d) => d > 22)!;
  const slots = planSlots(s, start, 15, "beat");
  const beats = slots.map((x) => x.beats);
  assert.equal(beats[0], 2, "opening shot holds two beats");
  assert.ok(beats[beats.length - 1] >= 2, "last shot holds");
  const single = beats.filter((b) => b === 1).length;
  assert.ok(single / beats.length > 0.75, `${single}/${beats.length} single-beat shots`);
  const drop = slots.find((x) => x.drop);
  assert.ok(drop, "found the drop");
  assert.equal(drop!.beats, 2, "the drop shot holds two beats");
});

test("cinema style: blur-flash into the drop, punch-ins continue the same take", () => {
  const s = song(115, 60);
  const clips = [fakeClip("a", 40, 5, 1), fakeClip("b", 40, 9, 2), fakeClip("c", 40, 20, 3)];
  const p = autoEdit(clips, s, emptyProject(), { style: "cinema", pace: "beat", length: 15, order: "story", hook: true, songStart: s.downbeats.find((d) => d > 22)! });
  assert.equal(p.frame, "16:9");
  assert.equal(p.texts.length, 0, "no on-screen text in the cinema style");
  assert.equal(p.segments.filter((x) => x.transition === "smear").length, 1, "exactly one blur flash");
  assert.ok(p.segments.every((x) => x.transition === "cut" || x.transition === "smear"), "everything else is a hard cut");
  const punch = p.segments.findIndex((x) => x.zoom > 1);
  assert.ok(punch > 0, "has a punch-in");
  const a = p.segments[punch - 1];
  const b = p.segments[punch];
  assert.equal(b.clipId, a.clipId);
  assert.ok(Math.abs(b.srcIn - (a.srcIn + a.duration * a.speed)) < 1e-6, "punch-in picks up where the take left off");
});

test("road trip style: 4:3 frame, relaxed cuts and a POV caption above the picture", () => {
  const s = song(123, 60);
  const clips = [fakeClip("a", 40, 5, 1), fakeClip("b", 40, 9, 2)];
  const p = autoEdit(clips, s, emptyProject(), { style: "roadtrip", pace: "story", length: 15, order: "story", hook: true, songStart: s.downbeats[2] });
  assert.equal(p.frame, "4:3");
  const cap = p.texts.find((t) => t.place === "above");
  assert.ok(cap && cap.text.startsWith("POV:"), "has a POV caption");
  const total = p.segments.reduce((x, y) => x + y.duration, 0);
  assert.ok(cap!.start === 0 && Math.abs(cap!.end - total) < 1e-6, "caption stays for the whole reel");
  const mean = total / p.segments.length;
  assert.ok(mean > 0.8, `mean shot ${mean.toFixed(2)}s`);
});

test("film frame band sits slightly above centre in the 9:16 Reel", () => {
  assert.deepEqual(bandRect("16:9", 1080, 1920), [0, 560, 1080, 608]);
  assert.deepEqual(bandRect("4:3", 1080, 1920), [0, 459, 1080, 810]);
  assert.deepEqual(bandRect("full", 1080, 1920), [0, 0, 1080, 1920]);
});

test("moving a snippet keeps every beat slot in place", () => {
  const s = song(115, 60);
  const clips = [fakeClip("a", 40, 5, 1), fakeClip("b", 40, 9, 2), fakeClip("c", 40, 20, 3)];
  const p = autoEdit(clips, s, emptyProject(), { style: "cinema", pace: "beat", length: 15, order: "story", hook: true, songStart: s.downbeats[2] });
  const moved = moveContent(p.segments, 5, 1, clips);
  assert.deepEqual(moved.map((x) => x.duration), p.segments.map((x) => x.duration), "durations unchanged");
  assert.deepEqual(moved.map((x) => x.transition), p.segments.map((x) => x.transition), "transitions stay with the slot");
  assert.equal(moved[1].momentId, p.segments[5].momentId, "the moved picture lands in slot 1");
  for (const seg of moved) {
    const clip = clips.find((c) => c.id === seg.clipId)!;
    assert.ok(seg.srcIn >= 0 && seg.srcIn + seg.duration * seg.speed <= clip.duration + 1e-6, "still inside its clip");
  }
});

test("new music re-times the reel but keeps the hand-made order", () => {
  const a = song(115, 60);
  const b = song(128, 60);
  const clips = [fakeClip("a", 40, 5, 1), fakeClip("b", 40, 9, 2), fakeClip("c", 40, 20, 3)];
  const opts = { style: "cinema" as const, pace: "beat" as const, length: 15, order: "story" as const, hook: true, songStart: a.downbeats[2] };
  const p = autoEdit(clips, a, emptyProject(), opts);
  const arranged = { ...p, segments: moveContent(p.segments, 6, 0, clips) };
  const r = retime(clips, b, arranged, { ...opts, songStart: b.downbeats[2] });
  const n = Math.min(r.segments.length, arranged.segments.length);
  for (let i = 0; i < n; i++) assert.equal(r.segments[i].momentId, arranged.segments[i].momentId, `slot ${i} keeps its picture`);
  let t = r.songStart;
  for (const seg of r.segments) {
    t += seg.duration;
    assert.ok(Math.min(...b.beats.map((x) => Math.abs(x - t))) < 0.002, "cuts on the new beat");
  }
});

test("hand-picked moments always make the cut", () => {
  const s = song(115, 60);
  const clips = [fakeClip("a", 40, 5, 1), fakeClip("b", 40, 9, 2)];
  const mine = { id: "mine", clipId: "b", t: 33, start: 31.4, end: 34.6, score: 0.05, motion: 0.1, manual: true };
  clips[1].analysis!.moments.push(mine);
  const p = autoEdit(clips, s, emptyProject(), { style: "cinema", pace: "beat", length: 15, order: "story", hook: true, songStart: s.downbeats[2] });
  assert.ok(p.segments.some((x) => x.momentId === "mine"), "the low-scoring hand pick is in the reel");
});
