import { test } from "node:test";
import assert from "node:assert/strict";
import { momentBudget, pickMoments, scoreSamples, type RawSample } from "../src/engine/metrics.ts";

// A well-shot clip: sharp, well exposed, colourful, a steady handheld wobble
// and steady background sound. `events` are the times something happens.
function clip(duration: number, events: { t: number; kind: "move" | "sound" | "both" }[] = [], step = 0.5): RawSample[] {
  const raw: RawSample[] = [];
  for (let t = step / 2; t < duration; t += step) {
    let subject = 0.004 + 0.002 * Math.sin(t * 1.7);
    let audio = -30 + 0.8 * Math.sin(t * 0.9);
    for (const e of events) {
      const near = Math.exp(-((t - e.t) ** 2) / 0.8);
      if (e.kind !== "sound") subject += 0.05 * near;
      if (e.kind !== "move") audio += 12 * near;
    }
    raw.push({ t, mean: 0.46, std: 0.2, sharp: 0.06, color: 0.25, motion: 0.015 + subject, subject, change: 0.02, audio, faces: 0, fx: 0.5, fy: 0.5, cut: false });
  }
  return raw;
}

const momentsOf = (raw: RawSample[], duration: number) => pickMoments(scoreSamples(raw, duration), duration, "c");

test("a pretty clip where nothing happens gives a single moment", () => {
  const ms = momentsOf(clip(60), 60);
  assert.equal(ms.length, 1);
});

test("moments land where something happens, not on the pretty quiet parts", () => {
  const events = [
    { t: 9, kind: "move" as const },
    { t: 27, kind: "sound" as const },
    { t: 44, kind: "both" as const },
  ];
  const ms = momentsOf(clip(60, events), 60);
  assert.equal(ms.length, 3, `moments at ${ms.map((m) => m.t)}`);
  for (const e of events) assert.ok(ms.some((m) => Math.abs(m.t - e.t) <= 1), `missed the event at ${e.t}: ${ms.map((m) => m.t)}`);
  // Movement and a burst of sound together beat either alone.
  const best = [...ms].sort((a, b) => b.score - a.score)[0];
  assert.ok(Math.abs(best.t - 44) <= 1, `best at ${best.t}`);
});

test("a blurry, dark frame doesn't win on action alone", () => {
  const raw = clip(30, [{ t: 8, kind: "both" }, { t: 20, kind: "both" }]);
  for (const r of raw) if (Math.abs(r.t - 8) < 2) Object.assign(r, { sharp: 0.004, mean: 0.05, std: 0.02 });
  const ms = momentsOf(raw, 30);
  const best = [...ms].sort((a, b) => b.score - a.score)[0];
  assert.ok(Math.abs(best.t - 20) <= 1, `best at ${best.t}`);
});

test("long clips offer a handful of moments, not dozens", () => {
  assert.equal(momentBudget(10), 2);
  assert.equal(momentBudget(60), 6);
  assert.equal(momentBudget(600), 8);
  const events = Array.from({ length: 30 }, (_, i) => ({ t: 5 + i * 10, kind: "both" as const }));
  const ms = momentsOf(clip(300, events, 2), 300);
  assert.ok(ms.length <= 8, `${ms.length} moments`);
  assert.ok(ms.length >= 6, `${ms.length} moments`);
});

test("a quiet clip's one moment isn't at the very start or end", () => {
  const [m] = momentsOf(clip(15), 15);
  assert.ok(m.t > 1 && m.t < 14, `moment at ${m.t}`);
});

test("a near-black night shot loses to a daylight one with the same action", () => {
  const day = clip(20, [{ t: 10, kind: "both" }]);
  const night = clip(20, [{ t: 10, kind: "both" }]).map((r) => ({ ...r, mean: 0.08, std: 0.06 }));
  const d = Math.max(...momentsOf(day, 20).map((m) => m.score));
  const n = Math.max(...momentsOf(night, 20).map((m) => m.score));
  assert.ok(n < d * 0.5, `night ${n.toFixed(3)} vs day ${d.toFixed(3)}`);
});
