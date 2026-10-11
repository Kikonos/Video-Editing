// Everything the UI can ask for. Keeps React components thin.

import { aiErrorMessage, fallbackCaption, runDirector, writeCaption } from "./engine/ai.ts";
import { analyzeClip, demoGrabber, snapshot, videoGrabber, type FrameGrabber } from "./engine/analyze.ts";
import { analyzeBeats, decodeAudio, encodeWav, loudnessEnvelope, waveformPeaks } from "./engine/audio.ts";
import { alternativeMoment, autoEdit, autoLength, captionText, fitMoment, planSlots, type DirectorPlan } from "./engine/autoedit.ts";
import { suggestSection } from "./engine/beats.ts";
import { DEMO_SCENES, synthDemoSong } from "./engine/demo.ts";
import { Engine } from "./engine/engine.ts";
import { aiCaps, getClaude, saveBlob } from "./engine/platform.ts";
import { segmentStarts, timelineBeats, totalDuration } from "./engine/timeline.ts";
import type { Aspect, Clip, Project, Segment, Song, TextOverlay } from "./engine/types.ts";
import { emptyProject, uid } from "./engine/types.ts";
import { store, toast } from "./store.ts";

export const engine = new Engine();

// Keep the engine in step with the store.
let lastProject: Project | null = null;
let lastClips: Clip[] | null = null;
let lastSongs: Song[] | null = null;
store.subscribe(() => {
  const s = store.get();
  if (s.project !== lastProject || s.clips !== lastClips || s.songs !== lastSongs) {
    lastProject = s.project;
    lastClips = s.clips;
    lastSongs = s.songs;
    engine.setData(s.project, s.clips, s.songs);
  }
});
engine.setData(store.get().project, [], []);

const files = new Map<string, File>();
let lastPlan: DirectorPlan | null = null;

const HUES = [28, 200, 330, 150, 265, 50, 185, 5, 95, 300];

function patchClip(id: string, patch: Partial<Clip>) {
  store.set((s) => ({ ...s, clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

function currentSong(): Song | null {
  const s = store.get();
  return s.songs.find((x) => x.id === s.project.songId) ?? null;
}

// ------------------------------------------------------------------ import

const queue: { id: string; grab: () => Promise<FrameGrabber>; file?: File }[] = [];
let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    let g: FrameGrabber | null = null;
    try {
      g = await job.grab();
      const thumb = await snapshot(g, Math.min(1.2, g.duration * 0.25), 320);
      patchClip(job.id, { width: g.width, height: g.height, duration: g.duration, thumb, status: "analyzing", progress: 0 });
      let loud: Float32Array | null = null;
      let hasAudio = false;
      if (job.file && job.file.size < 250 * 1024 * 1024) {
        try {
          const buf = await decodeAudio(job.file);
          loud = loudnessEnvelope(buf);
          hasAudio = buf.duration > 0.5;
        } catch {
          hasAudio = false;
        }
      }
      let lastP = 0;
      const analysis = await analyzeClip(job.id, g, loud, (p) => {
        if (p - lastP > 0.03 || p >= 1) {
          lastP = p;
          patchClip(job.id, { progress: p });
        }
      });
      patchClip(job.id, { analysis, status: "ready", progress: 1, hasAudio });
    } catch (e) {
      patchClip(job.id, { status: "error", error: (e as Error).message || "Couldn't read this video." });
    } finally {
      g?.dispose();
    }
  }
  running = false;
  onQueueDrained();
}

function onQueueDrained() {
  const s = store.get();
  const ready = s.clips.filter((c) => c.status === "ready");
  if (ready.length && !s.project.segments.length && !s.ui.busy) {
    void generate({ silentAI: true }).then(() => {
      const ui = store.get().ui;
      if (ui.ai.available && ui.ai.images && ui.auto.useAI) {
        store.ui({ directorNote: "First cut made on your device. Press Re-cut the reel to let Claude pick the order and write a caption." });
      }
    });
  }
}

function clearDemo() {
  const s = store.get();
  if (!s.ui.demo) return;
  const demoIds = new Set(s.clips.filter((c) => c.kind === "demo").map((c) => c.id));
  const demoSongs = new Set(s.songs.filter((x) => x.source === "demo").map((x) => x.id));
  engine.pause();
  store.set((st) => ({
    ...st,
    clips: st.clips.filter((c) => !demoIds.has(c.id)),
    songs: st.songs.filter((x) => !demoSongs.has(x.id)),
    project: { ...emptyProject(), aspect: st.project.aspect },
    past: [],
    future: [],
    ui: { ...st.ui, demo: false, selectedSeg: null, selectedText: null, directorNote: null },
  }));
  lastPlan = null;
}

export function importFiles(list: FileList | File[]) {
  const arr = Array.from(list);
  const videos = arr.filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f.name));
  const audios = arr.filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|wav|aac|ogg|flac|opus)$/i.test(f.name));
  if (!videos.length && !audios.length) {
    toast("Those files aren't videos or audio. Drop MP4, MOV, MP3 or M4A files.", "error");
    return;
  }
  if (videos.length) clearDemo();
  const base = store.get().clips.length;
  const newClips: Clip[] = videos.map((f, i) => {
    const id = uid("c");
    const url = URL.createObjectURL(f);
    files.set(id, f);
    engine.registerMedia(id, url);
    queue.push({ id, grab: () => videoGrabber(url), file: f });
    return {
      id,
      name: f.name,
      kind: "video",
      duration: 0,
      width: 16,
      height: 9,
      thumb: "",
      hue: HUES[(base + i) % HUES.length],
      createdAt: f.lastModified || Date.now(),
      hasAudio: false,
      status: "loading",
      progress: 0,
    };
  });
  if (newClips.length) {
    store.set((s) => ({ ...s, clips: [...s.clips, ...newClips] }));
    store.ui({ leftTab: "footage" });
    void runQueue();
  }
  if (audios.length) void importMusic(audios[0]);
}

export async function importMusic(file: File, name = file.name, fromVideo = false) {
  if (store.get().ui.musicBusy) return;
  store.ui({ musicBusy: fromVideo || file.type.startsWith("video/") ? "Pulling the audio out of the video…" : "Reading the song…", leftTab: "music" });
  try {
    const buffer = await decodeAudio(file);
    if (buffer.duration < 2) throw new Error("short");
    store.ui({ musicBusy: "Finding the beat…" });
    await addSong(buffer, name, fromVideo || file.type.startsWith("video/") ? "video" : "audio");
    toast(`Music ready: ${Math.round(currentSong()?.bpm ?? 0)} BPM`);
  } catch {
    toast("Couldn't find audio in that file. Try a different video, or an MP3/M4A.", "error");
  } finally {
    store.ui({ musicBusy: null });
  }
}

async function addSong(buffer: AudioBuffer, name: string, source: Song["source"]) {
  const beats = await analyzeBeats(buffer);
  const id = uid("song");
  const song: Song = { id, name, source, duration: buffer.duration, ...beats, peaks: waveformPeaks(buffer) };
  engine.registerSong(id, buffer);
  const s = store.get();
  const len = s.project.segments.length ? totalDuration(s.project.segments) : s.ui.auto.length === "auto" ? 15 : s.ui.auto.length;
  const start = suggestSection(song, song.duration, len);
  store.set((st) => ({ ...st, songs: [...st.songs.filter((x) => x.source !== "demo" || st.ui.demo), song] }));
  store.edit((p) => ({ ...p, songId: id, songStart: start, musicVolume: 1 }));
  // Re-cut the existing reel to the new beat.
  if (store.get().project.segments.length) generate({ silentAI: true, keepPlan: true });
}

export async function clipAudioAsMusic(clipId: string) {
  const f = files.get(clipId);
  if (!f) return;
  await importMusic(f, f.name.replace(/\.[^.]+$/, "") + " (audio)", true);
}

export function selectSong(id: string) {
  const song = store.get().songs.find((x) => x.id === id);
  if (!song) return;
  const len = totalDuration(store.get().project.segments) || 15;
  store.edit((p) => ({ ...p, songId: id, songStart: suggestSection(song, song.duration, len) }));
  if (store.get().project.segments.length) generate({ silentAI: true, keepPlan: true });
}

export function removeSong(id: string) {
  store.set((s) => ({ ...s, songs: s.songs.filter((x) => x.id !== id) }));
  if (store.get().project.songId === id) store.edit((p) => ({ ...p, songId: null, songStart: 0 }));
}

export function setSongStart(t: number, commit = true) {
  const song = currentSong();
  if (!song) return;
  const total = totalDuration(store.get().project.segments) || 15;
  const start = Math.max(0, Math.min(t, Math.max(0, song.duration - Math.min(total, song.duration))));
  store.edit((p) => ({ ...p, songStart: start }), "songStart");
  if (commit && store.get().project.segments.length) generate({ silentAI: true, keepPlan: true });
}

export function bestSongStart() {
  const song = currentSong();
  if (!song) return;
  const total = totalDuration(store.get().project.segments) || 15;
  setSongStart(suggestSection(song, song.duration, total));
}

export async function saveMusic() {
  const song = currentSong();
  if (!song) return;
  const buf = engine.songBuffer(song.id);
  if (!buf) return;
  const wav = encodeWav(buf);
  const r = await saveBlob(song.name.replace(/\.[^.]+$/, "") + ".wav", wav);
  if (r.status === "saved") toast("Audio saved");
  else if (r.status !== "declined") toast(r.message ?? "Couldn't save the audio.", "error");
}

export function removeClip(id: string) {
  store.set((s) => ({ ...s, clips: s.clips.filter((c) => c.id !== id) }));
  store.edit((p) => ({ ...p, segments: p.segments.filter((x) => x.clipId !== id) }));
  files.delete(id);
}

// -------------------------------------------------------------------- demo

export async function loadDemo() {
  store.ui({ busy: { label: "Loading the sample reel…" }, demo: true });
  try {
    const clips: Clip[] = DEMO_SCENES.map((d, i) => ({
      id: "demo-" + d.scene,
      name: d.name,
      kind: "demo",
      demo: d.scene,
      duration: d.duration,
      width: 640,
      height: 360,
      thumb: "",
      hue: d.hue,
      createdAt: i,
      hasAudio: false,
      status: "analyzing",
      progress: 0,
    }));
    store.set((s) => ({ ...s, clips }));
    const songPromise = synthDemoSong().then((buf) => addSongQuiet(buf));
    for (const c of clips) {
      // The viewer may have imported their own footage meanwhile; stop quietly.
      if (!store.get().ui.demo) break;
      const g = demoGrabber(c.demo!, c.duration);
      const thumb = await snapshot(g, c.duration * 0.4, 320);
      const analysis = await analyzeClip(c.id, g, null, () => {});
      patchClip(c.id, { thumb, analysis, status: "ready", progress: 1 });
    }
    await songPromise;
    store.ui({ busy: null });
    if (!store.get().ui.demo) return;
    generate({ silentAI: true, history: false });
  } catch (e) {
    store.ui({ busy: null });
    toast("The sample reel couldn't load: " + (e as Error).message, "error");
  }
}

async function addSongQuiet(buffer: AudioBuffer) {
  const beats = await analyzeBeats(buffer);
  if (!store.get().ui.demo) return;
  const song: Song = { id: "demo-song", name: "Sample beat (122 BPM)", source: "demo", duration: buffer.duration, ...beats, peaks: waveformPeaks(buffer) };
  engine.registerSong(song.id, buffer);
  const start = suggestSection(song, song.duration, 15);
  store.set((s) => ({ ...s, songs: [song], project: { ...s.project, songId: song.id, songStart: start } }));
}

export function startFresh() {
  clearDemo();
  toast("Sample cleared. Import your videos to start.");
}

// ---------------------------------------------------------------- generate

export async function checkAi() {
  const caps = await aiCaps();
  store.ui({ ai: { ...caps, checked: true } });
}

let directorAbort: AbortController | null = null;

export async function generate(opts: { silentAI?: boolean; keepPlan?: boolean; history?: boolean } = {}) {
  const s = store.get();
  const ready = s.clips.filter((c) => c.status === "ready" && c.analysis?.moments.length);
  if (!ready.length) {
    toast("Import a few videos first. Each one is scanned for its best moments.", "error");
    return;
  }
  const song = currentSong();
  const auto = s.ui.auto;
  const length = auto.length === "auto" ? autoLength(ready) : auto.length;
  let songStart = s.project.songStart;
  if (song && songStart + Math.min(length, song.duration) > song.duration + 0.01) songStart = suggestSection(song, song.duration, length);

  let plan: DirectorPlan | null = opts.keepPlan ? lastPlan : null;
  let note: string | null = null;
  const wantAI = !opts.silentAI && auto.useAI && s.ui.ai.available && s.ui.ai.images;
  if (wantAI) {
    const claude = await getClaude();
    if (claude) {
      directorAbort = new AbortController();
      const ctl = directorAbort;
      const slots = planSlots(song, songStart, Math.min(length, song ? song.duration - songStart : length), auto.pace).length;
      store.ui({ busy: { label: "Claude is looking at your shots…", cancel: () => ctl.abort() } });
      try {
        plan = await runDirector(claude, ready, slots, { length, bpm: song?.bpm ?? null, style: auto.style }, ctl.signal);
        lastPlan = plan;
        note = "Claude picked and ordered these shots, and wrote the caption.";
      } catch (e) {
        note = aiErrorMessage(e);
        plan = null;
      } finally {
        store.ui({ busy: null });
        directorAbort = null;
      }
    }
  } else if (!opts.keepPlan) {
    lastPlan = null;
  }

  const base = store.get().project;
  let next = autoEdit(store.get().clips, song, base, { ...auto, length, songStart, plan });
  if (!next.caption) {
    const fb = fallbackCaption(auto.style);
    next = { ...next, caption: fb.caption, hashtags: fb.hashtags };
  }
  if (plan) {
    const labels = plan.labels;
    store.set((st) => ({
      ...st,
      clips: st.clips.map((c) =>
        c.analysis
          ? { ...c, analysis: { ...c.analysis, moments: c.analysis.moments.map((m) => (labels[m.id] ? { ...m, label: labels[m.id] } : m)) } }
          : c,
      ),
    }));
  }
  if (opts.history === false) store.set((st) => ({ ...st, project: next }));
  else store.edit(() => next);
  store.ui({ selectedSeg: null, selectedText: null, directorNote: note ?? (opts.silentAI ? store.get().ui.directorNote : null) });
  engine.seek(0);
}

export function stopDirector() {
  directorAbort?.abort();
}

/** Called synchronously inside click handlers so audio can start later. */
export function primeAudio() {
  try {
    engine.unlockAudio();
  } catch {
    // Web Audio unavailable; playback falls back to the system clock.
  }
}

// ---------------------------------------------------------------- segments

export function selectSeg(id: string | null) {
  store.ui({ selectedSeg: id, selectedText: null, ...(id ? { rightTab: "shot" as const } : {}) });
}

export function updateSeg(id: string, patch: Partial<Segment>, key?: string) {
  store.edit((p) => ({ ...p, segments: p.segments.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), key);
}

export function deleteSeg(id: string) {
  store.edit((p) => {
    const segments = p.segments.filter((x) => x.id !== id);
    if (segments[0]) segments[0] = { ...segments[0], transition: "cut" };
    return { ...p, segments };
  });
  store.ui({ selectedSeg: null });
}

export function duplicateSeg(id: string) {
  const id2 = uid("s");
  store.edit((p) => {
    const i = p.segments.findIndex((x) => x.id === id);
    if (i < 0) return p;
    const segments = [...p.segments];
    segments.splice(i + 1, 0, { ...p.segments[i], id: id2, transition: "cut" });
    return { ...p, segments };
  });
  store.ui({ selectedSeg: id2 });
}

export function moveSeg(id: string, to: number) {
  store.edit((p) => {
    const from = p.segments.findIndex((x) => x.id === id);
    if (from < 0) return p;
    const segments = [...p.segments];
    const [seg] = segments.splice(from, 1);
    segments.splice(Math.max(0, Math.min(segments.length, to)), 0, seg);
    if (segments[0].transition !== "cut") segments[0] = { ...segments[0], transition: "cut" };
    return { ...p, segments };
  });
}

export function splitAtPlayhead() {
  const t = engine.time;
  const p = store.get().project;
  const starts = segmentStarts(p.segments);
  const i = starts.findIndex((st, k) => t > st + 0.15 && t < st + p.segments[k].duration - 0.15);
  if (i < 0) {
    toast("Move the playhead inside a shot to split it.");
    return;
  }
  const seg = p.segments[i];
  const cut = t - starts[i];
  const id2 = uid("s");
  store.edit((pr) => {
    const segments = [...pr.segments];
    segments.splice(i, 1, { ...seg, duration: cut }, { ...seg, id: id2, srcIn: seg.srcIn + cut * seg.speed, duration: seg.duration - cut, transition: "cut" });
    return { ...pr, segments };
  });
  store.ui({ selectedSeg: id2 });
}

/** Lengthen or shorten a shot by whole beats; later shots move with it. */
export function nudgeBeats(id: string, delta: number) {
  const s = store.get();
  const p = s.project;
  const i = p.segments.findIndex((x) => x.id === id);
  if (i < 0) return;
  const song = currentSong();
  const starts = segmentStarts(p.segments);
  const end = starts[i] + p.segments[i].duration;
  const beats = timelineBeats(song, p.songStart, (song?.duration ?? 600) - p.songStart);
  let k = 0;
  let best = Infinity;
  beats.forEach((b, j) => {
    const d = Math.abs(b - end);
    if (d < best) {
      best = d;
      k = j;
    }
  });
  const target = beats[k + delta];
  if (target === undefined) return;
  const dur = target - starts[i];
  if (dur < 0.2) return;
  const clip = s.clips.find((c) => c.id === p.segments[i].clipId);
  const maxDur = clip ? (clip.duration - p.segments[i].srcIn) / p.segments[i].speed : Infinity;
  if (dur > maxDur + 0.01 && delta > 0) {
    toast("The clip runs out there. Slow it down or move its start earlier.");
    return;
  }
  updateSeg(id, { duration: dur });
}

export function swapTake(id: string) {
  const s = store.get();
  const seg = s.project.segments.find((x) => x.id === id);
  if (!seg) return;
  const m = alternativeMoment(s.clips, s.project, seg);
  if (!m) {
    toast("No other moments left. Import more footage for more options.");
    return;
  }
  const clip = s.clips.find((c) => c.id === m.clipId)!;
  const fit = fitMoment(clip, m, seg.duration, seg.speed);
  updateSeg(id, { clipId: m.clipId, momentId: m.id, srcIn: fit.srcIn, speed: fit.speed, reframe: null });
}

export function insertMoment(clipId: string, momentId: string) {
  const s = store.get();
  const clip = s.clips.find((c) => c.id === clipId);
  const m = clip?.analysis?.moments.find((x) => x.id === momentId);
  if (!clip || !m) return;
  const song = currentSong();
  const beat = song ? 60 / song.bpm : 0.5;
  const dur = beat * (beat < 0.45 ? 4 : 2);
  const fit = fitMoment(clip, m, dur, 1);
  const seg: Segment = { id: uid("s"), clipId, momentId, srcIn: fit.srcIn, duration: dur, speed: fit.speed, transition: "cut", reframe: null, zoom: 1 };
  const p = s.project;
  const starts = segmentStarts(p.segments);
  let at = p.segments.length;
  const sel = p.segments.findIndex((x) => x.id === s.ui.selectedSeg);
  if (sel >= 0) at = sel + 1;
  else if (p.segments.length) {
    const t = engine.time;
    const i = starts.findIndex((st, k) => t >= st && t < st + p.segments[k].duration);
    if (i >= 0) at = i + 1;
  }
  store.edit((pr) => {
    const segments = [...pr.segments];
    segments.splice(at, 0, seg);
    return { ...pr, segments };
  });
  store.ui({ selectedSeg: seg.id });
  engine.seek(segmentStarts(store.get().project.segments)[at] ?? 0);
}

// -------------------------------------------------------------------- text

export function addText() {
  const p = store.get().project;
  const total = totalDuration(p.segments) || 3;
  // The first text is the POV caption above the picture, for the whole reel.
  const hasAbove = p.texts.some((x) => x.place === "above");
  const tx: TextOverlay = hasAbove
    ? {
        ...captionText("your words", total, uid("t")),
        start: Math.min(engine.time, Math.max(0, total - 1)),
        end: Math.min(total, engine.time + 2.5),
        place: "below",
      }
    : captionText("POV: ", total, uid("t"));
  store.edit((pr) => ({ ...pr, texts: [...pr.texts, tx] }));
  store.ui({ selectedText: tx.id, rightTab: "text" });
}

export function updateText(id: string, patch: Partial<TextOverlay>, key?: string) {
  store.edit((p) => ({ ...p, texts: p.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), key);
}

export function deleteText(id: string) {
  store.edit((p) => ({ ...p, texts: p.texts.filter((x) => x.id !== id) }));
  store.ui({ selectedText: null });
}

// ----------------------------------------------------------------- project

export function setProject(patch: Partial<Project>, key?: string) {
  store.edit((p) => ({ ...p, ...patch }), key);
}

export function setAspect(aspect: Aspect) {
  setProject({ aspect });
}

let captionAbort: AbortController | null = null;

export async function newCaption(): Promise<void> {
  const s = store.get();
  const claude = s.ui.ai.available ? await getClaude() : null;
  if (!claude) {
    const fb = fallbackCaption(s.ui.auto.style, Math.floor(Math.random() * 1000));
    setProject({ caption: fb.caption, hashtags: fb.hashtags });
    return;
  }
  captionAbort?.abort();
  captionAbort = new AbortController();
  const labels: string[] = [];
  for (const seg of s.project.segments) {
    const clip = s.clips.find((c) => c.id === seg.clipId);
    const m = clip?.analysis?.moments.find((x) => x.id === seg.momentId);
    const l = m?.label ?? clip?.name;
    if (l && !labels.includes(l)) labels.push(l);
  }
  try {
    const r = await writeCaption(claude, labels.slice(0, 12), s.ui.auto.style, s.project.caption, captionAbort.signal);
    if (r.caption) setProject({ caption: r.caption, hashtags: r.hashtags.length ? r.hashtags : s.project.hashtags });
  } catch (e) {
    if ((e as { code?: string }).code !== "cancelled") toast(aiErrorMessage(e).replace("the on-device picks were used", "the caption wasn't changed"), "error");
  }
}

export async function saveCover() {
  const blob = await engine.coverFrame();
  if (!blob) return;
  const r = await saveBlob("reel-cover.jpg", blob);
  if (r.status === "saved") toast("Cover image saved");
  else if (r.status !== "declined") toast(r.message ?? "Couldn't save the cover.", "error");
}
