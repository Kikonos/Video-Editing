import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine, primeAudio, selectSeg, setProject, updateSeg } from "../actions.ts";
import { cropRect } from "../engine/renderer.ts";
import { formatTime, segmentStarts, timelineBeats, timelineDownbeats } from "../engine/timeline.ts";
import { ASPECTS, bandRect, FRAMES, type Aspect, type FrameId } from "../engine/types.ts";
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
  const safe = useStore((s) => s.ui.safeZones);
  const demo = useStore((s) => s.ui.demo);
  const busy = useStore((s) => s.ui.busy);
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
          {safe && (aspect === "9:16" || aspect === "4:5") && <SafeZones aspect={aspect} />}
          {!segments.length && !busy && (
            <div className="screen-empty">
              <Icon name="spark" size={28} />
              <p>Import videos and your reel will appear here, cut to the beat.</p>
            </div>
          )}
          {demo && segments.length > 0 && <span className="demo-tag">Sample reel</span>}
        </div>
      </div>
      <Transport />
    </section>
  );
}

function SafeZones({ aspect }: { aspect: Aspect }) {
  // Approximate areas Instagram's own UI covers on a Reel.
  const tall = aspect === "9:16";
  return (
    <div className="safe" aria-hidden="true">
      <div className="safe-top" style={{ height: tall ? "11%" : "8%" }}>
        <span>Top bar</span>
      </div>
      <div className="safe-right" style={{ top: tall ? "48%" : "40%", bottom: tall ? "21%" : "18%" }}>
        <span>Buttons</span>
      </div>
      <div className="safe-bottom" style={{ height: tall ? "21%" : "18%" }}>
        <span>Caption &amp; username</span>
      </div>
    </div>
  );
}

function Transport() {
  const t = useEngineTime();
  const playing = useEnginePlaying();
  const frame = useStore((s) => s.project.frame);
  const safe = useStore((s) => s.ui.safeZones);
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
        className={`icon-btn ${safe ? "on" : ""}`}
        type="button"
        title="Show where Instagram's buttons and caption cover the video"
        aria-pressed={safe}
        onClick={() => store.ui({ safeZones: !safe })}
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
