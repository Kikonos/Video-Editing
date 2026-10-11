import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBeats, suggestSection } from "../src/engine/beats.ts";

// Kick-like thumps on every beat (louder on the "one"), hats on off-beats,
// a quiet intro and a loud second half, plus a little noise.
function makeTrack(bpm: number, seconds: number, sr = 44100, startOffset = 0.3) {
  const x = new Float32Array(Math.round(seconds * sr));
  const period = 60 / bpm;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < x.length; i++) x[i] = 0.01 * rnd();
  for (let b = 0, t = startOffset; t < seconds - 0.3; b++, t += period) {
    const loud = t > seconds / 2 ? 1 : 0.35;
    const amp = (b % 4 === 0 ? 0.9 : 0.5) * loud;
    const s0 = Math.round(t * sr);
    for (let k = 0; k < sr * 0.15 && s0 + k < x.length; k++) {
      const tt = k / sr;
      const f = 50 + 100 * Math.exp(-tt * 30);
      x[s0 + k] += amp * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 18);
    }
    const h0 = Math.round((t + period / 2) * sr);
    for (let k = 0; k < sr * 0.03 && h0 + k < x.length; k++) x[h0 + k] += 0.15 * loud * rnd() * Math.exp(-k / (sr * 0.008));
  }
  return { x, period, startOffset };
}

for (const bpm of [92, 120, 128, 150]) {
  test(`tracks a ${bpm} BPM pulse`, () => {
    const { x, period, startOffset } = makeTrack(bpm, 30);
    const t0 = performance.now();
    const r = detectBeats(x, 44100);
    const ms = performance.now() - t0;
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `bpm ${r.bpm} vs ${bpm}`);
    // Every detected beat should sit within 35 ms of a true beat.
    let worst = 0;
    for (const b of r.beats) {
      const k = Math.round((b - startOffset) / period);
      worst = Math.max(worst, Math.abs(b - (startOffset + k * period)));
    }
    assert.ok(worst < 0.035, `worst beat error ${(worst * 1000).toFixed(1)} ms`);
    assert.ok(r.beats.length > (30 / period) * 0.85, `found ${r.beats.length} beats`);
    // Downbeats should land on the accented beats (index multiple of 4).
    const db = r.downbeats.map((d) => Math.round((d - startOffset) / period) % 4);
    const onOne = db.filter((v) => v === 0).length / db.length;
    assert.ok(onOne > 0.9, `downbeats on the one: ${onOne}`);
    assert.ok(ms < 3000, `took ${ms} ms`);
  });
}

test("suggests the loud half of the song", () => {
  const { x } = makeTrack(120, 40);
  const r = detectBeats(x, 44100);
  const start = suggestSection(r, 40, 15);
  assert.ok(start >= 18 && start <= 25.5, `start ${start}`);
});

test("steady loudness reads as medium energy", () => {
  const sr = 44100;
  const x = new Float32Array(sr * 20);
  for (let b = 0.3; b < 19.7; b += 0.5) {
    const s0 = Math.round(b * sr);
    for (let k = 0; k < sr * 0.12; k++) x[s0 + k] += 0.8 * Math.sin(2 * Math.PI * 60 * (k / sr)) * Math.exp(-k / (sr * 0.05));
  }
  const r = detectBeats(x, sr);
  const mean = r.beatEnergy.reduce((a, v) => a + v, 0) / r.beatEnergy.length;
  const low = r.beatEnergy.filter((v) => v < 0.3).length;
  assert.ok(mean > 0.4 && mean < 0.7, `mean energy ${mean}`);
  assert.ok(low <= 2, `${low} beats read as quiet`);
});
