import { useEffect, useMemo, useRef, useState } from "react";
import { addManualMoment, deleteSeg, engine, moveSeg, removeManualMoment, replaceShot, selectSeg, swapTake } from "../actions.ts";
import { drawDemo, makeDemoCanvas } from "../engine/demo.ts";
import { formatTime, segmentStarts } from "../engine/timeline.ts";
import { FRAMES, type Clip, type Moment } from "../engine/types.ts";
import { store, toast, useStore } from "../store.ts";
import { Icon } from "./icons.tsx";

/**
 * The reel as a grid of snippets. Drag to reorder (the pictures move, the beat
 * slots stay), tap to select, then swap in any moment from the bin below.
 */
export function ShotsPanel() {
  const segments = useStore((s) => s.project.segments);
  const clips = useStore((s) => s.clips);
  const selected = useStore((s) => s.ui.selectedSeg);
  const frame = useStore((s) => s.project.frame);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const ratio = FRAMES[frame].ratio || 9 / 16;
  const beat = song ? 60 / song.bpm : 0.5;
  const clipMap = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; from: number; x: number; y: number; moved: boolean } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const selIndex = segments.findIndex((s) => s.id === selected);

  const momentOf = (clipId: string, momentId?: string) => clipMap.get(clipId)?.analysis?.moments.find((m) => m.id === momentId);

  const tileAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest("[data-shot]") as HTMLElement | null;
    return el ? Number(el.dataset.shot) : null;
  };

  const select = (i: number) => {
    const seg = segments[i];
    if (!seg) return;
    selectSeg(seg.id, false);
    engine.seek(segmentStarts(segments)[i] + 0.001);
  };

  return (
    <div className="stack">
      <div>
        <h2 className="panel-title">Shots</h2>
        <p className="lede">
          {segments.length
            ? "Drag a snippet to move it. The cuts stay on the beat; only the pictures change places. Tap one, then pick a moment below to swap it in."
            : "Your snippets appear here once the reel is cut."}
        </p>
      </div>

      {segments.length > 0 && (
        <div
          className="shot-grid"
          ref={grid}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
            if (!d.moved) {
              d.moved = true;
              setDragId(d.id);
            }
            setOver(tileAt(e.clientX, e.clientY));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            setDragId(null);
            setOver(null);
            if (!d) return;
            if (!d.moved) {
              select(d.from);
              return;
            }
            const to = tileAt(e.clientX, e.clientY);
            if (to !== null && to !== d.from) moveSeg(d.id, to);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragId(null);
            setOver(null);
          }}
        >
          {segments.map((seg, i) => {
            const clip = clipMap.get(seg.clipId);
            const m = momentOf(seg.clipId, seg.momentId);
            const beats = Math.round(seg.duration / beat);
            return (
              <button
                key={seg.id}
                type="button"
                data-shot={i}
                className={`snip ${seg.id === selected ? "sel" : ""} ${dragId === seg.id ? "dragging" : ""} ${over === i && dragId && dragId !== seg.id ? "over" : ""}`}
                style={{ aspectRatio: String(ratio), ["--hue" as string]: clip?.hue ?? 0 }}
                onPointerDown={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                  drag.current = { id: seg.id, from: i, x: e.clientX, y: e.clientY, moved: false };
                }}
                onClick={(e) => {
                  if (e.detail === 0) select(i); // keyboard activation
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" && i > 0) moveSeg(seg.id, i - 1);
                  if (e.key === "ArrowRight" && i < segments.length - 1) moveSeg(seg.id, i + 1);
                }}
                aria-label={`Shot ${i + 1}${m?.label ? `, ${m.label}` : ""}, ${beats} beat${beats === 1 ? "" : "s"}`}
              >
                {(m?.thumb ?? clip?.thumb) && <img src={m?.thumb ?? clip?.thumb} alt="" draggable={false} />}
                <span className="snip-num num">{i + 1}</span>
                {beats > 1 && <span className="snip-beats num">{beats}♩</span>}
                {seg.zoom > 1 && <span className="snip-tag">punch</span>}
                {m?.manual && <span className="snip-star" title="Your pick"><Icon name="star" size={11} /></span>}
              </button>
            );
          })}
        </div>
      )}

      {selIndex >= 0 && (
        <div className="snip-actions">
          <button className="btn sm" type="button" disabled={selIndex === 0} onClick={() => moveSeg(segments[selIndex].id, selIndex - 1)} aria-label="Move earlier">
            ← Earlier
          </button>
          <button className="btn sm" type="button" disabled={selIndex === segments.length - 1} onClick={() => moveSeg(segments[selIndex].id, selIndex + 1)} aria-label="Move later">
            Later →
          </button>
          <button className="btn sm" type="button" onClick={() => swapTake(segments[selIndex].id)}>
            <Icon name="shuffle" size={14} /> Another
          </button>
          <button className="btn sm danger" type="button" onClick={() => deleteSeg(segments[selIndex].id)} aria-label="Remove shot">
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}

      <MomentBin selected={selected} />
    </div>
  );
}

/** Every moment the scan found (and every hand pick), best first. */
function MomentBin({ selected }: { selected: string | null }) {
  const clips = useStore((s) => s.clips);
  const segments = useStore((s) => s.project.segments);
  const [byClip, setByClip] = useState(false);
  const inReel = new Set(segments.map((s) => s.momentId));
  const ready = clips.filter((c) => c.status === "ready" && c.analysis);
  const all: { m: Moment; clip: Clip }[] = [];
  for (const c of ready) for (const m of c.analysis!.moments) all.push({ m, clip: c });
  const sorted = byClip
    ? all
    : [...all].sort((a, b) => Number(!!b.m.manual) - Number(!!a.m.manual) || b.m.score - a.m.score);
  return (
    <div className="stack bin">
      <div className="row between">
        <span className="eyebrow">Moments · {all.length}</span>
        <div className="row gap">
          <button className="link" type="button" onClick={() => setByClip((v) => !v)}>
            {byClip ? "Best first" : "By clip"}
          </button>
          <button className="btn sm" type="button" disabled={!ready.length} onClick={() => store.ui({ pickerClip: ready[0]?.id ?? null })}>
            <Icon name="star" size={14} /> Pick your own
          </button>
        </div>
      </div>
      {!all.length && <p className="hint">Moments appear here as your clips are scanned.</p>}
      <div className="moment-grid">
        {sorted.map(({ m, clip }) => (
          <button
            key={m.id}
            type="button"
            className={`bin-item ${inReel.has(m.id) ? "used" : ""}`}
            title={`${clip.name} · ${formatTime(m.t)}${m.label ? ` · ${m.label}` : ""}`}
            onClick={() => {
              if (!selected) {
                toast("Tap a shot above first, then the moment to swap in.");
                return;
              }
              replaceShot(selected, clip.id, m.id);
            }}
          >
            {m.thumb && <img src={m.thumb} alt="" />}
            {m.manual ? (
              <span className="bin-badge star"><Icon name="star" size={10} /></span>
            ) : (
              <span className="bin-badge num">{Math.round(m.score * 100)}</span>
            )}
            {inReel.has(m.id) && <span className="bin-used">in reel</span>}
            {m.manual && (
              <span
                className="bin-remove"
                role="button"
                tabIndex={0}
                aria-label="Remove your pick"
                onClick={(e) => {
                  e.stopPropagation();
                  removeManualMoment(clip.id, m.id);
                }}
              >
                <Icon name="close" size={11} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Scrub through a clip and mark the moments you want in the reel yourself. */
export function MomentPicker() {
  const clipId = useStore((s) => s.ui.pickerClip);
  const clips = useStore((s) => s.clips);
  const ready = clips.filter((c) => c.status === "ready");
  const clip = ready.find((c) => c.id === clipId) ?? null;
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const demoCanvas = useMemo(() => makeDemoCanvas(), []);

  useEffect(() => {
    setT(0);
    setPlaying(false);
  }, [clipId]);

  // Demo clips are drawn, not decoded.
  useEffect(() => {
    if (!clip || clip.kind !== "demo" || !clip.demo || !canvas.current) return;
    drawDemo(demoCanvas.getContext("2d")!, clip.demo, t);
    const c = canvas.current;
    c.width = demoCanvas.width;
    c.height = demoCanvas.height;
    c.getContext("2d")!.drawImage(demoCanvas, 0, 0);
  }, [clip, t, demoCanvas]);

  useEffect(() => {
    if (!playing || !clip) return;
    if (clip.kind === "video") {
      void video.current?.play();
      return () => video.current?.pause();
    }
    let raf = 0;
    const t0 = performance.now() - t * 1000;
    const tick = () => {
      const nt = ((performance.now() - t0) / 1000) % clip.duration;
      setT(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clip]);

  if (!clipId) return null;
  const close = () => store.ui({ pickerClip: null });
  const seek = (v: number) => {
    setT(v);
    if (video.current) video.current.currentTime = v;
  };
  const picks = clip?.analysis?.moments.filter((m) => m.manual) ?? [];
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <h2 id="picker-title" className="panel-title">
            Pick your own moments
          </h2>
          <button className="icon-btn" type="button" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="picker-clips">
          {ready.map((c) => (
            <button key={c.id} type="button" className={`picker-clip ${c.id === clipId ? "on" : ""}`} onClick={() => store.ui({ pickerClip: c.id })} title={c.name}>
              {c.thumb && <img src={c.thumb} alt="" />}
            </button>
          ))}
        </div>
        {clip && (
          <div className="stack">
            <div className="picker-view">
              {clip.kind === "video" ? (
                <video
                  ref={video}
                  src={engine.mediaUrl(clip.id)}
                  muted
                  playsInline
                  preload="auto"
                  // A paused video shows nothing until it has data and a seek lands.
                  onLoadedData={(e) => {
                    e.currentTarget.currentTime = Math.max(0.01, t);
                  }}
                  onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
                  onPause={() => setPlaying(false)}
                />
              ) : (
                <canvas ref={canvas} />
              )}
            </div>
            <div className="picker-scrub">
              <button className="play sm" type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
                <Icon name={playing ? "pause" : "play"} size={16} />
              </button>
              <div className="scrub-track">
                {clip.analysis?.moments.map((m) => (
                  <span key={m.id} className={`strip-dot ${m.manual ? "mine" : ""}`} style={{ left: `${(m.t / clip.duration) * 100}%`, ["--s" as string]: m.manual ? 1 : m.score }} />
                ))}
                <input
                  id="picker-time"
                  type="range"
                  min={0}
                  max={clip.duration}
                  step={1 / 30}
                  value={t}
                  aria-label="Position in the clip"
                  onChange={(e) => {
                    setPlaying(false);
                    seek(Number(e.target.value));
                  }}
                />
              </div>
              <span className="num">{formatTime(t)}</span>
            </div>
            <button
              className="btn primary big"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setPlaying(false);
                await addManualMoment(clip.id, t);
                setBusy(false);
              }}
            >
              <Icon name="star" size={16} /> Use this moment
            </button>
            <p className="hint">
              It goes into the selected shot, or in place of the weakest one, and every re-cut keeps it. Dots show the moments the scan found; yours are mint.
            </p>
            {picks.length > 0 && (
              <p className="num dim">
                Your picks in this clip: {picks.map((m) => formatTime(m.t)).join(", ")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
