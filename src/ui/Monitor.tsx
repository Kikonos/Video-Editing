import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine, primeAudio, selectSeg, setProject, updateSeg } from "../actions.ts";
import { cropRect } from "../engine/renderer.ts";
import { formatTime, segmentStarts, timelineBeats, timelineDownbeats } from "../engine/timeline.ts";
import { ASPECTS, bandRect, FRAMES, type FrameId } from "../engine/types.ts";
import { store, useStore } from "../store.ts";
import { Segmented } from "./controls.tsx";
import { Icon } from "./icons.tsx";

export function useEngineTime(): number {
  return useSyncExternalStore(engine.subscribe, () => engine.time);
}

export function useEnginePlaying(): boolean {
  return useSyncExternalStore(engine.subscribe, () => engine.playing);
}

function timecode(t: number): string {
  const f = Math.floor((t % 1) * 30);
  return `${formatTime(t, false)}:${f.toString().padStart(2, "0")}`;
}

export function Monitor() {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const aspect = useStore((s) => s.project.aspect);
  const segments = useStore((s) => s.project.segments);
  const fullscreen = useStore((s) => s.ui.fullscreen);
  const demo = useStore((s) => s.ui.demo);
  const busy = useStore((s) => s.ui.busy);
  const scanningN = useStore((s) => s.clips.filter((c) => c.status === "loading" || c.status === "analyzing").length);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; start: number; span: number; id: string } | null>(null);
  const { w, h } = ASPECTS[aspect];

  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    host.current?.appendChild(engine.canvas);
  }, []);

  // Fit the screen inside the stage at the project's aspect ratio.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (aw <= 0 || ah <= 0) return;
      const k = Math.min(aw / w, ah / h);
      setFit({ w: Math.floor(w * k), h: Math.floor(h * k) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);

  const onPointerDown = (e: React.PointerEvent) => {
    const s = store.get();
    const p = s.project;
    if (!p.segments.length) return;
    const starts = segmentStarts(p.segments);
    let seg = p.segments.find((x) => x.id === s.ui.selectedSeg);
    const t = engine.time;
    const under = p.segments.find((x, i) => t >= starts[i] && t < starts[i] + x.duration);
    if (!seg || seg !== under) seg = under;
    if (!seg) return;
    const clip = s.clips.find((c) => c.id === seg!.clipId);
    if (!clip) return;
    const frame = engine.rawFrame();
    const [, , bw, bh] = bandRect(p.frame, w, h);
    const [, , cw] = cropRect(frame?.w ?? clip.width, frame?.h ?? clip.height, bw, bh, 0.5, 0.5, seg.zoom);
    if (cw >= 0.999) return; // Nothing to reframe: the shot already fills the width.
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: seg.reframe ?? frame?.fx ?? 0.5, span: cw, id: seg.id };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !screen.current) return;
    if (!dragging) {
      if (Math.abs(e.clientX - d.x) < 4) return;
      setDragging(true);
      if (store.get().ui.selectedSeg !== d.id) selectSeg(d.id);
    }
    const dx = (e.clientX - d.x) / screen.current.clientWidth;
    const v = Math.max(d.span / 2, Math.min(1 - d.span / 2, d.start - dx * d.span));
    updateSeg(d.id, { reframe: v }, "reframe-" + d.id);
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <section className="monitor" aria-label="Preview">
      <div className="stage" ref={stage}>
        <div
          className={`screen ${dragging ? "dragging" : ""}`}
          ref={screen}
          style={fit ? { width: fit.w, height: fit.h } : { aspectRatio: `${w} / ${h}`, height: "100%" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => {
            primeAudio();
            engine.toggle();
          }}
        >
          <div className="canvas-host" ref={host} />
          {!segments.length && !busy && (
            <div className="screen-empty">
              <Icon name="spark" size={28} />
              {scanningN > 0 ? (
                <p>
                  Finding the best moments in {scanningN} clip{scanningN === 1 ? "" : "s"}…
                  <br />
                  Your reel appears here as soon as it's done.
                </p>
              ) : (
                <p>Drop all your videos and add the song. Your reel appears here, cut to the beat.</p>
              )}
            </div>
          )}
          {demo && segments.length > 0 && <span className="demo-tag">Sample reel</span>}
        </div>
      </div>
      <Transport />
      {fullscreen && <FullView />}
    </section>
  );
}

/** The reel on its own, filling the screen. Tap to play or pause. */
function FullView() {
  const host = useRef<HTMLDivElement>(null);
  const playing = useEnginePlaying();
  const aspect = useStore((s) => s.project.aspect);
  const { w, h } = ASPECTS[aspect];

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const back = engine.canvas.parentElement;
    el.appendChild(engine.canvas);
    // Real fullscreen where the browser allows it (not on iPhone, where this view fills the screen instead).
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (root.requestFullscreen) void root.requestFullscreen().catch(() => {});
      else root.webkitRequestFullscreen?.();
    } catch {
      // stays as a full-window view
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.ui({ fullscreen: false });
    };
    const onExit = () => {
      if (!document.fullscreenElement) store.ui({ fullscreen: false });
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onExit);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onExit);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      back?.appendChild(engine.canvas);
    };
  }, []);

  return (
    <div
      className="fullview"
      role="dialog"
      aria-label="Full-screen preview"
      onClick={() => {
        primeAudio();
        engine.toggle();
      }}
    >
      <div
        className="fullview-screen"
        ref={host}
        style={{
          aspectRatio: `${w} / ${h}`,
          // As large as fits: limited by the height on tall screens, the width on wide ones.
          width: `min(100%, calc((100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) * ${w} / ${h}))`,
        }}
      />
      {!playing && (
        <span className="fullview-play" aria-hidden="true">
          <Icon name="play" size={34} />
        </span>
      )}
      <button
        className="fullview-close"
        type="button"
        aria-label="Close full screen"
        onClick={(e) => {
          e.stopPropagation();
          store.ui({ fullscreen: false });
        }}
      >
        <Icon name="close" size={22} />
      </button>
    </div>
  );
}

function Transport() {
  const t = useEngineTime();
  const playing = useEnginePlaying();
  const frame = useStore((s) => s.project.frame);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const songStart = useStore((s) => s.project.songStart);
  const segments = useStore((s) => s.project.segments);
  const [loop, setLoop] = useState(engine.loop);
  const total = engine.duration;

  let barBeat = "";
  if (segments.length) {
    const beats = timelineBeats(song, songStart, total);
    const downs = timelineDownbeats(song, songStart, total);
    const firstDown = downs[0] ?? 0;
    const passed = beats.filter((b) => b <= t + 0.001 && b >= firstDown - 0.001).length;
    if (passed > 0) barBeat = `${Math.floor((passed - 1) / 4) + 1}.${((passed - 1) % 4) + 1}`;
    else barBeat = "0.0";
  }

  return (
    <div className="transport">
      <button
        className="play"
        type="button"
        onClick={() => {
          primeAudio();
          engine.toggle();
        }}
        disabled={!segments.length}
        aria-label={playing ? "Pause" : "Play"}
        title="Play / pause (Space)"
      >
        <Icon name={playing ? "pause" : "play"} size={20} />
      </button>
      <div className="readout">
        <span className="tc num">{timecode(t)}</span>
        <span className="num dim">/ {timecode(total)}</span>
      </div>
      <div className="readout beatcount" title="Bar and beat of the music">
        <span className="eyebrow">Bar</span>
        <span className="num">{barBeat || "–"}</span>
      </div>
      <span className="spacer" />
      <button
        className={`icon-btn ${loop ? "on" : ""}`}
        type="button"
        title="Loop playback"
        aria-pressed={loop}
        onClick={() => {
          engine.loop = !engine.loop;
          setLoop(engine.loop);
        }}
      >
        <Icon name="loop" size={17} />
      </button>
      <button
        className="icon-btn"
        type="button"
        title="Watch full screen"
        aria-label="Watch full screen"
        disabled={!segments.length}
        onClick={() => {
          primeAudio();
          store.ui({ fullscreen: true });
          if (!engine.playing) engine.play();
        }}
      >
        <Icon name="frame" size={17} />
      </button>
      <Segmented<FrameId>
        label="Picture frame"
        value={frame}
        onChange={(v) => setProject({ frame: v })}
        options={(Object.keys(FRAMES) as FrameId[]).map((f) => ({
          value: f,
          label: f === "full" ? "Full" : f,
          title: f === "full" ? "Fill the whole vertical screen" : `${FRAMES[f].label} frame inside the 9:16 Reel`,
        }))}
      />
    </div>
  );
}
