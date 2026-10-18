// Bridges to the Claude artifact runtime when the app runs as a published
// artifact (file saving, Claude calls), with plain-browser fallbacks.

import { zipSingle } from "./zip.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

interface ClaudeWindow {
  claude?: { use?: (name: string) => Promise<unknown> };
}

const w = window as unknown as ClaudeWindow;

/** True when running inside the Claude artifact viewer. */
export const inArtifact = typeof w.claude?.use === "function";

function use<T>(name: string): Promise<T | null> {
  if (!inArtifact) return Promise.resolve(null);
  return (w.claude!.use!(name) as Promise<T | null>).catch(() => null);
}

export interface SaveResult {
  status: "saved" | "declined" | "unavailable" | "error";
  message?: string;
}

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}

const SAVE_EXT = new Set(["mp4", "webm", "png", "jpg", "jpeg", "txt", "json", "zip"]);

const SHARE_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", jpg: "image/jpeg", png: "image/png", wav: "audio/wav" };

/**
 * On phones, hand the file to the share sheet: on an iPhone that offers
 * "Save Video" straight into Photos, where Instagram picks it up. A download
 * would land in Files instead. Null when sharing isn't possible.
 */
async function shareFile(filename: string, blob: Blob): Promise<SaveResult | null> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return null;
  if (!window.matchMedia("(pointer: coarse)").matches) return null;
  const type = SHARE_TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? blob.type;
  const file = new File([blob], filename, { type });
  if (!nav.canShare({ files: [file] })) return null;
  try {
    await nav.share({ files: [file] });
    return { status: "saved" };
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return { status: "declined" };
    // NotAllowedError (the tap was too long ago) and the like: fall back to a download.
    return null;
  }
}

export async function saveBlob(filename: string, blob: Blob): Promise<SaveResult> {
  if (!inArtifact) {
    const shared = await shareFile(filename, blob);
    if (shared) return shared;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { status: "saved" };
  }
  const dl = await use<DownloadsApi>("downloads");
  if (!dl) return { status: "unavailable", message: "Saving files isn't available in this view." };
  let name = filename;
  let data = blob;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!SAVE_EXT.has(ext)) {
    // The artifact viewer only saves a fixed list of types; wrap others in a zip.
    data = await zipSingle(filename, blob);
    name = filename.replace(/\.[^.]+$/, "") + ".zip";
  }
  try {
    await dl.save({ filename: name, data });
    return { status: "saved" };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "declined") return { status: "declined" };
    if (code === "rate_limited") return { status: "error", message: "A save is already waiting for your answer." };
    return { status: "unavailable", message: (e as { message?: string })?.message || "Saving failed." };
  }
}

export type SampleFn = AnyFn & {
  json: AnyFn;
  limits: () => Promise<{ maxPromptBytes: number; images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
};

let samplePromise: Promise<SampleFn | null> | null = null;

/** Claude, when this page runs as an artifact and the viewer allows it. */
export function getClaude(): Promise<SampleFn | null> {
  if (!samplePromise) samplePromise = use<SampleFn>("sample");
  return samplePromise;
}

export interface AiCaps {
  available: boolean;
  images: boolean;
}

export async function aiCaps(): Promise<AiCaps> {
  const s = await getClaude();
  if (!s) return { available: false, images: false };
  try {
    const l = await s.limits();
    return { available: true, images: !!l.images };
  } catch {
    return { available: true, images: false };
  }
}
