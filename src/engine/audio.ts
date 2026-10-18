// Audio helpers: decode the soundtrack out of any video or audio file, run
// beat detection off the main thread, draw waveforms, write WAV.

import { decimate, detectBeats, downmix, type BeatAnalysis } from "./beats.ts";
import BeatWorker from "./beat.worker.ts?worker&inline";
import { extractAudio, isMp4Family, NoSoundTrack } from "./mp4audio.ts";

export { NoSoundTrack };

let shared: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!shared) {
    // iPhone: play through the silent switch, like a music app (Safari 16.4+).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        // Older Safari: Web Audio follows the silent switch.
      }
    }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    shared = new Ctor({ latencyHint: "interactive" });
  }
  return shared;
}

/** The browser couldn't decode the file's sound directly; listenToAudio() can still capture it. */
export class CantDecode extends Error {
  constructor(cause: unknown) {
    super("Couldn't decode the sound in this file.");
    this.name = "CantDecode";
    this.cause = cause;
  }
}

async function decodeBytes(file: Blob): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  const ctx = audioContext();
  return await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error("decode failed")));
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
}

/** Whole files above this aren't handed to the decoder in one piece (phones run out of memory). */
const WHOLE_FILE_LIMIT = 400 * 1024 * 1024;

/**
 * Decode the sound of a video or audio file. MP4 and QuickTime videos have
 * their sound track pulled out first (Safari can't decode a .mov, and it
 * avoids loading the picture). Throws NoSoundTrack when there is no sound,
 * CantDecode when the browser can't read it.
 */
export async function decodeAudio(file: Blob): Promise<AudioBuffer> {
  let last: unknown = null;
  if (await isMp4Family(file)) {
    try {
      const ex = await extractAudio(file);
      for (const f of ex.files) {
        try {
          return await decodeBytes(f);
        } catch (e) {
          last = e;
        }
      }
    } catch (e) {
      if (e instanceof NoSoundTrack) throw e;
      last = e;
    }
  }
  if (file.size <= WHOLE_FILE_LIMIT) {
    try {
      return await decodeBytes(file);
    } catch (e) {
      last = e;
    }
  }
  console.warn("Couldn't decode audio:", last);
  throw new CantDecode(last);
}

/** Longest stretch listenToAudio() records. */
export const LISTEN_MAX = 180;

/**
 * Last resort for a file the decoder refuses: play it once and record what
 * comes out. Call straight from a tap (phones only start sound on a tap).
 * Takes as long as the song, up to LISTEN_MAX seconds.
 */
export function listenToAudio(file: Blob, onProgress: (t: number, total: number) => void, signal?: AbortSignal): Promise<AudioBuffer> {
  const ctx = audioContext();
  void ctx.resume();
  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  el.playsInline = true;
  el.preload = "auto";
  el.src = url;
  const src = ctx.createMediaElementSource(el);
  const proc = ctx.createScriptProcessor(4096, 2, 2);
  const left: Float32Array[] = [];
  const right: Float32Array[] = [];
  proc.onaudioprocess = (e) => {
    if (el.paused || el.ended) return;
    const b = e.inputBuffer;
    left.push(b.getChannelData(0).slice());
    right.push((b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice());
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  src.connect(ctx.destination);
  const started = el.play();

  return new Promise<AudioBuffer>((resolve, reject) => {
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      el.pause();
      proc.onaudioprocess = null;
      src.disconnect();
      proc.disconnect();
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
      if (err) return reject(err);
      const total = left.reduce((a, c) => a + c.length, 0);
      // Skip the silence before playback actually started.
      let lead = 0;
      outer: for (const c of left) {
        for (let i = 0; i < c.length; i++, lead++) if (Math.abs(c[i]) > 1e-4) break outer;
      }
      const n = total - lead;
      if (n < ctx.sampleRate) return reject(new CantDecode(new Error("nothing heard")));
      const out = ctx.createBuffer(2, n, ctx.sampleRate);
      [left, right].forEach((parts, ch) => {
        const dst = out.getChannelData(ch);
        let o = -lead;
        for (const p of parts) {
          if (o + p.length > 0) dst.set(o >= 0 ? p : p.subarray(-o), Math.max(0, o));
          o += p.length;
        }
      });
      resolve(out);
    };
    const total = () => Math.min(LISTEN_MAX, Number.isFinite(el.duration) ? el.duration : LISTEN_MAX);
    const tick = setInterval(() => {
      onProgress(el.currentTime, total());
      if (el.currentTime >= LISTEN_MAX) finish();
    }, 250);
    el.addEventListener("ended", () => finish());
    el.addEventListener("error", () => finish(new CantDecode(el.error)));
    // Stopping early keeps what was heard so far.
    signal?.addEventListener("abort", () => finish());
    started.catch((e) => finish(e));
  });
}

let worker: Worker | null = null;
let workerFailed = false;
let reqId = 0;
const pending = new Map<number, { resolve: (r: BeatAnalysis) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new BeatWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; result?: BeatAnalysis; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.result) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error || "beat detection failed"));
    };
    worker.onerror = () => {
      workerFailed = true;
      for (const p of pending.values()) p.reject(new Error("worker crashed"));
      pending.clear();
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

export async function analyzeBeats(buffer: AudioBuffer): Promise<BeatAnalysis> {
  const chans: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
  const { data, sr } = decimate(downmix(chans), buffer.sampleRate);
  const mono = data === chans[0] ? data.slice() : data;
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<BeatAnalysis>((resolve, reject) => {
        const id = ++reqId;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, mono, sr }, [mono.buffer]);
      });
    } catch {
      // Fall through to the main thread.
    }
  }
  const { data: again, sr: sr2 } = decimate(downmix(chans), buffer.sampleRate);
  return detectBeats(again, sr2);
}

/** Peak envelope for drawing, `bins` values in 0..1. */
export function waveformPeaks(buffer: AudioBuffer, bins = 1200): number[] {
  const ch = buffer.getChannelData(0);
  const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const per = Math.max(1, Math.floor(ch.length / bins));
  const out: number[] = [];
  let max = 1e-6;
  for (let b = 0; b < bins; b++) {
    let m = 0;
    const o = b * per;
    for (let i = 0; i < per; i += 4) {
      const v = Math.abs(ch[o + i] ?? 0) + (ch2 ? Math.abs(ch2[o + i] ?? 0) : 0);
      if (v > m) m = v;
    }
    out.push(m);
    if (m > max) max = m;
  }
  return out.map((v) => Math.round((v / max) * 1000) / 1000);
}

/** Loudness envelope at 10 Hz, used to find loud moments (cheers, laughs) in clips. */
export function loudnessEnvelope(buffer: AudioBuffer): Float32Array {
  const ch = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(buffer.sampleRate / 10));
  const n = Math.ceil(ch.length / per);
  const out = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let s = 0;
    let c = 0;
    for (let i = b * per; i < Math.min(ch.length, (b + 1) * per); i += 2) {
      s += ch[i] * ch[i];
      c++;
    }
    out[b] = 10 * Math.log10(s / Math.max(1, c) + 1e-9);
  }
  return out;
}

export function encodeWav(buffer: AudioBuffer, start = 0, end = buffer.duration): Blob {
  const sr = buffer.sampleRate;
  const ch = Math.min(2, buffer.numberOfChannels);
  const a = Math.max(0, Math.floor(start * sr));
  const b = Math.min(buffer.length, Math.ceil(end * sr));
  const frames = Math.max(0, b - a);
  const bytes = 44 + frames * ch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, frames * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = a; i < b; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}
