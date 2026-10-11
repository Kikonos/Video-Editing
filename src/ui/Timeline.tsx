import { useEffect, useMemo, useRef, useState } from "react";
import { addText, deleteSeg, duplicateSeg, engine, moveSeg, selectSeg, splitAtPlayhead, updateSeg } from "../actions.ts";
import { segmentStarts, timelineBeats, timelineDownbeats, totalDuration, TRANSITION_LABEL } from "../engine/timeline.ts";
import type { Clip, Segment } from "../engine/types.ts";
import { store, useStore } from "../store.ts";
import { Icon } from "./icons.tsx";

const PAD = 12;

type Drag =
  | { kind: "move"; id: string; x0: number; moved: boolean; target: number }
  | { kind: "resize"; id: string; index: number; start: number; dur: number }
  | { kind: "scrub" };

export function Timeline() {
  const segments = useStore((s) => s.project.segments);
  const texts = useStore((s) => s.project.texts);
  const clips = useStore((s) => s.clips);
  const selected = useStore((s) => s.ui.selectedSeg);
  const selectedText = useStore((s) => s.ui.selectedText);
  const px = useStore((s) => s.ui.pxPerSec);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const songStart = useStore((s) => s.project.songStart);
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const tracks = useRef<HTMLDivElement>(null);
  const waveCanvas = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizeDur, setResizeDur] = useState<number | null>(null);

  const view = useMemo(() => {
    if (drag?.kind === "resize" && resizeDur !== null) {
      return segments.map((s) => (s.id === drag.id ? { ...s, duration: resizeDur } : s));
    }
    return segments;
  }, [segments, drag, resizeDur]);
  const starts = useMemo(() => segmentStarts(view), [view]);
  const total = totalDuration(view);
  const width = Math.max(total * px + PAD * 2 + 120, 300);
  const beats = useMemo(() => timelineBeats(song, songStart, total + 4), [song, songStart, total]);
  const downs = useMemo(() => timelineDownbeats(song, songStart, total + 4), [song, songStart, total]);
  const clipMap = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);

  // Playhead follows the engine clock without re-rendering React.
  useEffect(() => {
    const place = () => {
      const x = PAD + engine.time * px;
      if (head.current) head.current.style.transform = `translateX(${x}px)`;
      const sc = scroller.current;
      if (sc && engine.playing) {
        if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 80);
      }
    };
    place();
    return engine.subscribe(place);
  }, [px]);

  // Music lane waveform.
  useEffect(() => {
    const c = waveCanvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(total * px));
    c.style.width = `${w}px`;
    c.width = w * dpr;
    c.height = 34 * dpr;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!song) return;
    const col = getComputedStyle(c).getPropertyValue("--wave").trim() || "#777";
    ctx.fillStyle = col;
    const n = song.peaks.length;
    const H = c.height;
    for (let x = 0; x < c.width; x += 2) {
      const t = songStart + x / dpr / px;
      const v = song.peaks[Math.min(n - 1, Math.floor((t / song.duration) * n))] ?? 0;
      const a = v * H * 0.45;
      ctx.fillRect(x, H / 2 - a, 1.5, a * 2);
    }
  }, [song, songStart, total, px]);

  const timeAt = (clientX: number) => {
    const r = tracks.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - PAD) / px);
  };

  const snap = (t: number) => {
    let best = t;
    let bd = Infinity;
    for (const b of beats) {
      const d = Math.abs(b - t);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return bd * px < 18 ? best : t;
  };

  const onSegDown = (e: React.PointerEvent, seg: Segment) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "move", id: seg.id, x0: e.clientX, moved: false, target: -1 });
  };

  const onHandleDown = (e: React.PointerEvent, seg: Segment, index: number) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", id: seg.id, index, start: starts[index], dur: seg.duration });
    setResizeDur(seg.duration);
    selectSeg(seg.id);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "scrub") {
      engine.seek(timeAt(e.clientX));
      return;
    }
    if (drag.kind === "move") {
      const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 5;
      if (!moved) return;
      const t = timeAt(e.clientX);
      let target = view.length;
      for (let i = 0; i < view.length; i++) {
        if (t < starts[i] + view[i].duration / 2) {
          target = i;
          break;
        }
      }
      setDrag({ ...drag, moved, target });
      return;
    }
    if (drag.kind === "resize") {
      const seg = segments.find((s) => s.id === drag.id);
      const clip = seg && clipMap.get(seg.clipId);
      if (!seg) return;
      const end = snap(timeAt(e.clientX));
      const maxDur = clip ? Math.max(0.2, (clip.duration - seg.srcIn) / seg.speed) : 60;
      setResizeDur(Math.max(0.2, Math.min(maxDur, end - drag.start)));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "move") {
      const seg = segments.find((s) => s.id === drag.id);
      if (drag.moved && drag.target >= 0 && seg) {
        const from = segments.indexOf(seg);
        const to = drag.target > from ? drag.target - 1 : drag.target;
        if (to !== from) moveSeg(drag.id, to);
      } else if (seg) {
        selectSeg(seg.id);
        const i = segments.indexOf(seg);
        engine.seek(segmentStarts(segments)[i] + 0.001);
      }
    } else if (drag.kind === "resize" && resizeDur !== null) {
      updateSeg(drag.id, { duration: resizeDur });
    } else if (drag.kind === "scrub") {
      engine.seek(timeAt(e.clientX));
    }
    setDrag(null);
    setResizeDur(null);
  };

  const sel = segments.find((s) => s.id === selected);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-bar">
        <span className="eyebrow">Timeline</span>
        <span className="num dim">
          {segments.length} shots · {total.toFixed(1)}s{song ? ` · ${Math.round(song.bpm)} BPM` : ""}
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" type="button" onClick={splitAtPlayhead} disabled={!segments.length} title="Split the shot at the playhead (S)">
          <Icon name="scissors" size={15} /> <span className="lbl">Split</span>
        </button>
        <button className="btn ghost sm" type="button" onClick={() => sel && duplicateSeg(sel.id)} disabled={!sel} title="Duplicate shot (D)">
          <Icon name="copy" size={15} /> <span className="lbl">Duplicate</span>
        </button>
        <button className="btn ghost sm" type="button" onClick={() => sel && deleteSeg(sel.id)} disabled={!sel} title="Delete shot (Delete)">
          <Icon name="trash" size={15} /> <span className="lbl">Delete</span>
        </button>
        <button className="btn ghost sm" type="button" onClick={addText} disabled={!segments.length} title="Add text at the playhead">
          <Icon name="text" size={15} /> <span className="lbl">Text</span>
        </button>
        <label className="zoom" htmlFor="tl-zoom" title="Zoom the timeline">
          <Icon name="minus" size={13} />
          <input
            id="tl-zoom"
            type="range"
            min={20}
            max={220}
            value={px}
            onChange={(e) => store.ui({ pxPerSec: Number(e.target.value) })}
          />
          <Icon name="plus" size={13} />
        </label>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" ref={tracks} style={{ width }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div
            className="ruler"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ kind: "scrub" });
              engine.seek(timeAt(e.clientX));
            }}
          >
            <Ruler total={total} px={px} beats={beats} downs={downs} />
          </div>
          <div className="track shots" style={{ paddingLeft: PAD }}>
            {!view.length && <span className="track-empty">Shots appear here after you import footage.</span>}
            {view.map((seg, i) => (
              <Shot
                key={seg.id}
                seg={seg}
                index={i}
                left={PAD + starts[i] * px}
                width={seg.duration * px}
                clip={clipMap.get(seg.clipId)}
                selected={seg.id === selected}
                dragging={drag?.kind === "move" && drag.moved && drag.id === seg.id}
                onDown={(e) => onSegDown(e, seg)}
                onHandle={(e) => onHandleDown(e, seg, i)}
              />
            ))}
            {drag?.kind === "move" && drag.moved && drag.target >= 0 && (
              <span
                className="insert-mark"
                style={{ left: PAD + (drag.target < view.length ? starts[drag.target] : total) * px - 2 }}
              />
            )}
          </div>
          <div className="track texts">
            {texts.map((tx) => (
              <button
                key={tx.id}
                type="button"
                className={`text-bar ${tx.id === selectedText ? "sel" : ""}`}
                style={{ left: PAD + tx.start * px, width: Math.max(14, (tx.end - tx.start) * px) }}
                onClick={() => {
                  store.ui({ selectedText: tx.id, rightTab: "text", selectedSeg: null });
                  engine.seek(tx.start + 0.01);
                }}
                title={tx.text}
              >
                <Icon name="text" size={12} />
                <span>{tx.text}</span>
              </button>
            ))}
          </div>
          <div className="track music" style={{ paddingLeft: PAD }}>
            {song ? <canvas ref={waveCanvas} /> : <span className="track-empty">No music yet: cuts follow a steady 120 BPM grid.</span>}
          </div>
          <div className="playhead" ref={head}>
            <span className="playhead-knob" />
          </div>
        </div>
      </div>
    </section>
  );
}

function Ruler({ total, px, beats, downs }: { total: number; px: number; beats: number[]; downs: number[] }) {
  const step = px > 90 ? 1 : px > 40 ? 2 : 5;
  const secs: number[] = [];
  for (let s = 0; s <= total + step; s += step) secs.push(s);
  const downSet = new Set(downs.map((d) => Math.round(d * 1000)));
  return (
    <>
      {beats.map((b) => {
        const down = downSet.has(Math.round(b * 1000));
        return <span key={b} className={`beat-tick ${down ? "down" : ""}`} style={{ left: PAD + b * px }} />;
      })}
      {downs.map((d, i) =>
        px * (downs[1] - downs[0] || 2) > 34 || i % 2 === 0 ? (
          <span key={"bar" + d} className="bar-num num" style={{ left: PAD + d * px + 3 }}>
            {i + 1}
          </span>
        ) : null,
      )}
      {secs.map((s) => (
        <span key={"s" + s} className="sec num" style={{ left: PAD + s * px }}>
          {s}s
        </span>
      ))}
    </>
  );
}

function Shot({
  seg,
  index,
  left,
  width,
  clip,
  selected,
  dragging,
  onDown,
  onHandle,
}: {
  seg: Segment;
  index: number;
  left: number;
  width: number;
  clip?: Clip;
  selected: boolean;
  dragging: boolean;
  onDown: (e: React.PointerEvent) => void;
  onHandle: (e: React.PointerEvent) => void;
}) {
  const moment = clip?.analysis?.moments.find((m) => m.id === seg.momentId);
  const thumb = moment?.thumb ?? clip?.thumb;
  return (
    <div
      className={`shot ${selected ? "sel" : ""} ${dragging ? "dragging" : ""}`}
      style={{ left, width: Math.max(4, width - 2), ["--hue" as string]: clip?.hue ?? 0 }}
      onPointerDown={onDown}
      role="button"
      tabIndex={0}
      aria-label={`Shot ${index + 1}${moment?.label ? `: ${moment.label}` : ""}, ${seg.duration.toFixed(2)} seconds`}
      onKeyDown={(e) => {
        if (e.key === "Enter") selectSeg(seg.id);
      }}
    >
      {thumb && <img src={thumb} alt="" draggable={false} />}
      <span className="shot-num num">{index + 1}</span>
      {seg.speed !== 1 && width > 40 && <span className="shot-speed num">{seg.speed}×</span>}
      {seg.transition !== "cut" && index > 0 && (
        <span className="shot-trans" title={TRANSITION_LABEL[seg.transition]}>
          {TRANSITION_LABEL[seg.transition][0]}
        </span>
      )}
      <span className="shot-handle" onPointerDown={onHandle} title="Drag to change length (snaps to beats)" />
    </div>
  );
}
