// Canvas 2D stand-in for the WebGL compositor, for browsers that refuse a
// WebGL context (iOS Lockdown Mode, some home-screen web apps, old GPUs).
// Same crop and framing; the grade is approximated with canvas filters where
// the browser has them, otherwise shots play ungraded.

import type { Grade } from "./looks.ts";
import { cropRect, Renderer, type Compositor, type LayerDraw } from "./renderer.ts";

/**
 * WebGL when the browser allows it, otherwise plain canvas drawing. Draw to
 * the returned compositor's canvas: it is a fresh one if WebGL claimed the
 * given canvas and then failed (a canvas keeps its first context type).
 */
export function createRenderer(canvas: HTMLCanvasElement): Compositor {
  try {
    return new Renderer(canvas);
  } catch (e) {
    console.warn("WebGL unavailable, drawing with canvas 2D instead:", e);
    try {
      return new Renderer2D(canvas);
    } catch {
      const fresh = document.createElement("canvas");
      fresh.className = canvas.className;
      return new Renderer2D(fresh);
    }
  }
}

export class Renderer2D implements Compositor {
  readonly kind = "2d";
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private vp: [number, number, number, number] = [0, 0, 1, 1];
  private filters: boolean;
  lost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("This browser can't draw video frames.");
    this.ctx = ctx;
    this.filters = typeof (ctx as { filter?: unknown }).filter === "string";
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.setBand(0, 0, w, h);
  }

  setBand(x: number, y: number, w: number, h: number): void {
    this.vp = [x, y, Math.max(1, w), Math.max(1, h)];
  }

  clear(): void {
    const c = this.ctx;
    c.globalAlpha = 1;
    c.fillStyle = "#000";
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(_slot: number, layer: LayerDraw, grade: Grade, _time: number): void {
    const c = this.ctx;
    const [bx, by, W, H] = this.vp;
    const [cx, cy, cw, ch] = cropRect(layer.srcW, layer.srcH, W, H, layer.focusX, layer.focusY, layer.zoom);
    // Same mapping as the shader: zoom `kick` about the band centre, shift by `slide` band widths.
    const k = Math.max(0.2, layer.kick);
    const dx = bx + ((-0.5 - layer.slide) * k + 0.5) * W;
    const dy = by + (0.5 - 0.5 * k) * H;
    c.save();
    c.beginPath();
    c.rect(bx, by, W, H);
    c.clip();
    c.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
    if (this.filters) c.filter = filterFor(grade, layer.blur * W * 0.04);
    try {
      c.drawImage(layer.source as CanvasImageSource, cx * layer.srcW, cy * layer.srcH, cw * layer.srcW, ch * layer.srcH, dx, dy, W * k, H * k);
    } catch {
      // Frame not decodable yet; leave what's there.
    }
    if (this.filters) c.filter = "none";
    if (grade.vignette > 0.01) {
      const r = Math.hypot(W, H) / 2;
      const g = c.createRadialGradient(bx + W / 2, by + H / 2, r * 0.35, bx + W / 2, by + H / 2, r);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${Math.min(0.8, grade.vignette)})`);
      c.fillStyle = g;
      c.fillRect(bx, by, W, H);
    }
    if (grade.fade > 0.005) {
      c.fillStyle = `rgba(128,128,128,${Math.min(0.5, grade.fade * 1.5)})`;
      c.fillRect(bx, by, W, H);
    }
    if (layer.flash > 0.005) {
      c.fillStyle = `rgba(255,255,255,${Math.min(1, layer.flash)})`;
      c.fillRect(bx, by, W, H);
    }
    c.restore();
  }

  overlay(source: TexImageSource): void {
    const c = this.ctx;
    c.save();
    c.globalAlpha = 1;
    c.drawImage(source as CanvasImageSource, 0, 0, this.canvas.width, this.canvas.height);
    c.restore();
  }
}

function filterFor(g: Grade, blurPx: number): string {
  const f = [
    `brightness(${Math.pow(2, g.exposure).toFixed(3)})`,
    `contrast(${g.contrast.toFixed(3)})`,
    `saturate(${(g.saturation * (1 - g.mono)).toFixed(3)})`,
  ];
  if (g.warmth > 0) f.push(`sepia(${Math.min(0.4, g.warmth * 0.25).toFixed(3)})`);
  if (blurPx > 0.5) f.push(`blur(${blurPx.toFixed(1)}px)`);
  return f.join(" ");
}
