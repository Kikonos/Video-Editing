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
  /** Picked by hand: always used by the auto-edit. */
  manual?: boolean;
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

/**
 * How a shot starts. Montage reels are almost all hard cuts; "smear" is the
 * motion-blur + white-flash bridge used once, where the song changes section.
 */
export type TransitionKind = "cut" | "fade" | "flash" | "smear";

/**
 * The picture sits in a horizontal band inside the black 9:16 Reel, like a
 * film frame. "full" fills the whole vertical screen instead.
 */
export type FrameId = "16:9" | "4:3" | "1:1" | "full";

export const FRAMES: Record<FrameId, { ratio: number; label: string }> = {
  "16:9": { ratio: 16 / 9, label: "Cinema" },
  "4:3": { ratio: 4 / 3, label: "Classic" },
  "1:1": { ratio: 1, label: "Square" },
  full: { ratio: 0, label: "Full screen" },
};

/** Vertical centre of the picture band, as a fraction of the frame height. */
export const BAND_CENTER = 0.45;

/** Picture band inside a W×H frame: x, y (from top), width, height. */
export function bandRect(frame: FrameId, W: number, H: number): [number, number, number, number] {
  const ratio = FRAMES[frame].ratio;
  if (!ratio) return [0, 0, W, H];
  const h = Math.min(H, Math.round(W / ratio));
  const y = Math.max(0, Math.min(H - h, Math.round(H * BAND_CENTER - h / 2)));
  return [0, y, W, h];
}

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

export type TextStyle = "caption" | "serif" | "bold" | "hand";
export type TextAnim = "none" | "fade" | "type" | "rise" | "pop";
/** Where text sits: in the black space above or below the picture, or anywhere. */
export type TextPlace = "above" | "below" | "free";

export interface TextOverlay {
  id: string;
  text: string;
  start: number;
  end: number;
  style: TextStyle;
  anim: TextAnim;
  place: TextPlace;
  /** Vertical position of the text block's centre for "free" text, 0 = top, 1 = bottom. */
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

export type LookId = "natural" | "cinema" | "summer" | "postcard" | "dusk" | "mono";

export interface Project {
  aspect: Aspect;
  frame: FrameId;
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

export type StyleId = "cinema" | "roadtrip" | "summer";
/** "beat": a cut on every beat. "two": every second beat. "story": relaxed, 2–4 beats following the phrase. */
export type Pace = "beat" | "two" | "story";

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
    frame: "16:9",
    look: "cinema",
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
