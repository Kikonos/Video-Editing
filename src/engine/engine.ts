// Playback + export engine. Owns the <video> elements, the audio graph and the
// compositor; the UI hands it plain project data and reads back the clock.

import { audioContext } from "./audio.ts";
import { DEMO_H, DEMO_W, drawDemo, makeDemoCanvas } from "./demo.ts";
import { computeGrade, type Grade } from "./looks.ts";
import { focusAt } from "./metrics.ts";
import { Renderer } from "./renderer.ts";
import { drawTexts } from "./text.ts";
import {
  layersAt,
  segmentStarts,
  sourceTime,
  timelineBeats,
  timelineDownbeats,
  totalDuration,
  transitionLen,
  type Layer,
} from "./timeline.ts";
import { ASPECTS, bandRect, type Aspect, type Clip, type LookId, type Project, type Song } from "./types.ts";

class Player {
  readonly el: HTMLVideoElement;
  url: string | null = null;
  segId: string | null = null;
  node: MediaElementAudioSourceNode | null = null;
  gain: GainNode | null = null;

  constructor(onSeeked: () => void) {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadeddata", onSeeked);
    this.el = v;
  }

  load(url: string) {
    if (this.url !== url) {
      this.url = url;
      this.el.src = url;
    }
  }
}

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** false: record without the song, to add it from Instagram's music library instead. */
  includeMusic: boolean;
  onProgress: (p: number) => void;
  signal: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  ext: string;
}

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function exportFormat(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext: m.startsWith("video/mp4") ? "mp4" : "webm" };
    } catch {
      // keep looking
    }
  }
  return null;
}

function previewSize(aspect: Aspect): [number, number] {
  const { w, h } = ASPECTS[aspect];
  const k = 960 / Math.max(w, h);
  return [Math.round(w * k), Math.round(h * k)];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Engine {
  /** The visible output; also what gets recorded on export. */
  readonly canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private textCanvas: HTMLCanvasElement;
  private textCtx: CanvasRenderingContext2D;
  private demoCanvases: HTMLCanvasElement[] = [makeDemoCanvas(), makeDemoCanvas()];
  private players: Player[] = [];
  private thumbs = new Map<string, HTMLImageElement>();

  project: Project | null = null;
  private clips = new Map<string, Clip>();
  private songs = new Map<string, Song>();
  private media = new Map<string, string>();
  private buffers = new Map<string, AudioBuffer>();
  private starts: number[] = [];
  private total = 0;
  private grade: Grade | null = null;
  private beats: number[] = [];
  private downbeats = new Set<number>();

  private actx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicEnv: GainNode | null = null;
  private musicVol: GainNode | null = null;
  private clipBus: GainNode | null = null;
  private musicNode: AudioBufferSourceNode | null = null;

  playing = false;
  time = 0;
  loop = true;
  exporting = false;
  private startT = 0;
  private clockStart = 0;
  private perfStart = 0;
  private raf = 0;
  private renderQueued = false;
  private listeners = new Set<() => void>();
  private onEnd: (() => void) | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "preview-canvas";
    this.renderer = new Renderer(this.canvas);
    this.textCanvas = document.createElement("canvas");
    this.textCtx = this.textCanvas.getContext("2d")!;
    for (let i = 0; i < 4; i++) this.players.push(new Player(() => this.requestRender()));
    const [w, h] = previewSize("9:16");
    this.setSize(w, h);
  }

  // ------------------------------------------------------------- data in

  setData(project: Project, clips: Clip[], songs: Song[]) {
    const prev = this.project;
    this.project = project;
    this.clips = new Map(clips.map((c) => [c.id, c]));
    this.songs = new Map(songs.map((s) => [s.id, s]));
    this.starts = segmentStarts(project.segments);
    this.total = totalDuration(project.segments);
    this.grade = computeGrade(project.look, project.lookAmount, project.adjust);
    const song = project.songId ? this.songs.get(project.songId) ?? null : null;
    this.beats = timelineBeats(song, project.songStart, this.total + 1);
    this.downbeats = new Set(timelineDownbeats(song, project.songStart, this.total + 1).map((b) => Math.round(b * 1000)));
    if (!this.exporting && (!prev || prev.aspect !== project.aspect)) {
      const [w, h] = previewSize(project.aspect);
      this.setSize(w, h);
    }
    if (this.musicVol) this.musicVol.gain.value = project.musicVolume;
    if (this.clipBus) this.clipBus.gain.value = project.clipVolume;
    if (project.clipVolume > 0) this.routePlayerAudio();
    for (const c of clips) {
      if (c.thumb && !this.thumbs.has(c.id)) {
        const img = new Image();
        img.src = c.thumb;
        this.thumbs.set(c.id, img);
      }
    }
    const musicChanged =
      prev && (prev.songId !== project.songId || prev.songStart !== project.songStart || prev.fadeOut !== project.fadeOut);
    if (this.playing && (musicChanged || (prev && prev.segments !== project.segments))) {
      this.time = Math.min(this.time, Math.max(0, this.total - 0.01));
      this.restartClock(this.time);
    }
    if (this.time > this.total) this.time = 0;
    this.requestRender();
    this.emit();
  }

  registerMedia(clipId: string, url: string) {
    this.media.set(clipId, url);
  }

  mediaUrl(clipId: string): string | undefined {
    return this.media.get(clipId);
  }

  registerSong(id: string, buffer: AudioBuffer) {
    this.buffers.set(id, buffer);
  }

  songBuffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  get duration(): number {
    return this.total;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private setSize(w: number, h: number) {
    this.renderer.resize(w, h);
    this.textCanvas.width = w;
    this.textCanvas.height = h;
  }

  // ----------------------------------------------------------- transport

  private ensureAudio(): AudioContext {
    if (!this.actx) {
      const ctx = audioContext();
      this.actx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.musicEnv = ctx.createGain();
      this.musicVol = ctx.createGain();
      this.musicVol.gain.value = this.project?.musicVolume ?? 1;
      this.musicEnv.connect(this.musicVol).connect(this.master);
      this.clipBus = ctx.createGain();
      this.clipBus.gain.value = this.project?.clipVolume ?? 0;
      this.clipBus.connect(this.master);
    }
    if (this.actx.state === "suspended") void this.actx.resume();
    if ((this.project?.clipVolume ?? 0) > 0) this.routePlayerAudio();
    return this.actx;
  }

  private routePlayerAudio() {
    if (!this.actx || !this.clipBus) return;
    for (const p of this.players) {
      if (p.node) continue;
      try {
        p.node = this.actx.createMediaElementSource(p.el);
        p.gain = this.actx.createGain();
        p.gain.gain.value = 0;
        p.node.connect(p.gain).connect(this.clipBus);
        p.el.muted = false;
      } catch {
        // Already routed or not allowed; leave muted.
      }
    }
  }

  /** Create/resume the audio graph. Call inside a click so audio may start later. */
  unlockAudio() {
    this.ensureAudio();
  }

  /** Must be called from a user gesture the first time (audio unlock). */
  play() {
    if (!this.project || !this.project.segments.length) return;
    this.ensureAudio();
    // Unlock every player inside the gesture so later play() calls are allowed.
    for (const p of this.players) {
      if (p.url && p.el.paused) {
        p.el
          .play()
          .then(() => {
            if (!this.playing || !p.segId) p.el.pause();
          })
          .catch(() => {});
      }
    }
    const t = this.time >= this.total - 0.05 ? 0 : this.time;
    this.playing = true;
    this.restartClock(t);
    this.loopTick();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.time = this.now();
    this.playing = false;
    this.stopMusic();
    cancelAnimationFrame(this.raf);
    for (const p of this.players) p.el.pause();
    this.syncPlayers(this.time);
    this.requestRender();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    this.time = clamp(t, 0, Math.max(0, this.total - 0.001));
    if (this.playing) this.restartClock(this.time);
    else {
      this.syncPlayers(this.time);
      this.requestRender();
    }
    this.emit();
  }

  private restartClock(t: number) {
    const ctx = this.actx;
    this.startT = t;
    this.perfStart = performance.now();
    if (ctx) this.clockStart = ctx.currentTime + 0.04;
    this.time = t;
    this.startMusic(t);
  }

  private now(): number {
    if (!this.playing) return this.time;
    const ctx = this.actx;
    if (ctx && ctx.state === "running") {
      const latency = this.exporting ? 0 : (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
      return this.startT + Math.max(0, ctx.currentTime - this.clockStart - latency);
    }
    return this.startT + (performance.now() - this.perfStart) / 1000;
  }

  private startMusic(t: number) {
    this.stopMusic();
    const p = this.project;
    const ctx = this.actx;
    if (!p || !ctx || !this.musicEnv || !p.songId) return;
    const buf = this.buffers.get(p.songId);
    if (!buf) return;
    const offset = p.songStart + t;
    if (offset >= buf.duration) return;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    const g = this.musicEnv.gain;
    const when = this.clockStart;
    g.cancelScheduledValues(0);
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(1, when + 0.015);
    if (p.fadeOut && this.total > 1) {
      const fadeLen = Math.min(1.8, this.total * 0.3);
      const fs = this.total - fadeLen;
      if (t < fs) {
        g.setValueAtTime(1, when + (fs - t));
        g.linearRampToValueAtTime(0.0001, when + (this.total - t));
      } else {
        const remain = Math.max(0.02, this.total - t);
        g.setValueAtTime(remain / fadeLen, when + 0.016);
        g.linearRampToValueAtTime(0.0001, when + remain);
      }
    }
    node.connect(this.musicEnv);
    node.start(when, offset);
    this.musicNode = node;
  }

  private stopMusic() {
    if (this.musicNode) {
      try {
        this.musicNode.stop();
      } catch {
        // already stopped
      }
      this.musicNode.disconnect();
      this.musicNode = null;
    }
  }

  private loopTick = () => {
    if (!this.playing) return;
    let t = this.now();
    if (t >= this.total) {
      if (this.exporting) {
        this.time = this.total;
        this.renderFrame(Math.max(0, this.total - 0.001));
        this.playing = false;
        this.stopMusic();
        for (const p of this.players) p.el.pause();
        this.emit();
        this.onEnd?.();
        return;
      }
      if (this.loop && this.total > 0.5) {
        this.restartClock(0);
        t = 0;
      } else {
        this.time = Math.max(0, this.total - 0.001);
        this.pause();
        return;
      }
    }
    this.time = t;
    this.syncPlayers(t);
    this.renderFrame(t);
    this.emit();
    this.raf = requestAnimationFrame(this.loopTick);
  };

  requestRender() {
    if (this.playing || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.playing) {
        this.syncPlayers(this.time);
        this.renderFrame(this.time);
      }
    });
  }

  // ------------------------------------------------------------- players

  private syncPlayers(t: number) {
    const p = this.project;
    if (!p) return;
    const segs = p.segments;
    const layers = layersAt(segs, this.starts, t);
    const active = new Set(layers.map((l) => l.index));
    const warm: number[] = layers.map((l) => l.index);
    if (this.playing && layers.length) {
      const last = Math.max(...warm);
      for (let k = 1; k <= 2; k++) {
        const j = last + k;
        if (j < segs.length) warm.push(j);
        else if (this.loop && !this.exporting && j - segs.length < segs.length) warm.push(j - segs.length);
      }
    }
    const needed = warm.filter((i, k) => warm.indexOf(i) === k && this.media.has(segs[i].clipId));
    const neededIds = new Set(needed.map((i) => segs[i].id));
    for (const pl of this.players) {
      if (pl.segId && !neededIds.has(pl.segId)) {
        pl.segId = null;
        if (!pl.el.paused) pl.el.pause();
        if (pl.gain) pl.gain.gain.value = 0;
      }
    }
    for (const i of needed) {
      const seg = segs[i];
      if (this.players.some((pl) => pl.segId === seg.id)) continue;
      const url = this.media.get(seg.clipId)!;
      const free = this.players.filter((pl) => !pl.segId);
      const pl = free.find((f) => f.url === url) ?? free[0];
      if (!pl) continue;
      pl.segId = seg.id;
      pl.load(url);
      const clip = this.clips.get(seg.clipId);
      const startAt = active.has(i) ? t : this.starts[i] - transitionLen(segs, i) / 2;
      const st = sourceTime(seg, this.starts[i], startAt);
      try {
        pl.el.currentTime = clamp(st, 0, Math.max(0, (clip?.duration ?? 1) - 0.05));
      } catch {
        // metadata not loaded yet; the next sync seeks again
      }
      pl.el.pause();
    }

    for (const layer of layers) {
      const seg = segs[layer.index];
      const pl = this.players.find((x) => x.segId === seg.id);
      if (!pl) continue;
      const clip = this.clips.get(seg.clipId);
      const dur = clip?.duration ?? pl.el.duration ?? 0;
      const raw = sourceTime(seg, this.starts[layer.index], t);
      const st = clamp(raw, 0, Math.max(0, dur - 0.05));
      if (pl.gain) pl.gain.gain.value = this.playing ? layer.weight : 0;
      if (this.playing) {
        if (raw < 0 || raw >= dur - 0.06) {
          if (!pl.el.paused) pl.el.pause();
          if (Math.abs(pl.el.currentTime - st) > 0.05 && !pl.el.seeking) pl.el.currentTime = st;
          continue;
        }
        if (pl.el.playbackRate !== seg.speed) pl.el.playbackRate = seg.speed;
        const drift = pl.el.currentTime - st;
        if (pl.el.paused) {
          if (Math.abs(drift) > 0.06 && !pl.el.seeking) pl.el.currentTime = st;
          pl.el.play().catch(() => {});
        } else if (Math.abs(drift) > 0.25 && !pl.el.seeking) {
          pl.el.currentTime = st;
        }
      } else {
        if (!pl.el.paused) pl.el.pause();
        if (Math.abs(pl.el.currentTime - st) > 0.015 && !pl.el.seeking) {
          try {
            pl.el.currentTime = st;
          } catch {
            // not seekable yet
          }
        }
      }
    }
  }

  // ------------------------------------------------------------- drawing

  private effects(index: number, t: number) {
    const segs = this.project!.segments;
    const out = { flash: 0, blur: 0, glitch: 0, slide: 0, kick: 0 };
    const apply = (kind: string, d: number, len: number, side: "in" | "out") => {
      if (len <= 0) return;
      const h = len / 2;
      if (Math.abs(d) > h) return;
      const k = 1 - Math.abs(d) / h;
      if (kind === "flash") out.flash = Math.max(out.flash, 0.9 * k * k);
      if (kind === "smear") {
        // Motion-blurred frames either side of the cut, peaking in a white flash.
        out.blur = Math.max(out.blur, Math.min(1, k * 1.4));
        out.slide += (side === "out" ? 1 : -1) * 0.12 * k * k;
        out.flash = Math.max(out.flash, 0.85 * Math.pow(k, 3));
      }
    };
    const start = this.starts[index];
    const end = start + segs[index].duration;
    if (index > 0) apply(segs[index].transition, t - start, transitionLen(segs, index), "in");
    if (index + 1 < segs.length) apply(segs[index + 1].transition, t - end, transitionLen(segs, index + 1), "out");
    return out;
  }

  private pulse(t: number): number {
    const amount = this.project?.beatPulse ?? 0;
    if (!amount || !this.beats.length) return 0;
    let lo = 0;
    let hi = this.beats.length - 1;
    if (t < this.beats[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.beats[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const b = this.beats[lo];
    const strong = this.downbeats.has(Math.round(b * 1000));
    return amount * (strong ? 0.085 : 0.05) * Math.exp(-(t - b) / 0.1);
  }

  private sourceFor(index: number, slot: number, t: number) {
    const p = this.project!;
    const seg = p.segments[index];
    const clip = this.clips.get(seg.clipId);
    if (!clip) return null;
    const st = clamp(sourceTime(seg, this.starts[index], t), 0, Math.max(0, clip.duration - 0.04));
    let source: TexImageSource | null = null;
    let w = clip.width;
    let h = clip.height;
    if (clip.kind === "demo" && clip.demo) {
      const c = this.demoCanvases[slot % 2];
      drawDemo(c.getContext("2d")!, clip.demo, st);
      source = c;
      w = DEMO_W;
      h = DEMO_H;
    } else {
      const pl = this.players.find((x) => x.segId === seg.id);
      if (pl && pl.el.readyState >= 2 && pl.el.videoWidth) {
        source = pl.el;
        w = pl.el.videoWidth;
        h = pl.el.videoHeight;
      } else {
        const img = this.thumbs.get(clip.id);
        if (img && img.complete && img.naturalWidth) source = img;
      }
    }
    if (!source) return null;
    const focus = focusAt(clip.analysis?.samples, st);
    return { source, w, h, seg, focus };
  }

  private renderFrame(t: number) {
    const p = this.project;
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.renderer.clear();
    if (!p || !p.segments.length || !this.grade) return;
    const band = bandRect(p.frame ?? "full", W, H);
    this.renderer.setBand(...band);
    const layers: Layer[] = layersAt(p.segments, this.starts, t);
    const pulse = this.pulse(t);
    const wideBand = band[2] > band[3];
    layers.forEach((l, slot) => {
      const src = this.sourceFor(l.index, slot, t);
      if (!src) return;
      // A wide band keeps only a slice of vertical phone footage. Detail alone
      // pulls the slice to skies and lights, so lean toward the middle of the
      // picture, where people usually are.
      const fy = wideBand && src.h > src.w ? 0.6 * 0.56 + 0.4 * src.focus.y : src.focus.y;
      const eff = this.effects(l.index, t);
      this.renderer.draw(
        slot,
        {
          source: src.source,
          srcW: src.w,
          srcH: src.h,
          focusX: src.seg.reframe ?? src.focus.x,
          focusY: fy,
          zoom: src.seg.zoom,
          kick: 1 + eff.kick + pulse,
          opacity: slot === 0 ? 1 : l.weight,
          flash: eff.flash,
          blur: eff.blur,
          glitch: eff.glitch,
          slide: eff.slide,
        },
        this.grade!,
        t,
      );
    });
    if (p.texts.some((tx) => t >= tx.start && t <= tx.end && tx.text.trim())) {
      this.textCtx.clearRect(0, 0, W, H);
      drawTexts(this.textCtx, p.texts, t, W, H, band);
      this.renderer.overlay(this.textCanvas);
    }
  }

  /** Raw (ungraded) frame of the shot under the playhead, for look previews. */
  rawFrame(): { source: TexImageSource; w: number; h: number; fx: number; fy: number } | null {
    const p = this.project;
    if (!p || !p.segments.length) return null;
    const layers = layersAt(p.segments, this.starts, this.time);
    if (!layers.length) return null;
    const src = this.sourceFor(layers[0].index, 0, this.time);
    if (!src) return null;
    return { source: src.source, w: src.w, h: src.h, fx: src.seg.reframe ?? src.focus.x, fy: src.focus.y };
  }

  renderLookThumbs(looks: LookId[], w: number, h: number): Record<string, string> {
    const frame = this.rawFrame();
    const out: Record<string, string> = {};
    if (!frame || !this.project) return out;
    const c = document.createElement("canvas");
    let r: Renderer;
    try {
      r = new Renderer(c);
    } catch {
      return out;
    }
    r.resize(w, h);
    for (const id of looks) {
      const grade = computeGrade(id, 1, this.project.adjust);
      r.clear();
      r.draw(
        0,
        { source: frame.source, srcW: frame.w, srcH: frame.h, focusX: frame.fx, focusY: frame.fy, zoom: 1, kick: 1, opacity: 1, flash: 0, blur: 0, glitch: 0, slide: 0 },
        grade,
        0,
      );
      out[id] = c.toDataURL("image/jpeg", 0.8);
    }
    const lose = (c.getContext("webgl") as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return out;
  }

  /** Full-resolution still of the current frame (for a Reel cover). */
  async coverFrame(): Promise<Blob | null> {
    const p = this.project;
    if (!p) return null;
    const { w, h } = ASPECTS[p.aspect];
    const [pw, ph] = [this.canvas.width, this.canvas.height];
    this.setSize(w, h);
    this.syncPlayers(this.time);
    this.renderFrame(this.time);
    const blob = await new Promise<Blob | null>((res) => this.canvas.toBlob(res, "image/jpeg", 0.92));
    this.setSize(pw, ph);
    this.renderFrame(this.time);
    return blob;
  }

  // -------------------------------------------------------------- export

  private async prepareAt(t: number, timeoutMs: number) {
    const until = performance.now() + timeoutMs;
    for (;;) {
      this.syncPlayers(t);
      const p = this.project!;
      const layers = layersAt(p.segments, this.starts, t);
      const ready = layers.every((l) => {
        const seg = p.segments[l.index];
        if (!this.media.has(seg.clipId)) return true;
        const pl = this.players.find((x) => x.segId === seg.id);
        return !!pl && pl.el.readyState >= 3 && !pl.el.seeking;
      });
      if (ready || performance.now() > until) return;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  async exportVideo(opts: ExportOptions): Promise<ExportResult> {
    const p = this.project;
    if (!p || !p.segments.length) throw new Error("Add some shots to the timeline first.");
    const fmt = exportFormat();
    if (!fmt) throw new Error("This browser can't record video. Try Chrome, Edge or Safari.");
    const capture = (this.canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream;
    if (!capture) throw new Error("This browser can't record the canvas. Try Chrome, Edge or Safari.");
    this.pause();
    const ctx = this.ensureAudio();
    const dest = ctx.createMediaStreamDestination();
    this.master!.disconnect();
    this.master!.connect(dest);
    const [pw, ph] = [this.canvas.width, this.canvas.height];
    const wasLoop = this.loop;
    this.exporting = true;
    this.loop = false;
    this.setSize(opts.width, opts.height);
    if (!opts.includeMusic && this.musicVol) this.musicVol.gain.value = 0;
    let wake: { release(): Promise<void> } | null = null;
    try {
      wake = await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock
        ?.request("screen")
        .catch(() => null) ?? null;
    } catch {
      wake = null;
    }
    const restore = () => {
      this.exporting = false;
      this.loop = wasLoop;
      this.playing = false;
      this.stopMusic();
      cancelAnimationFrame(this.raf);
      this.onEnd = null;
      try {
        this.master!.disconnect();
      } catch {
        // ignore
      }
      this.master!.connect(ctx.destination);
      if (this.musicVol && this.project) this.musicVol.gain.value = this.project.musicVolume;
      this.setSize(pw, ph);
      this.time = 0;
      void wake?.release().catch(() => {});
      this.requestRender();
      this.emit();
    };

    try {
      this.time = 0;
      await this.prepareAt(0, 5000);
      this.renderFrame(0);
      const stream = capture.call(this.canvas, opts.fps);
      for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
      const rec = new MediaRecorder(stream, {
        mimeType: fmt.mime,
        videoBitsPerSecond: opts.bitrate,
        audioBitsPerSecond: 192_000,
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
      const ended = new Promise<void>((res) => (this.onEnd = res));
      const aborted = new Promise<void>((res) => opts.signal.addEventListener("abort", () => res(), { once: true }));
      const progress = setInterval(() => opts.onProgress(Math.min(1, this.time / Math.max(0.01, this.total))), 100);
      rec.start(250);
      this.playing = true;
      this.restartClock(0);
      this.loopTick();
      await Promise.race([ended, aborted]);
      clearInterval(progress);
      await new Promise((r) => setTimeout(r, 180));
      rec.stop();
      await stopped;
      stream.getTracks().forEach((tr) => tr.stop());
      if (opts.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      opts.onProgress(1);
      return { blob: new Blob(chunks, { type: fmt.mime.split(";")[0] }), mime: fmt.mime, ext: fmt.ext };
    } finally {
      restore();
    }
  }
}
