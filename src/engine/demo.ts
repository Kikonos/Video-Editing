// Built-in sample media so the editor opens in a working state: five short
// procedurally drawn "clips" and a synthesised 122 BPM track with a quiet
// intro and a drop. Everything is generated on the fly, nothing is downloaded.

import type { DemoScene } from "./types.ts";

export const DEMO_SCENES: { scene: DemoScene; name: string; duration: number; hue: number }[] = [
  { scene: "golden", name: "Golden hour", duration: 9, hue: 32 },
  { scene: "ocean", name: "Surf session", duration: 8, hue: 196 },
  { scene: "city", name: "City lights", duration: 7, hue: 290 },
  { scene: "party", name: "Rooftop party", duration: 6, hue: 340 },
  { scene: "road", name: "Road trip", duration: 8, hue: 18 },
];

export const DEMO_W = 640;
export const DEMO_H = 360;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sky(ctx: CanvasRenderingContext2D, w: number, h: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function golden(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  const k = t / 9;
  sky(ctx, w, h, [
    [0, "#2b1b4a"],
    [0.35, "#c2456b"],
    [0.58, "#ff9a4a"],
    [0.62, "#ffd28a"],
  ]);
  const sx = w * (0.18 + 0.64 * k);
  const sy = h * (0.42 + 0.12 * k);
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.6);
  glow.addColorStop(0, "rgba(255,240,200,0.95)");
  glow.addColorStop(0.12, "rgba(255,200,120,0.7)");
  glow.addColorStop(1, "rgba(255,120,80,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff4d6";
  ctx.beginPath();
  ctx.arc(sx, sy, h * 0.07, 0, Math.PI * 2);
  ctx.fill();
  // Water with the sun's reflection.
  const horizon = h * 0.6;
  const water = ctx.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, "#d9735a");
  water.addColorStop(1, "#3a1f45");
  ctx.fillStyle = water;
  ctx.fillRect(0, horizon, w, h - horizon);
  for (let i = 0; i < 26; i++) {
    const y = horizon + (i / 26) * (h - horizon);
    const len = (0.04 + 0.12 * (i / 26)) * w * (0.7 + 0.3 * Math.sin(t * 3 + i));
    ctx.fillStyle = `rgba(255,230,170,${0.55 - i * 0.018})`;
    ctx.fillRect(sx - len / 2 + Math.sin(t * 2 + i * 1.7) * 6, y, len, 2);
  }
  // Hills.
  ctx.fillStyle = "#3b1d3f";
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  for (let x = 0; x <= w; x += 8) ctx.lineTo(x, horizon - 30 - 26 * Math.sin(x * 0.012 + 1) - 14 * Math.sin(x * 0.031));
  ctx.lineTo(w, horizon);
  ctx.fill();
  // Birds crossing.
  ctx.strokeStyle = "#2a1630";
  ctx.lineWidth = 2;
  for (let b = 0; b < 4; b++) {
    const bx = ((t * 40 + b * 70) % (w + 100)) - 50;
    const by = h * 0.25 + b * 12 + Math.sin(t * 2 + b) * 6;
    const f = Math.sin(t * 12 + b) * 4;
    ctx.beginPath();
    ctx.moveTo(bx - 8, by - f);
    ctx.quadraticCurveTo(bx - 3, by - 4, bx, by);
    ctx.quadraticCurveTo(bx + 3, by - 4, bx + 8, by - f);
    ctx.stroke();
  }
}

function ocean(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  sky(ctx, w, h, [
    [0, "#5fb6e8"],
    [0.45, "#bfe6f7"],
  ]);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  for (let c = 0; c < 3; c++) {
    const cx = ((t * 12 + c * 260) % (w + 200)) - 100;
    ctx.beginPath();
    ctx.ellipse(cx, 50 + c * 22, 60, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const layers = ["#0d6e9c", "#0b5f88", "#0a4f74", "#083e5d"];
  // The surfer rides across the frame: the subject auto-reframe follows.
  const surferX = w * (0.12 + 0.76 * ((t / 8) % 1));
  layers.forEach((col, i) => {
    const base = h * (0.45 + i * 0.13);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) {
      const y = base + Math.sin(x * 0.02 + t * (1.4 + i * 0.5)) * (6 + i * 4) + Math.sin(x * 0.007 - t) * 10;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const y = base + Math.sin(x * 0.02 + t * (1.4 + i * 0.5)) * (6 + i * 4) + Math.sin(x * 0.007 - t) * 10;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (i === 1) {
      const sy = base + Math.sin(surferX * 0.02 + t * 1.9) * 10 + Math.sin(surferX * 0.007 - t) * 10 - 6;
      ctx.save();
      ctx.translate(surferX, sy);
      ctx.rotate(Math.sin(t * 2) * 0.15);
      ctx.fillStyle = "#ffcf3f";
      ctx.beginPath();
      ctx.ellipse(0, 0, 26, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1d1d26";
      ctx.fillRect(-4, -34, 8, 30);
      ctx.beginPath();
      ctx.arc(0, -40, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Spray.
      for (let s = 0; s < 14; s++) {
        const r = rng(s + Math.floor(t * 20) * 31)();
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillRect(surferX - 30 - r * 30, sy - r * 26, 3, 3);
      }
    }
  });
  for (let s = 0; s < 40; s++) {
    const r = rng(s * 7 + 3);
    const x = r() * w;
    const y = h * 0.5 + r() * h * 0.5;
    const a = 0.5 + 0.5 * Math.sin(t * 6 + s);
    ctx.fillStyle = `rgba(255,255,255,${a * 0.7})`;
    ctx.fillRect(x, y, 2, 2);
  }
}

function city(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  sky(ctx, w, h, [
    [0, "#0b0a24"],
    [0.7, "#2d1450"],
    [1, "#13091f"],
  ]);
  const r = rng(11);
  let x = 0;
  while (x < w) {
    const bw = 30 + r() * 50;
    const bh = h * (0.25 + r() * 0.45);
    ctx.fillStyle = "#120e26";
    ctx.fillRect(x, h - bh, bw, bh);
    for (let wy = h - bh + 8; wy < h - 10; wy += 12) {
      for (let wx = x + 5; wx < x + bw - 6; wx += 9) {
        const on = r() > 0.55;
        if (on) {
          const flick = r() > 0.97 ? 0.5 + 0.5 * Math.sin(t * 9 + wx) : 1;
          ctx.fillStyle = `rgba(255,${200 + ((wx * 3) % 50)},120,${0.75 * flick})`;
          ctx.fillRect(wx, wy, 4, 6);
        }
      }
    }
    x += bw + 2;
  }
  // Bokeh drifting toward the camera.
  const colors = ["255,90,160", "255,190,80", "80,220,230", "170,120,255"];
  for (let i = 0; i < 26; i++) {
    const rr = rng(i * 13 + 5);
    const bx = (rr() * w + t * (10 + rr() * 30)) % (w + 80) - 40;
    const by = rr() * h * 0.8 + Math.sin(t + i) * 8;
    const rad = 10 + rr() * 30 + Math.sin(t * 1.5 + i) * 4;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
    const c = colors[i % colors.length];
    g.addColorStop(0, `rgba(${c},0.55)`);
    g.addColorStop(0.7, `rgba(${c},0.25)`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  // Light trails on the street.
  for (let i = 0; i < 6; i++) {
    const y = h - 14 - (i % 2) * 8;
    const len = 80 + i * 10;
    const px = ((t * (160 + i * 30) + i * 140) % (w + len)) - len;
    const g = ctx.createLinearGradient(px, 0, px + len, 0);
    const col = i % 2 ? "255,60,60" : "255,240,200";
    g.addColorStop(0, `rgba(${col},0)`);
    g.addColorStop(1, `rgba(${col},0.95)`);
    ctx.fillStyle = g;
    ctx.fillRect(px, y, len, 3);
  }
}

function party(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  sky(ctx, w, h, [
    [0, "#190a2a"],
    [1, "#3c0f3a"],
  ]);
  // Sweeping stage lights.
  const beams = ["255,60,170", "60,200,255", "255,210,60"];
  beams.forEach((c, i) => {
    const ang = Math.sin(t * (0.9 + i * 0.3) + i * 2) * 0.6;
    const ox = w * (0.2 + i * 0.3);
    ctx.save();
    ctx.translate(ox, 0);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, 0, 0, h * 1.2);
    g.addColorStop(0, `rgba(${c},0.7)`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.lineTo(90, h * 1.2);
    ctx.lineTo(-90, h * 1.2);
    ctx.fill();
    ctx.restore();
  });
  // Crowd silhouettes bouncing on the beat (122 BPM).
  const beat = (t * 122) / 60;
  const bounce = Math.pow(1 - (beat % 1), 3);
  ctx.fillStyle = "#0c0612";
  for (let i = 0; i < 14; i++) {
    const cx = (i + 0.5) * (w / 14);
    const jump = ((i % 3) * 0.3 + bounce) * 8;
    const cy = h - 40 - jump - (i % 2) * 10;
    ctx.beginPath();
    ctx.arc(cx, cy - 26, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 18, cy - 14, 36, 70);
    if (i % 3 === 0) ctx.fillRect(cx + 10, cy - 46 - jump, 6, 34);
  }
  // Confetti bursts every two beats.
  const burstEvery = 120 / 122;
  const colors = ["#ff4fa3", "#ffd23f", "#3fd1ff", "#7dff6a", "#ffffff"];
  const nb = Math.floor(t / burstEvery);
  for (let b = Math.max(0, nb - 2); b <= nb; b++) {
    const age = t - b * burstEvery;
    if (age < 0) continue;
    const r = rng(b * 97 + 1);
    const ox = w * (0.25 + r() * 0.5);
    for (let p = 0; p < 60; p++) {
      const ang = r() * Math.PI * 2;
      const sp = 120 + r() * 220;
      const px = ox + Math.cos(ang) * sp * age;
      const py = h * 0.35 + Math.sin(ang) * sp * age * 0.7 + 260 * age * age;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(age * 8 + p);
      ctx.fillStyle = colors[p % colors.length];
      ctx.globalAlpha = Math.max(0, 1 - age / 2.2);
      ctx.fillRect(-4, -2, 8, 4);
      ctx.restore();
    }
  }
}

function road(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  sky(ctx, w, h, [
    [0, "#ff7e5f"],
    [0.5, "#feb47b"],
    [0.52, "#6b4f6a"],
  ]);
  const horizon = h * 0.5;
  ctx.fillStyle = "#5a3d5c";
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  for (let x = 0; x <= w; x += 10) ctx.lineTo(x, horizon - 40 - 30 * Math.abs(Math.sin(x * 0.008 + 0.5)) - 10 * Math.sin(x * 0.05));
  ctx.lineTo(w, horizon);
  ctx.fill();
  ctx.fillStyle = "#3d2b3a";
  ctx.fillRect(0, horizon, w, h - horizon);
  // Road in perspective; the vanishing point drifts as the car follows the curve.
  const vx = w * (0.5 + 0.18 * Math.sin(t * 0.6));
  ctx.fillStyle = "#26232b";
  ctx.beginPath();
  ctx.moveTo(vx - 4, horizon);
  ctx.lineTo(vx + 4, horizon);
  ctx.lineTo(w * 0.95, h);
  ctx.lineTo(w * 0.05, h);
  ctx.fill();
  for (let i = 0; i < 12; i++) {
    const z = ((i / 12 + t * 0.9) % 1);
    const y0 = horizon + (h - horizon) * z * z;
    const y1 = horizon + (h - horizon) * Math.min(1, (z + 0.035) * (z + 0.035));
    const x0 = vx + (w / 2 - vx) * z * z;
    const lw = 2 + 10 * z * z;
    ctx.fillStyle = "#ffe08a";
    ctx.fillRect(x0 - lw / 2, y0, lw, Math.max(1, y1 - y0));
  }
  // Poles whizzing past.
  for (let i = 0; i < 6; i++) {
    const z = ((i / 6 + t * 0.7) % 1);
    const zz = z * z;
    const side = i % 2 ? 1 : -1;
    const x = vx + side * (20 + zz * w * 0.7);
    const top = horizon - 10 - zz * h * 0.5;
    ctx.fillStyle = "#1c1420";
    ctx.fillRect(x, top, 2 + zz * 8, horizon + zz * (h - horizon) - top);
  }
  // Sun flare.
  const g = ctx.createRadialGradient(w * 0.75, horizon - 50, 0, w * 0.75, horizon - 50, 140);
  g.addColorStop(0, "rgba(255,250,220,0.9)");
  g.addColorStop(1, "rgba(255,200,150,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

const DRAW: Record<DemoScene, (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => void> = {
  golden,
  ocean,
  city,
  party,
  road,
};

export function drawDemo(ctx: CanvasRenderingContext2D, scene: DemoScene, t: number): void {
  ctx.save();
  ctx.globalAlpha = 1;
  DRAW[scene](ctx, t, DEMO_W, DEMO_H);
  ctx.restore();
}

export function makeDemoCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = DEMO_W;
  c.height = DEMO_H;
  return c;
}

// ---------------------------------------------------------------- demo track

const BPM = 122;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 17;

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
// Am – F – C – G
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];

export async function synthDemoSong(): Promise<AudioBuffer> {
  const sr = 44100;
  const length = Math.ceil((BARS * BAR + 1.2) * sr);
  const ctx = new OfflineAudioContext(2, length, sr);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp);
  comp.connect(ctx.destination);

  const noise = ctx.createBuffer(1, sr, sr);
  const nd = noise.getChannelData(0);
  const r = rng(42);
  for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;

  const kick = (t: number, v = 1) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    g.gain.setValueAtTime(0.95 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.4);
  };
  const noiseHit = (t: number, type: BiquadFilterType, freq: number, gain: number, decay: number, q = 0.7) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    s.connect(f).connect(g).connect(master);
    s.start(t, r() * 0.5);
    s.stop(t + decay + 0.02);
  };
  const clap = (t: number, v = 1) => {
    for (let k = 0; k < 3; k++) noiseHit(t + k * 0.011, "bandpass", 1500, 0.55 * v, 0.03, 0.9);
    noiseHit(t + 0.033, "bandpass", 1300, 0.5 * v, 0.2, 0.8);
  };
  const hat = (t: number, v = 1, open = false) => noiseHit(t, "highpass", 7500, 0.22 * v, open ? 0.22 : 0.045);
  const tone = (t: number, f: number, dur: number, type: OscillatorType, gain: number, cutoff: number, attack = 0.005) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    o.connect(lp).connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.3);
  };

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = 0.2 + bar * BAR;
    const chord = CHORDS[bar % 4];
    const intro = bar < 4;
    const build = bar >= 4 && bar < 8;
    const drop = bar >= 8 && bar < 16;
    const outro = bar >= 16;
    // Pad.
    for (const n of chord) {
      tone(t0, midi(n), BAR, "sawtooth", drop ? 0.035 : 0.05, drop ? 2400 : 900, 0.3);
      tone(t0, midi(n) * 1.005, BAR, "sawtooth", drop ? 0.03 : 0.04, drop ? 2400 : 900, 0.3);
    }
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * BEAT;
      if (!intro && !(outro && b > 0)) kick(tb, drop ? 1 : 0.85);
      if (intro && b === 0) kick(tb, 0.35);
      if ((build || drop) && (b === 1 || b === 3)) clap(tb, drop ? 1 : 0.7);
      for (let e = 0; e < 2; e++) {
        const th = tb + e * (BEAT / 2);
        if (e === 1) hat(th, intro ? 0.5 : 1, drop);
        else if (!intro) hat(th, 0.45);
      }
      if (drop) {
        // Off-beat bass and chord stabs.
        tone(tb + BEAT / 2, midi(chord[0] - 24), BEAT * 0.4, "sawtooth", 0.32, 520);
        tone(tb + BEAT / 2, midi(chord[0] - 12), BEAT * 0.3, "square", 0.08, 900);
        if (b % 2 === 1) for (const n of chord) tone(tb + BEAT * 0.75, midi(n + 12), 0.12, "square", 0.045, 3200);
      } else if (build) {
        tone(tb, midi(chord[0] - 24), BEAT * 0.8, "sawtooth", 0.22, 380);
      }
    }
    if (bar === 7) {
      // Snare roll + riser into the drop.
      for (let k = 0; k < 8; k++) clap(t0 + BAR / 2 + k * (BEAT / 4), 0.35 + k * 0.08);
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(400, t0);
      f.frequency.exponentialRampToValueAtTime(7000, t0 + BAR);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + BAR - 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + BAR);
      s.connect(f).connect(g).connect(master);
      s.start(t0);
      s.stop(t0 + BAR + 0.05);
    }
  }
  return ctx.startRendering();
}
