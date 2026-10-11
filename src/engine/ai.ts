// "AI Director": shows Claude a numbered contact sheet of the best candidate
// shots and gets back a running order, shot labels, an on-screen title and an
// Instagram caption. Falls back to on-device choices when Claude isn't there.

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
  clean: "clean and bright",
  hype: "high-energy and punchy",
  cinematic: "cinematic and slow",
  vintage: "warm, nostalgic film",
  moody: "moody and atmospheric",
};

interface DirectorReply {
  shots?: { n?: number; label?: string }[];
  title?: string;
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
  const prompt = `You are editing a short Instagram Reel from someone's personal lifestyle footage.

The image is a contact sheet of ${cands.length} candidate shots, numbered 1-${cands.length} in reading order (left to right, top to bottom). Each tile is one moment from their clips.

Shot notes (number: clip file, on-device quality score 0-100, motion):
${notes}

The reel is ${Math.round(info.length)} seconds long, cut to music${info.bpm ? ` at ${Math.round(info.bpm)} BPM` : ""}, with a ${STYLE_WORDS[info.style]} feel. It has ${shotsNeeded} shot slots.

Pick ${want} shots and put them in playing order:
- Open with the most eye-catching shot, the hook that stops someone scrolling.
- Build a small story or vibe progression; put the most energetic shots in the second half, where the music peaks.
- End on a satisfying or calm shot.
- Leave out blurry, dark, accidental (pocket, floor, lens cap) or near-duplicate shots.

Also write:
- "title": short on-screen text for the opening, at most 5 words, no hashtags or emoji. Use "" if the footage speaks for itself.
- "caption": an Instagram caption, 1-2 short casual sentences in first person, at most one emoji.
- "hashtags": 5-8 relevant hashtags.
- a 2-5 word "label" describing each chosen shot.

Reply with only JSON, like:
{"shots":[{"n":3,"label":"sunset over the bay"},{"n":7,"label":"jumping off the dock"}],"title":"Summer, slowly","caption":"Golden hours with my favourite people ☀️","hashtags":["#summer","#goldenhour"]}`;

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
    title: typeof reply.title === "string" ? reply.title.slice(0, 60) : "",
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
  const prompt = `Write a fresh Instagram Reel caption for a ${STYLE_WORDS[style]} lifestyle reel.
Shots in the reel: ${labels.length ? labels.join("; ") : "everyday moments"}.
${current ? `Current caption (write a different one): ${current}\n` : ""}Keep it 1-2 short casual sentences in first person, at most one emoji, then 5-8 relevant hashtags.
Reply with only JSON: {"caption":"...","hashtags":["#..."]}`;
  const r = (await claude.json(prompt, { modelTier: "quick", signal, cache: false })) as { caption?: string; hashtags?: string[] };
  return {
    caption: String(r.caption ?? "").slice(0, 400),
    hashtags: (r.hashtags ?? []).map((h) => String(h).trim()).filter(Boolean).map((h) => (h.startsWith("#") ? h : "#" + h)).slice(0, 10),
  };
}

const FALLBACK: Record<StyleId, { caption: string[]; tags: string[] }> = {
  clean: {
    caption: ["Little moments, big days.", "Saving this one for the memories.", "A good week in 15 seconds."],
    tags: ["#reels", "#dailyvlog", "#lifestyle", "#goodvibes", "#weekend", "#memories"],
  },
  hype: {
    caption: ["Turn the volume up for this one 🔊", "No skips, only highlights.", "Main character energy."],
    tags: ["#reels", "#hype", "#lifestyle", "#weekendvibes", "#letsgo", "#explore"],
  },
  cinematic: {
    caption: ["Slowing it all down for a second.", "Some days feel like a film.", "Frames from a good day."],
    tags: ["#cinematic", "#reels", "#filmmaking", "#goldenhour", "#visualsoflife", "#moodygrams"],
  },
  vintage: {
    caption: ["Feels like an old home video already.", "Warm days, softer memories.", "Shot on feelings."],
    tags: ["#filmlook", "#vintagevibes", "#reels", "#memories", "#nostalgia", "#lifestyle"],
  },
  moody: {
    caption: ["Quiet hours.", "Somewhere between the lights.", "Late nights, slow thoughts."],
    tags: ["#moody", "#reels", "#nightvibes", "#citylights", "#aesthetic", "#visualsoflife"],
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
