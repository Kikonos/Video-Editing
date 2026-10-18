import { useEffect, useRef, useState } from "react";
import {
  addText,
  deleteSeg,
  deleteText,
  duplicateSeg,
  engine,
  generate,
  importFiles,
  importMusic,
  nudgeBeats,
  primeAudio,
  setProject,
  splitAtPlayhead,
  stopDirector,
  swapTake,
  updateSeg,
  updateText,
} from "../actions.ts";
import { autoLength } from "../engine/autoedit.ts";
import { LOOKS, STYLES } from "../engine/looks.ts";
import { TEXT_STYLES } from "../engine/text.ts";
import { formatTime, segmentStarts, TRANSITION_LABEL } from "../engine/timeline.ts";
import { FRAMES, NEUTRAL_ADJUST, type Adjust, type FrameId, type LookId, type Pace, type StyleId, type TextAnim, type TextPlace, type TextStyle, type TransitionKind } from "../engine/types.ts";
import { store, useStore, type RightTab } from "../store.ts";
import { Field, Segmented, Slider, Toggle } from "./controls.tsx";
import { SongListen } from "./Library.tsx";
import { Icon } from "./icons.tsx";
import { ShotsPanel } from "./Shots.tsx";

const TABS: { value: RightTab; label: string }[] = [
  { value: "auto", label: "Make" },
  { value: "shots", label: "Shots" },
  { value: "shot", label: "Shot" },
  { value: "look", label: "Look" },
  { value: "text", label: "Text" },
  { value: "audio", label: "Sound" },
];

export function Inspector({ only }: { only?: RightTab }) {
  const tab = useStore((s) => s.ui.rightTab);
  const shown = only ?? tab;
  return (
    <section className="panel inspector" aria-label="Edit">
      {!only && (
        <div className="panel-tabs">
          <Segmented<RightTab> label="Edit panels" value={tab} onChange={(v) => store.ui({ rightTab: v })} options={TABS} />
        </div>
      )}
      <div className="panel-body" key={shown}>
        {shown === "auto" && <AutoPanel />}
        {shown === "shots" && <ShotsPanel />}
        {shown === "shot" && <ShotPanel />}
        {shown === "look" && <LookPanel />}
        {shown === "text" && <TextPanel />}
        {shown === "audio" && <AudioPanel />}
      </div>
    </section>
  );
}

export { TABS as INSPECTOR_TABS };

// ---------------------------------------------------------------- auto edit

function AutoPanel() {
  const auto = useStore((s) => s.ui.auto);
  const ai = useStore((s) => s.ui.ai);
  const busy = useStore((s) => s.ui.busy);
  const note = useStore((s) => s.ui.directorNote);
  const clips = useStore((s) => s.clips);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const hasShots = useStore((s) => s.project.segments.length > 0);
  const ready = clips.filter((c) => c.status === "ready");
  const pending = clips.filter((c) => c.status === "loading" || c.status === "analyzing").length;
  const moments = ready.reduce((n, c) => n + (c.analysis?.moments.length ?? 0), 0);
  const set = (patch: Partial<typeof auto>) => store.ui({ auto: { ...auto, ...patch } });
  const aiOn = ai.available && ai.images;

  return (
    <div className="stack">
      <div>
        <h2 className="panel-title">Make the reel</h2>
        <p className="lede">Drop all your videos and add the song. The reel cuts itself on the beat, and you can rearrange it after.</p>
      </div>
      <QuickStart />
      <Field label="Style">
        <div className="styles">
          {(Object.keys(STYLES) as StyleId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`style-card ${auto.style === id ? "on" : ""}`}
              aria-pressed={auto.style === id}
              onClick={() => set({ style: id, pace: STYLES[id].pace })}
            >
              <span className={`style-swatch sw-${id}`} />
              <strong>{STYLES[id].label}</strong>
              <small>{STYLES[id].blurb}</small>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Pace">
        <Segmented<Pace>
          label="Pace"
          value={auto.pace}
          onChange={(v) => set({ pace: v })}
          options={[
            { value: "beat", label: "Every beat", title: "A new shot on every beat, holding on the intro, the drop and the end" },
            { value: "two", label: "Every 2 beats", title: "A new shot every second beat" },
            { value: "story", label: "Relaxed", title: "Shots of 1 to 4 beats that follow the music's phrases" },
          ]}
        />
      </Field>
      <Field label="Length" aside={auto.length === "auto" && ready.length ? <span className="num dim">{autoLength(ready)}s</span> : null}>
        <Segmented<number | "auto">
          label="Length"
          value={auto.length}
          onChange={(v) => set({ length: v })}
          options={[
            { value: "auto", label: "Auto" },
            { value: 10, label: "10s" },
            { value: 15, label: "15s" },
            { value: 20, label: "20s" },
            { value: 30, label: "30s" },
          ]}
        />
      </Field>
      <Field label="Order">
        <Segmented<"story" | "energy">
          label="Order"
          value={auto.order}
          onChange={(v) => set({ order: v })}
          options={[
            { value: "story", label: "As it happened" },
            { value: "energy", label: "Match the music" },
          ]}
        />
      </Field>
      <Toggle checked={auto.hook} onChange={(v) => set({ hook: v })} label="Open with the best shot" hint="The most beautiful shot goes first, held for two beats." />
      {aiOn ? (
        <Toggle
          checked={auto.useAI}
          onChange={(v) => set({ useAI: v })}
          label={
            <>
              <Icon name="spark" size={14} /> AI Director
            </>
          }
          hint="Runs by itself once your videos and song are in: Claude looks at your best moments, picks the most atmospheric ones and their order, and writes the caption. Uses your Claude account."
        />
      ) : (
        <p className="hint">
          {ai.checked
            ? "Claude isn't connected in this view. Moment-picking runs fully on your device."
            : "Checking for Claude…"}
        </p>
      )}
      {busy?.cancel ? (
        <button className="btn primary big" type="button" onClick={stopDirector}>
          <span className="spinner" /> {busy.label} <span className="dim">Stop</span>
        </button>
      ) : (
        <button
          className="btn primary big"
          type="button"
          disabled={!ready.length || !!busy}
          onClick={() => {
            primeAudio();
            void generate().then(() => {
              if (store.get().project.segments.length) engine.play();
            });
          }}
        >
          <Icon name="spark" size={18} /> {hasShots ? "Re-cut the reel" : "Make my reel"}
        </button>
      )}
      <p className="status-line num">
        {ready.length} clip{ready.length === 1 ? "" : "s"} ready · {moments} moments
        {pending ? ` · ${pending} scanning` : ""} · {song ? `${Math.round(song.bpm)} BPM` : "no music"}
      </p>
      {note && <p className="note">{note}</p>}
    </div>
  );
}

function QuickStart() {
  const clips = useStore((s) => s.clips);
  const demo = useStore((s) => s.ui.demo);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const musicBusy = useStore((s) => s.ui.musicBusy);
  const busy = useStore((s) => s.ui.busy);
  const segments = useStore((s) => s.project.segments);
  const videosIn = useRef<HTMLInputElement>(null);
  const songIn = useRef<HTMLInputElement>(null);
  const mine = demo ? [] : clips;
  const scanningN = mine.filter((c) => c.status === "loading" || c.status === "analyzing").length;
  const readyN = mine.filter((c) => c.status === "ready").length;
  const failed = mine.filter((c) => c.status === "error").length;
  const mySong = song && song.source !== "demo" ? song : null;
  const total = segments.reduce((a, x) => a + x.duration, 0);
  const videoStatus = !mine.length
    ? "Select them all at once: as many as you like."
    : scanningN
      ? `Finding the best moments: ${readyN} of ${readyN + scanningN} done`
      : `${readyN} clip${readyN === 1 ? "" : "s"} scanned${failed ? `, ${failed} couldn't be read` : ""}`;
  const songStatus = musicBusy ?? (mySong ? `${mySong.name} · ${Math.round(mySong.bpm)} BPM` : "From a video with the song in it, or an audio file.");
  const reelStatus = busy?.label
    ? busy.label
    : !demo && segments.length
      ? `${segments.length} shots · ${total.toFixed(1)}s${mySong ? "" : " · waiting for the song"}`
      : scanningN
        ? "Cuts itself as soon as the scan finishes."
        : "Cuts itself once your videos are in.";
  return (
    <ol className="steps">
      <li className={readyN && !scanningN ? "done" : ""}>
        <span className="step-n">{readyN && !scanningN ? <Icon name="check" size={13} /> : "1"}</span>
        <span className="step-text">
          <strong>Your videos</strong>
          <small>{videoStatus}</small>
          {scanningN > 0 && (
            <span className="bar wide">
              <span style={{ width: `${Math.round((100 * (readyN + mine.filter((c) => c.status === "analyzing").reduce((a, c) => a + c.progress, 0))) / Math.max(1, mine.length - failed))}%` }} />
            </span>
          )}
        </span>
        <button className="btn sm" type="button" onClick={() => videosIn.current?.click()}>
          <Icon name="upload" size={14} /> Add
        </button>
        <input
          ref={videosIn}
          id="qs-videos"
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) importFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </li>
      <li className={mySong ? "done" : ""}>
        <span className="step-n">{mySong ? <Icon name="check" size={13} /> : "2"}</span>
        <span className="step-text">
          <strong>The song</strong>
          <small>{songStatus}</small>
          <SongListen />
        </span>
        <button className="btn sm" type="button" disabled={!!musicBusy} onClick={() => songIn.current?.click()}>
          <Icon name="music" size={14} /> {mySong ? "Change" : "Add"}
        </button>
        <input
          ref={songIn}
          id="qs-song"
          type="file"
          accept="video/*,audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              primeAudio();
              void importMusic(f);
            }
            e.target.value = "";
          }}
        />
      </li>
      <li className={!demo && segments.length && mySong ? "done" : ""}>
        <span className="step-n">{!demo && segments.length && mySong ? <Icon name="check" size={13} /> : "3"}</span>
        <span className="step-text">
          <strong>Your reel</strong>
          <small>{reelStatus}</small>
        </span>
      </li>
    </ol>
  );
}

// --------------------------------------------------------------------- shot

const SPEEDS = [0.5, 0.75, 1, 1.5, 2];
const TRANSITIONS: TransitionKind[] = ["cut", "smear", "flash", "fade"];

function ShotPanel() {
  const selected = useStore((s) => s.ui.selectedSeg);
  const segments = useStore((s) => s.project.segments);
  const clips = useStore((s) => s.clips);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const index = segments.findIndex((s) => s.id === selected);
  const seg = segments[index];
  if (!seg) {
    return (
      <div className="stack">
        <h2 className="panel-title">Shot</h2>
        <p className="lede">Select a shot in the timeline to trim it, change its speed, transition or framing.</p>
        <ul className="tips">
          <li>Drag a shot to reorder it.</li>
          <li>Drag its right edge to make it longer or shorter. It snaps to the beat.</li>
          <li>Drag on the preview to move the framing.</li>
        </ul>
      </div>
    );
  }
  const clip = clips.find((c) => c.id === seg.clipId);
  const moment = clip?.analysis?.moments.find((m) => m.id === seg.momentId);
  const beat = song ? 60 / song.bpm : 0.5;
  const beatsLong = seg.duration / beat;
  const need = seg.duration * seg.speed;
  const dur = clip?.duration ?? need;

  return (
    <div className="stack">
      <div className="shot-head">
        {(moment?.thumb || clip?.thumb) && <img src={moment?.thumb ?? clip?.thumb} alt="" />}
        <div>
          <span className="eyebrow">
            Shot {index + 1} of {segments.length}
          </span>
          <h2 className="panel-title sm">{moment?.label ?? clip?.name ?? "Shot"}</h2>
          <span className="num dim">
            {clip?.name} · {formatTime(seg.srcIn)}–{formatTime(seg.srcIn + need)}
          </span>
        </div>
      </div>

      <Field label="Which part of the clip">
        <SourceWindow
          duration={dur}
          start={seg.srcIn}
          span={need}
          moments={clip?.analysis?.moments.map((m) => ({ t: m.t, s: m.score })) ?? []}
          onChange={(v, done) => updateSeg(seg.id, { srcIn: v }, done ? undefined : "src-" + seg.id)}
        />
      </Field>

      <Field label="Length" aside={<span className="num dim">{seg.duration.toFixed(2)}s</span>}>
        <div className="stepper">
          <button className="icon-btn" type="button" onClick={() => nudgeBeats(seg.id, -1)} aria-label="One beat shorter">
            <Icon name="minus" size={16} />
          </button>
          <span className="num">
            {Math.abs(beatsLong - Math.round(beatsLong)) < 0.05 ? Math.round(beatsLong) : beatsLong.toFixed(1)} beat
            {Math.round(beatsLong) === 1 ? "" : "s"}
          </span>
          <button className="icon-btn" type="button" onClick={() => nudgeBeats(seg.id, 1)} aria-label="One beat longer">
            <Icon name="plus" size={16} />
          </button>
        </div>
      </Field>

      <Field label="Speed">
        <Segmented<number>
          label="Speed"
          value={seg.speed}
          onChange={(v) => {
            const srcIn = Math.max(0, Math.min(seg.srcIn, dur - seg.duration * v));
            updateSeg(seg.id, { speed: v, srcIn });
          }}
          options={SPEEDS.map((v) => ({
            value: v,
            label: `${v}×`,
            disabled: seg.duration * v > dur + 0.01,
            title: v < 1 ? "Slow motion" : v > 1 ? "Speed up" : "Normal",
          }))}
        />
      </Field>

      <Field label="Transition in">
        <div className="chips">
          {TRANSITIONS.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip ${seg.transition === t ? "on" : ""}`}
              aria-pressed={seg.transition === t}
              disabled={index === 0 && t !== "cut"}
              onClick={() => updateSeg(seg.id, { transition: t })}
            >
              {TRANSITION_LABEL[t]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Framing">
        <Toggle
          checked={seg.reframe === null}
          onChange={(v) => updateSeg(seg.id, { reframe: v ? null : engine.rawFrame()?.fx ?? 0.5 })}
          label="Follow the subject"
          hint="Keeps the action in frame when a wide video is cropped to vertical."
        />
        {seg.reframe !== null && (
          <Slider id="reframe" label="Position" value={seg.reframe} min={0} max={1} onChange={(v) => updateSeg(seg.id, { reframe: v }, "reframe-" + seg.id)} format={(v) => (v < 0.4 ? "Left" : v > 0.6 ? "Right" : "Centre")} />
        )}
        <Slider id="zoom" label="Zoom" value={seg.zoom} min={1} max={2} onChange={(v) => updateSeg(seg.id, { zoom: v }, "zoom-" + seg.id)} format={(v) => `${v.toFixed(2)}×`} />
      </Field>

      <div className="actions-grid">
        <button className="btn" type="button" onClick={() => swapTake(seg.id)} title="Swap in a different good moment">
          <Icon name="shuffle" size={15} /> Try another moment
        </button>
        <button className="btn" type="button" onClick={splitAtPlayhead}>
          <Icon name="scissors" size={15} /> Split
        </button>
        <button className="btn" type="button" onClick={() => duplicateSeg(seg.id)}>
          <Icon name="copy" size={15} /> Duplicate
        </button>
        <button className="btn danger" type="button" onClick={() => deleteSeg(seg.id)}>
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>
    </div>
  );
}

function SourceWindow({
  duration,
  start,
  span,
  moments,
  onChange,
}: {
  duration: number;
  start: number;
  span: number;
  moments: { t: number; s: number }[];
  onChange: (v: number, done: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const max = Math.max(0, duration - span);
  const set = (v: number, done: boolean) => onChange(Math.max(0, Math.min(max, v)), done);
  return (
    <div
      className="srcwin"
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Shot start inside the clip"
      aria-valuemin={0}
      aria-valuemax={Math.round(max * 100) / 100}
      aria-valuenow={Math.round(start * 100) / 100}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") set(start - 0.1, true);
        if (e.key === "ArrowRight") set(start + 0.1, true);
      }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const r = ref.current!.getBoundingClientRect();
        const t = ((e.clientX - r.left) / r.width) * duration;
        const s0 = t >= start && t <= start + span ? start : t - span / 2;
        drag.current = { x: e.clientX, start: Math.max(0, Math.min(max, s0)) };
        set(drag.current.start, false);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const r = ref.current!.getBoundingClientRect();
        set(drag.current.start + ((e.clientX - drag.current.x) / r.width) * duration, false);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <span className="srcwin-track" />
      {moments.map((m, i) => (
        <span key={i} className="strip-dot" style={{ left: `${(m.t / Math.max(0.1, duration)) * 100}%`, ["--s" as string]: m.s }} />
      ))}
      <span className="srcwin-sel" style={{ left: `${(start / Math.max(0.1, duration)) * 100}%`, width: `${(span / Math.max(0.1, duration)) * 100}%` }} />
    </div>
  );
}

// --------------------------------------------------------------------- look

const ADJ: { key: keyof Adjust; label: string; min: number; max: number }[] = [
  { key: "exposure", label: "Exposure", min: -1, max: 1 },
  { key: "contrast", label: "Contrast", min: -1, max: 1 },
  { key: "saturation", label: "Saturation", min: -1, max: 1 },
  { key: "warmth", label: "Warmth", min: -1, max: 1 },
  { key: "fade", label: "Fade", min: 0, max: 1 },
  { key: "vignette", label: "Vignette", min: 0, max: 1 },
  { key: "grain", label: "Grain", min: 0, max: 1 },
];

function LookPanel() {
  const look = useStore((s) => s.project.look);
  const amount = useStore((s) => s.project.lookAmount);
  const adjust = useStore((s) => s.project.adjust);
  const frame = useStore((s) => s.project.frame);
  const segments = useStore((s) => s.project.segments);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const ratio = FRAMES[frame].ratio || 9 / 16;

  useEffect(() => {
    const id = setTimeout(() => {
      const w = ratio >= 1 ? 192 : 120;
      setThumbs(engine.renderLookThumbs(Object.keys(LOOKS) as LookId[], w, Math.round(w / ratio)));
    }, 120);
    return () => clearTimeout(id);
  }, [adjust, ratio, segments]);

  return (
    <div className="stack">
      <h2 className="panel-title">Frame &amp; look</h2>
      <Field label="Frame">
        <Segmented<FrameId>
          label="Frame"
          value={frame}
          onChange={(v) => setProject({ frame: v })}
          options={(Object.keys(FRAMES) as FrameId[]).map((f) => ({
            value: f,
            label: f === "full" ? "Full" : f,
            title: f === "full" ? "Fill the whole vertical screen" : `${FRAMES[f].label}: a ${f} picture with black above and below`,
          }))}
        />
      </Field>
      <div className="looks">
        {(Object.keys(LOOKS) as LookId[]).map((id) => (
          <button key={id} type="button" className={`look ${look === id ? "on" : ""}`} aria-pressed={look === id} onClick={() => setProject({ look: id })}>
            <span className="look-img" style={{ aspectRatio: String(ratio) }}>
              {thumbs[id] ? <img src={thumbs[id]} alt="" /> : <span className={`look-fallback lk-${id}`} />}
            </span>
            <span>{LOOKS[id].label}</span>
          </button>
        ))}
      </div>
      <Slider id="look-amount" label="Strength" value={amount} min={0} max={1} onChange={(v) => setProject({ lookAmount: v }, "lookAmount")} format={(v) => `${Math.round(v * 100)}%`} />
      <Field
        label="Adjust"
        aside={
          <button className="link" type="button" onClick={() => setProject({ adjust: { ...NEUTRAL_ADJUST } })}>
            Reset
          </button>
        }
      >
        {ADJ.map((a) => (
          <Slider
            key={a.key}
            id={"adj-" + a.key}
            label={a.label}
            value={adjust[a.key]}
            min={a.min}
            max={a.max}
            center={0}
            onChange={(v) => setProject({ adjust: { ...store.get().project.adjust, [a.key]: v } }, "adj-" + a.key)}
            format={(v) => (v > 0 && a.min < 0 ? "+" : "") + Math.round(v * 100)}
          />
        ))}
      </Field>
    </div>
  );
}

// --------------------------------------------------------------------- text

const SWATCHES = ["#ffffff", "#111111", "#ffc27a", "#ff7a6e", "#7ce0d6", "#ffe14d"];
const ANIMS: { value: TextAnim; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "type", label: "Type" },
  { value: "rise", label: "Rise" },
];

const PLACES: { value: TextPlace; label: string }[] = [
  { value: "above", label: "Above picture" },
  { value: "below", label: "Below picture" },
  { value: "free", label: "On picture" },
];

function TextPanel() {
  const texts = useStore((s) => s.project.texts);
  const selected = useStore((s) => s.ui.selectedText);
  const segments = useStore((s) => s.project.segments);
  const tx = texts.find((t) => t.id === selected);
  const total = segments.reduce((a, s) => a + s.duration, 0);
  return (
    <div className="stack">
      <div className="row between">
        <h2 className="panel-title">Text</h2>
        <button className="btn sm" type="button" onClick={addText} disabled={!segments.length}>
          <Icon name="plus" size={15} /> Add text
        </button>
      </div>
      {!texts.length && <p className="lede">Add a small "POV: …" line above the picture, like the road-trip reels. It's drawn into the video when you export.</p>}
      {texts.length > 0 && (
        <ul className="text-list">
          {texts.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={t.id === selected ? "on" : ""}
                onClick={() => {
                  store.ui({ selectedText: t.id });
                  engine.seek(t.start + 0.01);
                }}
              >
                <span className="clip-name">{t.text || "Empty"}</span>
                <span className="num dim">
                  {t.start.toFixed(1)}–{t.end.toFixed(1)}s
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {tx && (
        <div className="stack text-edit">
          <label className="field" htmlFor="text-content">
            <span className="eyebrow">Words</span>
            <textarea id="text-content" rows={2} value={tx.text} onChange={(e) => updateText(tx.id, { text: e.target.value }, "text-" + tx.id)} />
          </label>
          <Field label="Style">
            <div className="chips">
              {(Object.keys(TEXT_STYLES) as TextStyle[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip font-${s} ${tx.style === s ? "on" : ""}`}
                  aria-pressed={tx.style === s}
                  onClick={() => updateText(tx.id, { style: s })}
                >
                  {TEXT_STYLES[s].label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Where">
            <Segmented<TextPlace> label="Where" value={tx.place ?? "free"} onChange={(v) => updateText(tx.id, { place: v })} options={PLACES} />
          </Field>
          <Field label="Animation">
            <Segmented<TextAnim> label="Animation" value={tx.anim} onChange={(v) => updateText(tx.id, { anim: v })} options={ANIMS} />
          </Field>
          <Field label="Colour">
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${tx.color === c ? "on" : ""}`}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                  aria-pressed={tx.color === c}
                  onClick={() => updateText(tx.id, { color: c })}
                />
              ))}
            </div>
          </Field>
          {(tx.place ?? "free") === "free" && <Slider id="text-y" label="Position" value={tx.y} min={0.08} max={0.92} onChange={(v) => updateText(tx.id, { y: v }, "y-" + tx.id)} format={(v) => (v < 0.33 ? "Top" : v > 0.66 ? "Bottom" : "Middle")} />}
          <Slider id="text-size" label="Size" value={tx.size} min={0.025} max={0.14} onChange={(v) => updateText(tx.id, { size: v }, "size-" + tx.id)} format={(v) => `${Math.round(v * 100)}`} />
          <Slider id="text-start" label="Appears" value={tx.start} min={0} max={Math.max(0.1, total - 0.2)} step={0.01} onChange={(v) => updateText(tx.id, { start: v, end: Math.max(v + 0.3, tx.end) }, "start-" + tx.id)} format={(v) => `${v.toFixed(2)}s`} />
          <Slider id="text-end" label="Disappears" value={tx.end} min={0.2} max={Math.max(0.3, total)} step={0.01} onChange={(v) => updateText(tx.id, { end: Math.max(tx.start + 0.3, v) }, "end-" + tx.id)} format={(v) => `${v.toFixed(2)}s`} />
          <div className="row gap">
            <button
              className="btn"
              type="button"
              onClick={() => {
                const st = segmentStarts(segments);
                const i = st.findIndex((s, k) => engine.time >= s && engine.time < s + segments[k].duration);
                if (i >= 0) updateText(tx.id, { start: st[i], end: st[i] + segments[i].duration });
              }}
            >
              Fit to current shot
            </button>
            <button className="btn danger" type="button" onClick={() => deleteText(tx.id)}>
              <Icon name="trash" size={15} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- sound

function AudioPanel() {
  const p = useStore((s) => s.project);
  const song = useStore((s) => s.songs.find((x) => x.id === s.project.songId) ?? null);
  const anyAudio = useStore((s) => s.clips.some((c) => c.hasAudio));
  return (
    <div className="stack">
      <h2 className="panel-title">Sound</h2>
      <p className="lede">{song ? `Music: ${song.name}` : "No music yet. Add a song in the Music tab, or pull it out of any video."}</p>
      <Slider id="music-vol" label="Music" value={p.musicVolume} min={0} max={1} onChange={(v) => setProject({ musicVolume: v }, "musicVol")} format={(v) => `${Math.round(v * 100)}%`} />
      <Slider
        id="clip-vol"
        label="Original clip sound"
        value={p.clipVolume}
        min={0}
        max={1}
        onChange={(v) => {
          primeAudio();
          setProject({ clipVolume: v }, "clipVol");
        }}
        format={(v) => (v === 0 ? "Muted" : `${Math.round(v * 100)}%`)}
      />
      {!anyAudio && <p className="hint">None of the imported clips has sound we could read.</p>}
      <Toggle checked={p.fadeOut} onChange={(v) => setProject({ fadeOut: v })} label="Fade the music out at the end" />
      <button className="btn ghost" type="button" onClick={() => store.ui({ leftTab: "music" })}>
        <Icon name="music" size={15} /> Change music
      </button>
    </div>
  );
}
