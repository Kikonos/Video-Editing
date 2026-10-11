// Beat tracking for the soundtrack.
//
// 1. Onset envelope: log-magnitude spectral flux on a downsampled mono mix.
// 2. Tempo: autocorrelation of the envelope, weighted toward ~120 BPM.
// 3. Beats: dynamic-programming tracker (Ellis 2007), the same idea librosa uses.
// 4. Bars: the beat phase with the strongest low-end (kick) onsets is the downbeat.
// Pure functions only, so this runs in a worker and in node tests.

import { FFT, hann } from "./fft.ts";

export interface BeatAnalysis {
  bpm: number;
  beats: number[];
  downbeats: number[];
  beatEnergy: number[];
}

const TARGET_SR = 11025;
const N = 512;
const HOP = 128;

export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < len; i++) out[i] *= k;
  return out;
}

/** Box-filter decimation to roughly 11 kHz. Plenty for onset detection. */
export function decimate(x: Float32Array, sr: number): { data: Float32Array; sr: number } {
  const d = Math.max(1, Math.round(sr / TARGET_SR));
  if (d === 1) return { data: x, sr };
  const n = Math.floor(x.length / d);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * d;
    for (let k = 0; k < d; k++) s += x[o + k];
    out[i] = s / d;
  }
  return { data: out, sr: sr / d };
}

export interface Onsets {
  env: Float32Array;
  low: Float32Array;
  rms: Float32Array;
  frameRate: number;
  /** Time of frame 0's centre, seconds. */
  offset: number;
}

export function onsetEnvelope(x: Float32Array, sr: number): Onsets {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const win = hann(N);
  const fft = new FFT(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const half = N / 2;
  // Group FFT bins into log-spaced bands (roughly mel-like) so a kick drum
  // counts as much as a broadband hi-hat. Without this the tracker happily
  // locks onto off-beat hats.
  const edges: number[] = [];
  for (let b = 0; b <= 40; b++) {
    const hz = 40 * Math.pow(sr / 2 / 40, b / 40);
    const bin = Math.min(half - 1, Math.max(1, Math.round((hz * N) / sr)));
    if (!edges.length || bin > edges[edges.length - 1]) edges.push(bin);
  }
  const bands = edges.length - 1;
  let prev = new Float32Array(bands);
  let cur = new Float32Array(bands);
  const flux = new Float32Array(frames);
  const low = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const mag = new Float32Array(half);
  const lowBands = edges.filter((e) => (e * sr) / N < 180).length;
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = x[o + i];
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / N);
    fft.transform(re, im);
    for (let k = 1; k < half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    let s = 0;
    let sl = 0;
    for (let b = 0; b < bands; b++) {
      let m = 0;
      const a = edges[b];
      const z = Math.max(a + 1, edges[b + 1]);
      for (let k = a; k < z; k++) m += mag[k];
      const v = Math.log1p((100 * m) / (z - a));
      cur[b] = v;
      const d = v - prev[b];
      if (d > 0) {
        s += d;
        if (b < lowBands) sl += d;
      }
    }
    if (f > 0) {
      flux[f] = s;
      low[f] = sl;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }

  // Remove the slowly varying part so only attacks remain, then scale to unit std.
  const frameRate = sr / HOP;
  const env = new Float32Array(frames);
  const w = Math.max(1, Math.round(frameRate * 0.5));
  let acc = 0;
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) pre[i + 1] = pre[i] + flux[i];
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(frames, i + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    env[i] = Math.max(0, flux[i] - mean);
    acc += env[i] * env[i];
  }
  const std = Math.sqrt(acc / Math.max(1, frames)) || 1;
  for (let i = 0; i < frames; i++) env[i] /= std;
  return { env, low, rms, frameRate, offset: N / 2 / sr };
}

/** Beat period in frames (fractional). */
export function estimatePeriod(env: Float32Array, frameRate: number): number {
  const n = Math.min(env.length, Math.round(frameRate * 120));
  const minLag = Math.max(2, Math.floor((frameRate * 60) / 200));
  const maxLag = Math.ceil((frameRate * 60) / 60);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);
  const ac = new Float32Array(2 * maxLag + 2);
  for (let lag = minLag - 1; lag <= 2 * maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (env[i] - mean) * (env[i - lag] - mean);
    ac[lag] = s / (n - lag);
  }
  let best = -Infinity;
  let bestLag = Math.round((frameRate * 60) / 120);
  const score = (lag: number) => {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    return (ac[lag] + 0.5 * (ac[2 * lag] ?? 0)) * prior;
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = score(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  // Octave check: if the half period also shows a strong periodicity (eighth-note
  // activity on top of the pulse) and the faster tempo is still danceable, the
  // faster one is usually what people tap along to.
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag && (60 * frameRate) / halfLag <= 180 && ac[halfLag] > 0.5 * ac[bestLag]) {
    bestLag = halfLag;
  }
  // Parabolic interpolation around the peak for a fractional period.
  const y0 = score(Math.max(minLag, bestLag - 1));
  const y1 = score(bestLag);
  const y2 = score(Math.min(maxLag, bestLag + 1));
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return bestLag + Math.max(-0.5, Math.min(0.5, delta));
}

export function trackBeats(env: Float32Array, period: number): number[] {
  const n = env.length;
  if (n === 0) return [];
  const fpb = Math.round(period);
  const local = new Float32Array(n);
  const win: number[] = [];
  for (let k = -fpb; k <= fpb; k++) win.push(Math.exp(-0.5 * Math.pow((k * 32) / period, 2)));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -fpb; k <= fpb; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * win[k + fpb];
    }
    local[i] = s;
  }

  const tightness = 100;
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(period * 2);
  const tx = new Float32Array(hi + 1);
  for (let d = lo; d <= hi; d++) tx[d] = -tightness * Math.pow(Math.log(d / period), 2);
  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  let maxLocal = 0;
  for (let i = 0; i < n; i++) maxLocal = Math.max(maxLocal, local[i]);
  const thresh = 0.01 * maxLocal;
  let first = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bi = -1;
    for (let d = lo; d <= hi; d++) {
      const j = i - d;
      const v = tx[d] + (j >= 0 ? cum[j] : 0);
      if (v > best) {
        best = v;
        bi = j;
      }
    }
    cum[i] = local[i] + best;
    if (first && local[i] < thresh) back[i] = -1;
    else {
      back[i] = bi;
      first = false;
    }
  }

  // Last beat: the final local max of the cumulative score that is still strong.
  const maxima: number[] = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
  if (!maxima.length) return [];
  const sorted = maxima.map((i) => cum[i]).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let last = maxima[maxima.length - 1];
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (cum[maxima[k]] * 2 > med) {
      last = maxima[k];
      break;
    }
  }
  const beats: number[] = [];
  for (let b = last; b >= 0; b = back[b]) beats.push(b);
  beats.reverse();

  // Trim weak beats at the edges (silence before/after the track).
  const strength = beats.map((b) => local[b]);
  const sm = strength.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let k = -2; k <= 2; k++) {
      const v = strength[i + k];
      if (v !== undefined) {
        const h = 1 - Math.abs(k) / 3;
        s += v * h;
        w += h;
      }
    }
    return s / w;
  });
  const rmsS = Math.sqrt(sm.reduce((a, v) => a + v * v, 0) / Math.max(1, sm.length));
  const cut = 0.5 * rmsS;
  let a = 0;
  let z = beats.length - 1;
  while (a < z && sm[a] < cut) a++;
  while (z > a && sm[z] < cut) z--;
  // Smoothing can keep a lone beat placed after the music stops; drop edge
  // beats that have almost no onset under them.
  const sortedStrength = strength.slice(a, z + 1).sort((p, q) => p - q);
  const medStrength = sortedStrength[Math.floor(sortedStrength.length / 2)] ?? 0;
  while (a < z && strength[a] < 0.3 * medStrength) a++;
  while (z > a && strength[z] < 0.3 * medStrength) z--;
  return beats.slice(a, z + 1);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

export function detectBeats(mono: Float32Array, sampleRate: number): BeatAnalysis {
  const { data, sr } = decimate(mono, sampleRate);
  const on = onsetEnvelope(data, sr);
  if (on.env.length < on.frameRate * 2) {
    return { bpm: 120, beats: [], downbeats: [], beatEnergy: [] };
  }
  const period = estimatePeriod(on.env, on.frameRate);
  const frames = trackBeats(on.env, period);
  const toTime = (f: number) => f / on.frameRate + on.offset;
  const beats = frames.map(toTime);

  // Downbeat phase: which of the 4 positions carries the most kick energy.
  let phase = 0;
  let bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    let c = 0;
    for (let i = p; i < frames.length; i += 4) {
      const f = frames[i];
      let m = 0;
      for (let k = -2; k <= 2; k++) m = Math.max(m, on.low[f + k] ?? 0);
      s += m;
      c++;
    }
    const v = c ? s / c : 0;
    if (v > bestPhase) {
      bestPhase = v;
      phase = p;
    }
  }
  const downbeats = beats.filter((_, i) => i % 4 === phase);

  // Loudness of each beat interval in dB, mapped to 0..1 by robust range.
  const db: number[] = frames.map((f, i) => {
    const end = i + 1 < frames.length ? frames[i + 1] : Math.min(on.rms.length, f + Math.round(period));
    let s = 0;
    let c = 0;
    for (let k = f; k < end; k++) {
      s += on.rms[k] * on.rms[k];
      c++;
    }
    return 10 * Math.log10(s / Math.max(1, c) + 1e-9);
  });
  // Centre on the median and never stretch less than 10 dB across the scale,
  // so a song with steady loudness reads as "medium" everywhere instead of
  // having tiny level wobbles blown up into quiet and loud sections.
  const lo = percentile(db, 0.05);
  const hi = percentile(db, 0.95);
  const med = percentile(db, 0.5);
  const range = Math.max(10, hi - lo);
  const raw = db.map((v) => Math.max(0, Math.min(1, 0.55 + (v - med) / range)));
  const beatEnergy = raw.map((v, i) => 0.25 * (raw[i - 1] ?? v) + 0.5 * v + 0.25 * (raw[i + 1] ?? v));

  // Tempo from a least-squares fit of beat time against beat index: frame
  // quantisation makes single intervals jitter, the slope does not.
  let beatPeriod = period / on.frameRate;
  if (beats.length > 4) {
    const n = beats.length;
    const mi = (n - 1) / 2;
    const mt = beats.reduce((acc, v) => acc + v, 0) / n;
    let num = 0;
    let den = 0;
    beats.forEach((t, i) => {
      num += (i - mi) * (t - mt);
      den += (i - mi) * (i - mi);
    });
    beatPeriod = num / den;
  }
  const bpm = Math.round(600 / beatPeriod) / 10;
  return { bpm, beats, downbeats, beatEnergy };
}

/**
 * Pick the strongest stretch of the song for a reel of `length` seconds:
 * loud sections win, and a section that starts right where the energy jumps
 * (a drop or a chorus) wins over one that fades in.
 */
export function suggestSection(
  a: Pick<BeatAnalysis, "beats" | "downbeats" | "beatEnergy">,
  songDuration: number,
  length: number,
): number {
  if (songDuration <= length + 0.5 || a.beats.length < 8) return 0;
  const energyAt = (t0: number, t1: number) => {
    let s = 0;
    let c = 0;
    a.beats.forEach((b, i) => {
      if (b >= t0 && b < t1) {
        s += a.beatEnergy[i];
        c++;
      }
    });
    return c ? s / c : 0;
  };
  const bar = a.downbeats.length > 1 ? a.downbeats[1] - a.downbeats[0] : 2;
  let best = 0;
  let bestScore = -Infinity;
  for (const s of a.downbeats) {
    if (s + length > songDuration - 0.25) break;
    const body = energyAt(s, s + length);
    const head = energyAt(s, s + 2 * bar);
    const before = energyAt(Math.max(0, s - 4 * bar), s);
    const rise = s > bar ? Math.max(0, head - before) : 0;
    const score = body + 0.6 * rise - (s < 1 ? 0.05 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
