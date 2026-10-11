// WebGL compositor: crops each shot to the output aspect (following the
// subject), grades it, and applies transition effects in one shader pass.

import type { Grade } from "./looks.ts";

export interface LayerDraw {
  source: TexImageSource;
  srcW: number;
  srcH: number;
  /** Centre of the crop in source coordinates, 0..1. */
  focusX: number;
  focusY: number;
  /** Crop zoom (>= 1) from the shot settings. */
  zoom: number;
  /** Extra zoom applied around the output centre (beat pulse, punch-in). */
  kick: number;
  opacity: number;
  flash: number;
  blur: number;
  glitch: number;
  /** Horizontal slide in output units (whip pans). */
  slide: number;
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_crop;
uniform float u_kick;
uniform float u_slide;
uniform float u_blur;
uniform float u_glitch;
uniform float u_opacity;
uniform float u_flash;
uniform float u_time;
uniform vec2 u_res;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_warmth;
uniform float u_fade;
uniform float u_vignette;
uniform float u_grain;
uniform float u_mono;
uniform float u_split;
uniform vec3 u_shadows;
uniform vec3 u_highlights;

vec3 src(vec2 uv) {
  vec2 p = (uv - 0.5) / u_kick + 0.5 + vec2(u_slide, 0.0);
  p = clamp(p, 0.0, 1.0);
  return texture2D(u_tex, u_crop.xy + p * u_crop.zw).rgb;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 overlay(vec3 a, vec3 b) {
  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
}

void main() {
  vec2 uv = v_uv;
  vec3 c;
  if (u_glitch > 0.001) {
    float band = floor(uv.y * 22.0);
    float n = hash(vec2(band, floor(u_time * 20.0)));
    vec2 j = uv + vec2((n - 0.5) * 0.12 * u_glitch * step(0.55, n), 0.0);
    float s = 0.025 * u_glitch;
    c = vec3(src(j + vec2(s, 0.0)).r, src(j).g, src(j - vec2(s, 0.0)).b);
  } else if (u_blur > 0.001) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 14; i++) {
      float k = float(i) / 13.0 - 0.5;
      acc += src(uv + vec2(k * u_blur * 0.22, 0.0));
    }
    c = acc / 14.0;
  } else {
    c = src(uv);
  }

  c *= exp2(u_exposure);
  c.r *= 1.0 + 0.1 * u_warmth;
  c.b *= 1.0 - 0.12 * u_warmth;
  c = clamp(c, 0.0, 1.0);
  // S-curve contrast keeps highlights from clipping as hard as a linear stretch.
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, clamp(u_contrast - 1.0, 0.0, 1.0) * 1.6);
  c = mix(vec3(0.5), c, min(u_contrast, 1.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_saturation);
  c = clamp(c, 0.0, 1.0);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 tone = mix(u_shadows, u_highlights, smoothstep(0.15, 0.85, lum));
  c = mix(c, overlay(c, tone), u_split);
  c = mix(c, vec3(lum), u_mono);
  c = mix(vec3(u_fade), vec3(1.0 - u_fade * 0.25), c);

  vec2 d = (uv - 0.5) * vec2(u_res.x / max(u_res.x, u_res.y), u_res.y / max(u_res.x, u_res.y)) * 1.6;
  c *= 1.0 - u_vignette * smoothstep(0.3, 1.0, length(d));
  c += (hash(uv * u_res + fract(u_time * 7.0) * 100.0) - 0.5) * u_grain;
  c = mix(c, vec3(1.0), u_flash);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), u_opacity);
}`;

const OVERLAY_FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

export function cropRect(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  fx: number,
  fy: number,
  zoom: number,
): [number, number, number, number] {
  const sa = srcW / Math.max(1, srcH);
  const oa = outW / Math.max(1, outH);
  let cw = 1;
  let ch = 1;
  if (sa > oa) cw = oa / sa;
  else ch = sa / oa;
  cw /= Math.max(1, zoom);
  ch /= Math.max(1, zoom);
  const x = Math.max(0, Math.min(1 - cw, fx - cw / 2));
  const y = Math.max(0, Math.min(1 - ch, fy - ch / 2));
  return [x, y, cw, ch];
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private u: Uniforms = {};
  private textures: WebGLTexture[] = [];
  private overlayProg: WebGLProgram;
  private overlayTex: WebGLTexture;
  private overlayLoc: WebGLUniformLocation | null;
  lost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const opts: WebGLContextAttributes = { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true };
    const gl = (canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts)) as WebGLRenderingContext | null;
    if (!gl) throw new Error("WebGL is not available in this browser.");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.prog = this.build(FRAG);
    this.overlayProg = this.build(OVERLAY_FRAG);
    this.overlayLoc = gl.getUniformLocation(this.overlayProg, "u_tex");
    this.overlayTex = this.makeTexture();
    gl.useProgram(this.prog);
    const names = [
      "u_tex", "u_crop", "u_kick", "u_slide", "u_blur", "u_glitch", "u_opacity", "u_flash", "u_time", "u_res",
      "u_exposure", "u_contrast", "u_saturation", "u_warmth", "u_fade", "u_vignette", "u_grain", "u_mono",
      "u_split", "u_shadows", "u_highlights",
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(this.prog, n);
    for (let i = 0; i < 2; i++) this.textures.push(this.makeTexture());
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    // Both programs bind a_pos to location 0 (see build), so one attribute setup serves both.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private build(frag: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, srcText: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, srcText);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader error");
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
    return p;
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  clear(): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw(slot: number, layer: LayerDraw, grade: Grade, time: number): void {
    if (this.lost) return;
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[slot % 2]);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source);
    } catch {
      // Frame not decodable yet; keep whatever the texture held.
    }
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.uniform1i(u.u_tex, 0);
    gl.uniform4fv(u.u_crop, cropRect(layer.srcW, layer.srcH, W, H, layer.focusX, layer.focusY, layer.zoom));
    gl.uniform1f(u.u_kick, Math.max(0.2, layer.kick));
    gl.uniform1f(u.u_slide, layer.slide);
    gl.uniform1f(u.u_blur, layer.blur);
    gl.uniform1f(u.u_glitch, layer.glitch);
    gl.uniform1f(u.u_opacity, layer.opacity);
    gl.uniform1f(u.u_flash, layer.flash);
    gl.uniform1f(u.u_time, time);
    gl.uniform2f(u.u_res, W, H);
    gl.uniform1f(u.u_exposure, grade.exposure);
    gl.uniform1f(u.u_contrast, grade.contrast);
    gl.uniform1f(u.u_saturation, grade.saturation);
    gl.uniform1f(u.u_warmth, grade.warmth);
    gl.uniform1f(u.u_fade, grade.fade);
    gl.uniform1f(u.u_vignette, grade.vignette);
    gl.uniform1f(u.u_grain, grade.grain);
    gl.uniform1f(u.u_mono, grade.mono);
    gl.uniform1f(u.u_split, grade.split);
    gl.uniform3fv(u.u_shadows, grade.shadows);
    gl.uniform3fv(u.u_highlights, grade.highlights);
    if (layer.opacity < 0.999) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Blend a transparent 2D canvas (text) over the frame. */
  overlay(source: TexImageSource): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.useProgram(this.overlayProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.overlayLoc, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
