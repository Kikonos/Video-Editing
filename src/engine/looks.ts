// Colour looks and edit styles.

import type { Adjust, LookId, Pace, StyleId, TransitionKind } from "./types.ts";

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

export const LOOKS: Record<LookId, LookDef> = {
  natural: { label: "Natural", adjust: {} },
  vivid: { label: "Vivid", adjust: { saturation: 0.32, contrast: 0.14, exposure: 0.04 } },
  golden: {
    label: "Golden hour",
    adjust: { warmth: 0.55, saturation: 0.12, fade: 0.3, exposure: 0.06 },
    split: 0.3,
    shadows: [0.35, 0.2, 0.25],
    highlights: [1, 0.82, 0.55],
  },
  teal: {
    label: "Teal/orange",
    adjust: { contrast: 0.2, saturation: 0.08, warmth: 0.05 },
    split: 0.5,
    shadows: [0.0, 0.42, 0.5],
    highlights: [1, 0.66, 0.36],
  },
  film: {
    label: "Film",
    adjust: { fade: 0.55, saturation: -0.18, warmth: 0.22, grain: 0.4, contrast: -0.05, vignette: 0.3 },
    split: 0.22,
    shadows: [0.18, 0.28, 0.36],
    highlights: [1, 0.9, 0.72],
  },
  mono: { label: "Mono", adjust: { contrast: 0.28, grain: 0.25, vignette: 0.2 }, mono: 1 },
  moody: {
    label: "Moody",
    adjust: { saturation: -0.32, contrast: 0.16, exposure: -0.14, warmth: -0.15, vignette: 0.45 },
    split: 0.3,
    shadows: [0.08, 0.22, 0.32],
    highlights: [0.95, 0.88, 0.8],
  },
  dreamy: {
    label: "Dreamy",
    adjust: { exposure: 0.12, fade: 0.45, saturation: -0.06, contrast: -0.12, warmth: 0.12 },
    split: 0.28,
    shadows: [0.4, 0.3, 0.45],
    highlights: [1, 0.82, 0.88],
  },
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
  beatPulse: number;
  slowmo: boolean;
  pace: Pace;
  /** Transition for bar starts (downbeats). Cycles through the list. */
  bar: TransitionKind[];
  /** Transition where the music suddenly gets louder. */
  rise: TransitionKind;
  /** Transition for quiet passages. */
  calm: TransitionKind;
}

export const STYLES: Record<StyleId, StyleDef> = {
  clean: {
    label: "Clean",
    blurb: "Crisp beat cuts, true colour",
    look: "vivid",
    lookAmount: 0.6,
    adjust: {},
    beatPulse: 0,
    slowmo: false,
    pace: "balanced",
    bar: ["cut"],
    rise: "flash",
    calm: "cut",
  },
  hype: {
    label: "Hype",
    blurb: "Fast cuts, punch zooms, flashes",
    look: "vivid",
    lookAmount: 1,
    adjust: {},
    beatPulse: 0.55,
    slowmo: false,
    pace: "hype",
    bar: ["zoom", "glitch", "zoom", "whip"],
    rise: "flash",
    calm: "cut",
  },
  cinematic: {
    label: "Cinematic",
    blurb: "Slow motion, teal & orange, dissolves",
    look: "teal",
    lookAmount: 0.85,
    adjust: { vignette: 0.2 },
    beatPulse: 0,
    slowmo: true,
    pace: "chill",
    bar: ["cut"],
    rise: "flash",
    calm: "fade",
  },
  vintage: {
    label: "Film",
    blurb: "Warm stock, grain, soft dissolves",
    look: "film",
    lookAmount: 1,
    adjust: {},
    beatPulse: 0,
    slowmo: false,
    pace: "balanced",
    bar: ["fade"],
    rise: "flash",
    calm: "fade",
  },
  moody: {
    label: "Moody",
    blurb: "Muted tones, deep shadows, whips",
    look: "moody",
    lookAmount: 1,
    adjust: {},
    beatPulse: 0.2,
    slowmo: true,
    pace: "balanced",
    bar: ["whip", "cut"],
    rise: "whip",
    calm: "fade",
  },
};
