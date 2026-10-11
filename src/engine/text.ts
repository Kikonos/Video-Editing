// On-screen text, drawn with Canvas 2D on top of the graded video.

import type { TextOverlay, TextStyle } from "./types.ts";

export const TEXT_STYLES: Record<TextStyle, { label: string; family: string; weight: string; italic?: boolean; upper?: boolean; shadow?: boolean }> = {
  caption: { label: "Caption", family: '"Tinos", "Times New Roman", Times, serif', weight: "400" },
  serif: { label: "Editorial", family: '"Instrument Serif", Georgia, serif', weight: "400", italic: true, shadow: true },
  bold: { label: "Headline", family: '"Anton", "Archivo", Impact, sans-serif', weight: "400", upper: true, shadow: true },
  hand: { label: "Handwritten", family: '"Caveat", "Segoe Print", cursive', weight: "700", shadow: true },
};


function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/**
 * Draw every text visible at time t. `band` is the picture rectangle (x, y, w, h)
 * so captions can sit in the black space just above or below it.
 */
export function drawTexts(
  ctx: CanvasRenderingContext2D,
  texts: TextOverlay[],
  t: number,
  W: number,
  H: number,
  band: [number, number, number, number] = [0, 0, W, H],
): void {
  for (const tx of texts) {
    if (t < tx.start || t > tx.end || !tx.text.trim()) continue;
    const style = TEXT_STYLES[tx.style] ?? TEXT_STYLES.caption;
    const local = t - tx.start;
    const remain = tx.end - t;
    const inDur = 0.35;
    const outDur = 0.25;
    let alpha = tx.anim === "none" ? 1 : Math.min(1, remain / outDur);
    let scale = 1;
    let dy = 0;
    let content = style.upper ? tx.text.toUpperCase() : tx.text;
    switch (tx.anim) {
      case "pop":
        scale = local < inDur ? Math.max(0.01, easeOutBack(local / inDur)) : 1;
        alpha *= Math.min(1, local / 0.08);
        break;
      case "fade":
        alpha *= Math.min(1, local / 0.4);
        break;
      case "rise": {
        const k = Math.min(1, local / 0.45);
        dy = Math.pow(1 - k, 3) * H * 0.03;
        alpha *= k;
        break;
      }
      case "type": {
        const n = Math.ceil(Math.min(1, local / Math.max(0.3, content.length * 0.045)) * content.length);
        content = content.slice(0, n);
        break;
      }
    }
    if (alpha <= 0) continue;
    const px = Math.max(8, tx.size * W);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = `${style.italic ? "italic " : ""}${style.weight} ${px}px ${style.family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = wrap(ctx, content, W * (tx.style === "caption" ? 0.72 : 0.84));
    const lh = px * (tx.style === "bold" ? 1.02 : 1.2);
    const half = ((lines.length - 1) * lh) / 2;
    const [, by, , bh] = band;
    const gap = px * 0.75;
    let cy = tx.y * H;
    if (tx.place === "above") {
      cy = by - gap - px / 2 - half;
      // No black space above a full-screen picture: sit just inside the top instead.
      if (cy - half - px / 2 < H * 0.03) cy = Math.max(by, 0) + H * 0.13 + half;
    } else if (tx.place === "below") {
      cy = by + bh + gap + px / 2 + half;
      if (cy + half + px / 2 > H * 0.97) cy = by + bh - H * 0.2 - half;
    }
    ctx.translate(W / 2, cy + dy);
    ctx.scale(scale, scale);
    lines.forEach((line, i) => {
      const y = -half + i * lh;
      if (style.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = px * 0.25;
        ctx.shadowOffsetY = px * 0.04;
      }
      ctx.fillStyle = tx.color;
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }
}
