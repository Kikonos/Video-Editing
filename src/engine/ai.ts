// "AI Director": shows Claude a numbered contact sheet of the best candidate
// shots and gets back a running order, shot labels and an Instagram caption. Falls back to on-device choices when Claude isn't there.

import type { DirectorPlan } from "./autoedit.ts";
import type { SampleFn } from "./platform.ts";
import type { Clip, Moment, StyleId } from "./types.ts";

const TILE = 256;
const COLS = 6;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Top candidates across all clips, best first, at most `max`, spread over clips. */
export function candidates(clips: Clip[], max: number): Moment[] {
  const all: Moment[] = [];
  for (const c of clips) if (c.status === "ready" && c.analysis) all.push(...c.analysis.moments.filter((m) => m.thumb));
  const perClip = new Map<string, number>();
  const sorted = [...all].sort((a, b) => b.score - a.score);
  const out: Moment[] = [];
  const cap = Math.max(3, Math.ceil(max / Math.max(1, clips.length)) + 2);
  for (const m of sorted) {
    if (out.length >= max) break;
    const n = perClip.get(m.clipId) ?? 0;
    if (n >= cap) continue;
    perClip.set(m.clipId, n + 1);
    out.push(m);
  }
  return out;
}

export async function contactSheet(moments: Moment[]): Promise<Blob> {
  const rows = Math.ceil(moments.length / COLS);
  const c = document.createElement("canvas");
  c.width = COLS * TILE;
  c.height = rows * TILE;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < moments.length; i++) {
    const img = moments[i].thumb ? await loadImage(moments[i].thumb!) : null;
    const x = (i % COLS) * TILE;
    const y = Math.floor(i / COLS) * TILE;
    if (img) {
      const k = Math.min((TILE - 8) / img.width, (TILE - 8) / img.height);
      const w = img.width * k;
      const h = img.height * k;
      ctx.drawImage(img, x + (TILE - w) / 2, y + (TILE - h) / 2, w, h);
    }
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x + 6, y + 6, 46, 34);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 24px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x + 29, y + 24);
  }
  return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("canvas"))), "image/jpeg", 0.85));
}

const STYLE_WORDS: Record<StyleId, string> = {
  cinema: "cinematic travel montage: widescreen film frame, moody teal and gold grade, a hard cut on every beat",
  roadtrip: "nostalgic road-trip-with-friends home video: faded warm film, relaxed cuts",
  summer: "summer holiday montage: clean sunny colour, a hard cut on every beat",
};

interface DirectorReply {
  shots?: { n?: number; label?: string }[];
  caption?: string;
  hashtags?: string[];
}

export async function runDirector(
  claude: SampleFn,
  clips: Clip[],
  shotsNeeded: number,
  info: { length: number; bpm: number | null; style: StyleId },
  signal: AbortSignal,
): Promise<DirectorPlan> {
  const cands = candidates(clips, 24);
  if (!cands.length) throw new Error("No analysed shots yet.");
  const sheet = await contactSheet(cands);
  const clipName = new Map(clips.map((c) => [c.id, c.name]));
  const notes = cands
    .map((m, i) => {
      const motion = m.motion > 0.66 ? "high" : m.motion > 0.33 ? "medium" : "low";
      return `${i + 1}: ${clipName.get(m.clipId) ?? "clip"}, quality ${Math.round(m.score * 100)}, motion ${motion}`;
    })
    .join("\n");
  const want = Math.min(shotsNeeded, cands.length);
  const prompt = `You are editing an Instagram Reel from someone's own footage of their life: trips, friends, nights out, golden hours.

The style is a ${STYLE_WORDS[info.style]}. Think of reels captioned "Beautiful ain't it" or "missing this...": no talking to camera, no on-screen effects, just a stream of beautiful real moments cut to the music, one shot per beat, every shot a different place or moment.

The image is a contact sheet of ${cands.length} candidate shots, numbered 1-${cands.length} in reading order (left to right, top to bottom). Each tile is one moment from their clips.

Shot notes (number: clip file, on-device quality score 0-100, motion):
${notes}

The reel is ${Math.round(info.length)} seconds long, cut to music${info.bpm ? ` at ${Math.round(info.bpm)} BPM` : ""}, with ${shotsNeeded} shot slots.

Pick ${want} shots and put them in playing order:
- Favour atmosphere: wide landscapes and water, golden hour and sunsets, silhouettes, people seen from behind or lost in the moment, friends laughing, night lights, movement through a place (car windows, boats, trains, roads).
- Open with the most beautiful, cinematic shot.
- Keep it varied: never two near-identical shots, and spread out shots from the same place.
- Put the most alive, energetic moments in the second half, where the music lifts; end on a calm or wistful shot (a sunset, someone walking away, a view).
- Leave out blurry, badly exposed, accidental (pocket, floor, lens cap) or posed-to-camera shots.

Also write:
- "caption": the Instagram caption: short and understated, like "Beautiful ain't it..." or "missing this...", at most one emoji.
- "hashtags": 3-6 relevant hashtags.
- a 2-5 word "label" describing each chosen shot.

Reply with only JSON, like:
{"shots":[{"n":3,"label":"sunset over the bay"},{"n":7,"label":"friends on the boat"}],"caption":"missing this...","hashtags":["#summer","#travel"]}`;

  const reply = (await claude.json(prompt, { images: [sheet], signal })) as DirectorReply;
  const order: string[] = [];
  const labels: Record<string, string> = {};
  for (const s of reply.shots ?? []) {
    const n = Number(s.n);
    const m = cands[n - 1];
    if (!m) continue;
    order.push(m.id);
    if (s.label) labels[m.id] = String(s.label).slice(0, 60);
  }
  if (!order.length) throw new Error("Claude didn't pick any shots.");
  const tags = (Array.isArray(reply.hashtags) ? reply.hashtags : [])
    .map((h) => String(h).trim())
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : "#" + h))
    .slice(0, 10);
  return {
    order,
    labels,
    caption: typeof reply.caption === "string" ? reply.caption.slice(0, 400) : "",
    hashtags: tags,
  };
}

export async function writeCaption(
  claude: SampleFn,
  labels: string[],
  style: StyleId,
  current: string,
  signal: AbortSignal,
): Promise<{ caption: string; hashtags: string[] }> {
  const prompt = `Write a fresh Instagram caption for a ${STYLE_WORDS[style]}.
Shots in the reel: ${labels.length ? labels.join("; ") : "travel and time with friends"}.
${current ? `Current caption (write a different one): ${current}\n` : ""}Keep it short and understated, like "Beautiful ain't it..." or "missing this...": a few words, lowercase is fine, at most one emoji. Then 3-6 relevant hashtags.
Reply with only JSON: {"caption":"...","hashtags":["#..."]}`;
  const r = (await claude.json(prompt, { modelTier: "quick", signal, cache: false })) as { caption?: string; hashtags?: string[] };
  return {
    caption: String(r.caption ?? "").slice(0, 400),
    hashtags: (r.hashtags ?? []).map((h) => String(h).trim()).filter(Boolean).map((h) => (h.startsWith("#") ? h : "#" + h)).slice(0, 10),
  };
}

const FALLBACK: Record<StyleId, { caption: string[]; tags: string[] }> = {
  cinema: {
    caption: ["Beautiful ain't it...", "Somewhere I'd go back to.", "Frames from a good year."],
    tags: ["#cinematic", "#travel", "#reels", "#goldenhour", "#wanderlust"],
  },
  roadtrip: {
    caption: ["missing this...", "best people, best days", "take me back"],
    tags: ["#roadtrip", "#summer", "#friends", "#memories", "#reels"],
  },
  summer: {
    caption: ["missing this...", "summer, on repeat", "salt, sun, no plans"],
    tags: ["#summer", "#holiday", "#sea", "#travel", "#reels"],
  },
};

export function fallbackCaption(style: StyleId, seed = Date.now()): { caption: string; hashtags: string[] } {
  const f = FALLBACK[style];
  return { caption: f.caption[seed % f.caption.length], hashtags: f.tags };
}

export function aiErrorMessage(e: unknown): string {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case "not_granted":
    case "sampling_disabled":
      return "Claude isn't allowed for this page, so the on-device picks were used.";
    case "rate_limited":
      return "Claude is busy for you right now. The on-device picks were used; try again in a minute.";
    case "images_unavailable":
      return "This view can't send images to Claude, so the on-device picks were used.";
    case "cancelled":
      return "Stopped. The on-device picks were used.";
    case "invalid_json":
    case "empty_completion":
      return "Claude's answer couldn't be read, so the on-device picks were used. Try again.";
    default:
      return "Claude couldn't be reached, so the on-device picks were used.";
  }
}
