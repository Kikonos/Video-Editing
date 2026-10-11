// On-screen text, drawn with Canvas 2D on top of the graded video.

import type { TextOverlay, TextStyle } from "./types.ts";

export const TEXT_STYLES: Record<TextStyle, { label: string; family: string; weight: string; italic?: boolean; upper?: boolean }> = {
  bold: { label: "Headline", family: '"Anton", "Archivo", Impact, sans-serif', weight: "400", upper: true },
  serif: { label: "Editorial", family: '"Instrument Serif", Georgia, serif', weight: "400", italic: true },
  box: { label: "Sticker", family: '"Archivo", "Helvetica Neue", Arial, sans-serif', weight: "800" },
  neon: { label: "Neon", family: '"Archivo", "Helvetica Neue", Arial, sans-serif', weight: "700" },
  hand: { label: "Handwritten", family: '"Caveat", "Segoe Print", cursive', weight: "700" },
};

export const TEXT_FONTS_TO_LOAD = [
  '400 40px "Anton"',
  'italic 400 40px "Instrument Serif"',
  '800 40px "Archivo"',
  '700 40px "Archivo"',
  '700 40px "Caveat"',
];

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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawTexts(ctx: CanvasRenderingContext2D, texts: TextOverlay[], t: number, W: number, H: number): void {
  for (const tx of texts) {
    if (t < tx.start || t > tx.end || !tx.text.trim()) continue;
    const style = TEXT_STYLES[tx.style];
    const local = t - tx.start;
    const remain = tx.end - t;
    const inDur = 0.35;
    const outDur = 0.25;
    let alpha = Math.min(1, remain / outDur);
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
        dy = (1 - (1 - Math.pow(1 - k, 3))) * H * 0.03;
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
    const lines = wrap(ctx, content, W * 0.84);
    const lh = px * (tx.style === "bold" ? 1.02 : 1.15);
    const cx = W / 2;
    const cy = tx.y * H + dy;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    const top = -((lines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      const y = top + i * lh;
      if (tx.style === "box") {
        const w = ctx.measureText(line).width + px * 0.7;
        const h = px * 1.25;
        ctx.fillStyle = tx.color;
        roundRect(ctx, -w / 2, y - h / 2, w, h, px * 0.22);
        ctx.fill();
        ctx.fillStyle = contrastInk(tx.color);
        ctx.fillText(line, 0, y + px * 0.04);
      } else if (tx.style === "neon") {
        ctx.shadowColor = tx.color;
        ctx.shadowBlur = px * 0.6;
        ctx.fillStyle = tx.color;
        ctx.fillText(line, 0, y);
        ctx.shadowBlur = px * 0.2;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(line, 0, y);
      } else {
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = px * 0.25;
        ctx.shadowOffsetY = px * 0.04;
        ctx.fillStyle = tx.color;
        ctx.fillText(line, 0, y);
      }
    });
    ctx.restore();
  }
}

function contrastInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#111111";
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#111111" : "#ffffff";
}
