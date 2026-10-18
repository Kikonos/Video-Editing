// Colour looks and edit styles.

import type { Adjust, FrameId, LookId, Pace, StyleId } from "./types.ts";

type RGB = [number, number, number];

export interface LookDef {
  label: string;
  /** Slider-unit values, same scale as the Adjust panel (-1..1, 0..1). */
  adjust: Partial<Adjust>;
  mono?: number;
  split?: number;
  shadows?: RGB;
  highlights?: RGB;
}

// Grades matched to the reference reels: "cinema" to the moody travel montage
// (teal shadows, golden highlights, deep blacks), "summer" to the faded
// road-trip home video, "postcard" to clean, rich holiday colour.
export const LOOKS: Record<LookId, LookDef> = {
  cinema: {
    label: "Cinema",
    adjust: { contrast: 0.12, saturation: -0.16, exposure: -0.1, warmth: 0.12, grain: 0.3, vignette: 0.22 },
    split: 0.45,
    shadows: [0.1, 0.36, 0.4],
    highlights: [1, 0.78, 0.48],
  },
  summer: {
    label: "Summer film",
    adjust: { fade: 0.5, saturation: -0.12, contrast: -0.12, warmth: 0.25, exposure: 0.04, grain: 0.22 },
    split: 0.25,
    shadows: [0.3, 0.26, 0.3],
    highlights: [1, 0.86, 0.68],
  },
  postcard: {
    label: "Postcard",
    adjust: { saturation: 0.14, contrast: 0.08, warmth: 0.1, exposure: 0.03 },
    split: 0.12,
    shadows: [0.12, 0.32, 0.42],
    highlights: [1, 0.88, 0.7],
  },
  dusk: {
    label: "Dusk",
    adjust: { saturation: -0.3, contrast: 0.1, exposure: -0.16, warmth: -0.2, grain: 0.25, vignette: 0.35 },
    split: 0.3,
    shadows: [0.08, 0.22, 0.34],
    highlights: [0.95, 0.86, 0.76],
  },
  mono: { label: "Mono", adjust: { contrast: 0.22, grain: 0.3, vignette: 0.2 }, mono: 1 },
  natural: { label: "Natural", adjust: {} },
};

/** Final values the shader reads. */
export interface Grade {
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
  fade: number;
  vignette: number;
  grain: number;
  mono: number;
  split: number;
  shadows: RGB;
  highlights: RGB;
}

export function computeGrade(look: LookId, amount: number, adjust: Adjust): Grade {
  const def = LOOKS[look];
  const v = (k: keyof Adjust) => (def.adjust[k] ?? 0) * amount + adjust[k];
  return {
    exposure: v("exposure") * 0.8,
    contrast: 1 + v("contrast") * 0.6,
    saturation: Math.max(0, 1 + v("saturation")),
    warmth: v("warmth"),
    fade: Math.max(0, v("fade")) * 0.16,
    vignette: Math.max(0, v("vignette")) * 0.75,
    grain: Math.max(0, v("grain")) * 0.11,
    mono: (def.mono ?? 0) * amount,
    split: (def.split ?? 0) * amount,
    shadows: def.shadows ?? [0.5, 0.5, 0.5],
    highlights: def.highlights ?? [0.5, 0.5, 0.5],
  };
}

export interface StyleDef {
  label: string;
  blurb: string;
  look: LookId;
  lookAmount: number;
  adjust: Partial<Adjust>;
  frame: FrameId;
  pace: Pace;
  /** Every Nth shot continues the same take, cut tighter ("punch-in"). 0 = never. */
  punchIn: number;
  /** One motion-blur + flash bridge where the song changes section. */
  smear: boolean;
}

export const STYLES: Record<StyleId, StyleDef> = {
  cinema: {
    label: "Cinema",
    blurb: "16:9 film frame, a cut on every beat, teal and gold",
    look: "cinema",
    lookAmount: 1,
    adjust: {},
    frame: "16:9",
    pace: "beat",
    punchIn: 7,
    smear: true,
  },
  roadtrip: {
    label: "Road trip",
    blurb: "4:3 frame, relaxed cuts, faded summer film",
    look: "summer",
    lookAmount: 1,
    adjust: {},
    frame: "4:3",
    pace: "story",
    punchIn: 0,
    smear: false,
  },
  summer: {
    label: "Holiday",
    blurb: "Square frame, a cut on every beat, clean summer colour",
    look: "postcard",
    lookAmount: 1,
    adjust: {},
    frame: "1:1",
    pace: "beat",
    punchIn: 9,
    smear: false,
  },
};
