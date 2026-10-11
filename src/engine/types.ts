// Shared data model. Everything in here is plain JSON so the project can be
// snapshotted for undo/redo; heavy objects (File, AudioBuffer, <video>) live in
// the engine, keyed by id.

export type Aspect = "9:16" | "4:5" | "1:1" | "16:9";

export const ASPECTS: Record<Aspect, { w: number; h: number; label: string }> = {
  "9:16": { w: 1080, h: 1920, label: "Reel" },
  "4:5": { w: 1080, h: 1350, label: "Feed" },
  "1:1": { w: 1080, h: 1080, label: "Square" },
  "16:9": { w: 1920, h: 1080, label: "Wide" },
};

export interface FrameSample {
  t: number;
  score: number;
  sharp: number;
  motion: number;
  color: number;
  exposure: number;
  audio: number;
  faces: number;
  /** Where the interesting part of the frame is, 0..1. Drives auto-reframe. */
  fx: number;
  fy: number;
  /** A scene change happens between the previous sample and this one. */
  cut: boolean;
}

export interface Moment {
  id: string;
  clipId: string;
  /** Peak time inside the clip, seconds. */
  t: number;
  start: number;
  end: number;
  score: number;
  motion: number;
  thumb?: string;
  label?: string;
}

export interface ClipAnalysis {
  step: number;
  samples: FrameSample[];
  moments: Moment[];
  /** 0..1 average of the clip's best moments. */
  quality: number;
}

export type DemoScene = "golden" | "ocean" | "city" | "party" | "road";

export interface Clip {
  id: string;
  name: string;
  kind: "video" | "demo";
  demo?: DemoScene;
  duration: number;
  width: number;
  height: number;
  thumb: string;
  hue: number;
  createdAt: number;
  hasAudio: boolean;
  status: "loading" | "analyzing" | "ready" | "error";
  progress: number;
  error?: string;
  analysis?: ClipAnalysis;
}

export interface Song {
  id: string;
  name: string;
  source: "video" | "audio" | "demo";
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  /** Loudness per beat (from beat i to i+1), 0..1. */
  beatEnergy: number[];
  /** Waveform envelope for drawing, 0..1 per bin. */
  peaks: number[];
}

export type TransitionKind = "cut" | "fade" | "flash" | "zoom" | "whip" | "glitch";

export interface Segment {
  id: string;
  clipId: string;
  momentId?: string;
  /** Where the shot starts inside the source clip, seconds. */
  srcIn: number;
  /** Length on the timeline, seconds. */
  duration: number;
  speed: number;
  /** Transition into this shot from the previous one. */
  transition: TransitionKind;
  /** Horizontal framing 0..1, or null to follow the subject automatically. */
  reframe: number | null;
  zoom: number;
}

export type TextStyle = "bold" | "serif" | "box" | "neon" | "hand";
export type TextAnim = "pop" | "fade" | "type" | "rise";

export interface TextOverlay {
  id: string;
  text: string;
  start: number;
  end: number;
  style: TextStyle;
  anim: TextAnim;
  /** Vertical position of the text block's centre, 0 = top, 1 = bottom. */
  y: number;
  /** Font size as a fraction of the frame width. */
  size: number;
  color: string;
}

export interface Adjust {
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
  fade: number;
  vignette: number;
  grain: number;
}

export type LookId = "natural" | "vivid" | "golden" | "teal" | "film" | "mono" | "moody" | "dreamy";

export interface Project {
  aspect: Aspect;
  look: LookId;
  lookAmount: number;
  adjust: Adjust;
  /** Zoom kick on every beat, 0..1. */
  beatPulse: number;
  musicVolume: number;
  clipVolume: number;
  fadeOut: boolean;
  songId: string | null;
  /** Where in the song the reel starts, seconds. */
  songStart: number;
  segments: Segment[];
  texts: TextOverlay[];
  caption: string;
  hashtags: string[];
}

export type StyleId = "clean" | "hype" | "cinematic" | "vintage" | "moody";
export type Pace = "chill" | "balanced" | "hype";

export const NEUTRAL_ADJUST: Adjust = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
};

export function emptyProject(): Project {
  return {
    aspect: "9:16",
    look: "natural",
    lookAmount: 1,
    adjust: { ...NEUTRAL_ADJUST },
    beatPulse: 0,
    musicVolume: 1,
    clipVolume: 0,
    fadeOut: true,
    songId: null,
    songStart: 0,
    segments: [],
    texts: [],
    caption: "",
    hashtags: [],
  };
}

let counter = 0;
export function uid(prefix = ""): string {
  counter = (counter + 1) % 1e6;
  return prefix + Math.random().toString(36).slice(2, 8) + counter.toString(36);
}
