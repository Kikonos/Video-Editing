import { useEffect, useRef, useState } from "react";
import { bestSongStart, importFiles, importMusic, insertMoment, listenForSong, primeAudio, removeClip, removeSong, retryClip, saveMusic, selectSong, setSongStart, clipAudioAsMusic, stopListening } from "../actions.ts";
import { formatTime, totalDuration } from "../engine/timeline.ts";
import type { Clip, Song } from "../engine/types.ts";
import { store, useStore, type LeftTab } from "../store.ts";
import { Meter, Segmented } from "./controls.tsx";
import { Icon } from "./icons.tsx";

export function Library({ only }: { only?: LeftTab }) {
  const tab = useStore((s) => s.ui.leftTab);
  const shown = only ?? tab;
  return (
    <section className="panel library" aria-label="Library">
      {!only && (
        <div className="panel-tabs">
          <Segmented<LeftTab>
            label="Library"
            value={tab}
            onChange={(v) => store.ui({ leftTab: v })}
            options={[
              { value: "footage", label: <><Icon name="film" size={15} /> Footage</> },
              { value: "music", label: <><Icon name="music" size={15} /> Music</> },
            ]}
          />
        </div>
      )}
      <div className="panel-body" key={shown}>{shown === "footage" ? <Footage /> : <Music />}</div>
    </section>
  );
}

function Footage() {
  const clips = useStore((s) => s.clips);
  const demo = useStore((s) => s.ui.demo);
  const input = useRef<HTMLInputElement>(null);
  const moments = clips.reduce((n, c) => n + (c.analysis?.moments.length ?? 0), 0);
  return (
    <>
      <button className="dropzone" type="button" onClick={() => input.current?.click()}>
        <Icon name="upload" size={22} />
        <span>
          <strong>Import videos</strong>
          <small>Drop clips from your camera or phone. Each one is scanned for its best moments on your device.</small>
        </span>
      </button>
      <input
        ref={input}
        id="import-videos"
        type="file"
        accept="video/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {clips.length > 0 && (
        <div className="list-head">
          <span className="eyebrow">{demo ? "Sample clips" : "Your clips"}</span>
          <span className="num dim">
            {clips.length} clips · {moments} moments
          </span>
        </div>
      )}
      <ul className="clips">
        {clips.map((c) => (
          <ClipCard key={c.id} clip={c} />
        ))}
      </ul>
    </>
  );
}

function ClipCard({ clip }: { clip: Clip }) {
  const [open, setOpen] = useState(false);
  const busy = clip.status === "loading" || clip.status === "analyzing";
  const moments = clip.analysis?.moments ?? [];
  return (
    <li className={`clip ${clip.status}`} style={{ ["--hue" as string]: clip.hue }}>
      <div className="clip-row">
        <button className="clip-thumb" type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Show moments in ${clip.name}`}>
          {clip.thumb ? <img src={clip.thumb} alt="" /> : <span className="thumb-blank" />}
          {clip.duration > 0 && <span className="badge num">{formatTime(clip.duration, false)}</span>}
        </button>
        <div className="clip-meta">
          <span className="clip-name" title={clip.name}>
            {clip.name}
          </span>
          {busy && (
            <span className="clip-status">
              <span className="bar">
                <span style={{ width: `${Math.round(clip.progress * 100)}%` }} />
              </span>
              <small>{clip.status === "loading" ? "Opening…" : "Finding best moments…"}</small>
            </span>
          )}
          {clip.status === "error" && (
            <>
              <small className="err">{clip.error}</small>
              {clip.kind === "video" && (
                <button className="link" type="button" onClick={() => retryClip(clip.id)}>
                  Retry
                </button>
              )}
            </>
          )}
          {clip.status === "ready" && (
            <span className="clip-status">
              <Meter value={clip.analysis?.quality ?? 0} />
              <small>
                {moments.length} moment{moments.length === 1 ? "" : "s"}
              </small>
            </span>
          )}
        </div>
        <div className="clip-actions">
          {clip.status === "ready" && (
            <button className="icon-btn" type="button" title="Pick your own moments in this clip" onClick={() => store.ui({ pickerClip: clip.id })}>
              <Icon name="star" size={16} />
            </button>
          )}
          {clip.kind === "video" && clip.hasAudio && (
            <button className="icon-btn" type="button" title="Use this clip's sound as the music" onClick={() => void clipAudioAsMusic(clip.id)}>
              <Icon name="music" size={16} />
            </button>
          )}
          <button className="icon-btn" type="button" title="Remove clip" onClick={() => removeClip(clip.id)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
      {clip.status === "ready" && (
        <div className="moment-strip" aria-label="Moments in this clip">
          <span className="strip-line" />
          {moments.map((m) => (
            <span
              key={m.id}
              className="strip-dot"
              style={{ left: `${(m.t / Math.max(0.1, clip.duration)) * 100}%`, ["--s" as string]: m.score }}
              title={`${formatTime(m.t)} · score ${Math.round(m.score * 100)}`}
            />
          ))}
        </div>
      )}
      {open && moments.length > 0 && (
        <div className="moments">
          {[...moments]
            .sort((a, b) => b.score - a.score)
            .map((m) => (
              <button key={m.id} type="button" className="moment" onClick={() => insertMoment(clip.id, m.id)} title="Add this moment to the timeline">
                {m.thumb && <img src={m.thumb} alt="" />}
                <span className="moment-info">
                  <span className="num">{formatTime(m.t)}</span>
                  <span className="num">{Math.round(m.score * 100)}</span>
                </span>
                {m.label && <span className="moment-label">{m.label}</span>}
                <span className="moment-add">
                  <Icon name="plus" size={14} />
                </span>
              </button>
            ))}
        </div>
      )}
    </li>
  );
}

/** Offered when the decoder refuses a song file: record it by playing it once. */
export function SongListen() {
  const pending = useStore((s) => s.ui.musicListen);
  const listening = useStore((s) => s.ui.musicListening);
  if (listening) {
    return (
      <div className="listen">
        <p>Playing the song once to record it. Keep this screen open.</p>
        <button className="btn sm" type="button" onClick={stopListening}>
          Stop and use what's recorded
        </button>
      </div>
    );
  }
  if (!pending) return null;
  return (
    <div className="listen">
      <p>
        This browser couldn't read the sound in <strong>{pending.name}</strong> directly. It can record it by playing it once instead (up to 3 minutes).
      </p>
      <button className="btn primary sm" type="button" onClick={listenForSong}>
        <Icon name="wave" size={14} /> Listen to the song
      </button>
    </div>
  );
}

function Music() {
  const songs = useStore((s) => s.songs);
  const songId = useStore((s) => s.project.songId);
  const busy = useStore((s) => s.ui.musicBusy);
  const input = useRef<HTMLInputElement>(null);
  const song = songs.find((s) => s.id === songId) ?? null;
  return (
    <>
      <button className="dropzone" type="button" onClick={() => input.current?.click()} disabled={!!busy}>
        <Icon name="wave" size={22} />
        <span>
          <strong>{busy ?? "Add music from any video"}</strong>
          <small>Pick a video with the song you want (a screen recording, a clip from a concert) or an audio file. The soundtrack is extracted and its beat mapped.</small>
        </span>
      </button>
      <input
        ref={input}
        id="import-music"
        type="file"
        accept="video/*,audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          primeAudio();
          if (f) void importMusic(f);
          e.target.value = "";
        }}
      />
      <SongListen />
      {song && <SongCard song={song} />}
      <p className="hint">
        Song on Spotify? Spotify doesn't let apps download its music. Screen-record the song playing (or any video with it), add that here, then export
        without the song and add the same track in Instagram, starting where the reel's music starts.
      </p>
      {songs.length > 1 && (
        <>
          <div className="list-head">
            <span className="eyebrow">Other tracks</span>
          </div>
          <ul className="songs">
            {songs
              .filter((s) => s.id !== songId)
              .map((s) => (
                <li key={s.id}>
                  <button type="button" className="song-pick" onClick={() => selectSong(s.id)}>
                    <Icon name="music" size={15} />
                    <span className="clip-name">{s.name}</span>
                    <span className="num dim">{Math.round(s.bpm)} BPM</span>
                  </button>
                  <button className="icon-btn" type="button" title="Remove track" onClick={() => removeSong(s.id)}>
                    <Icon name="close" size={15} />
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </>
  );
}

function SongCard({ song }: { song: Song }) {
  const songStart = useStore((s) => s.project.songStart);
  const segments = useStore((s) => s.project.segments);
  const total = totalDuration(segments) || 15;
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const start = preview ?? songStart;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth * dpr;
    const h = c.clientHeight * dpr;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    const wave = css.getPropertyValue("--wave").trim() || "#888";
    const beatCol = css.getPropertyValue("--beat").trim() || "#7ce0d6";
    const n = song.peaks.length;
    ctx.fillStyle = wave;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const a = song.peaks[i] * h * 0.42;
      ctx.fillRect(x, h / 2 - a, Math.max(1, w / n - 0.5), a * 2);
    }
    ctx.fillStyle = beatCol;
    for (const d of song.downbeats) {
      const x = (d / song.duration) * w;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x, h - 5 * dpr, 1 * dpr, 5 * dpr);
    }
    ctx.globalAlpha = 1;
  }, [song]);

  const toTime = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * song.duration;
  };
  const clampStart = (t: number) => Math.max(0, Math.min(t, Math.max(0, song.duration - Math.min(total, song.duration))));
  const win = Math.min(total, song.duration);

  return (
    <div className="song-card">
      <div className="song-top">
        <div className="song-title">
          <span className="clip-name" title={song.name}>
            {song.name}
          </span>
          <span className="song-facts num">
            <span className="bpm">{song.bpm.toFixed(0)} BPM</span>
            <span>{formatTime(song.duration, false)}</span>
            <span>{song.beats.length} beats</span>
          </span>
        </div>
      </div>
      <div
        className="wave"
        ref={wrap}
        role="slider"
        tabIndex={0}
        aria-label="Part of the song used in the reel"
        aria-valuemin={0}
        aria-valuemax={Math.round(song.duration)}
        aria-valuenow={Math.round(start)}
        aria-valuetext={`Starts at ${formatTime(start)}`}
        onKeyDown={(e) => {
          const bar = song.downbeats.length > 1 ? song.downbeats[1] - song.downbeats[0] : 2;
          if (e.key === "ArrowRight") setSongStart(clampStart(songStart + bar));
          if (e.key === "ArrowLeft") setSongStart(clampStart(songStart - bar));
        }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const t = toTime(e.clientX);
          const inside = t >= songStart && t <= songStart + win;
          const s0 = inside ? songStart : clampStart(t - win / 2);
          drag.current = { x: e.clientX, start: s0 };
          setPreview(s0);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const r = wrap.current!.getBoundingClientRect();
          const dt = ((e.clientX - drag.current.x) / r.width) * song.duration;
          setPreview(clampStart(drag.current.start + dt));
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          if (preview !== null) {
            // Snap the start to the nearest bar line so cuts stay on the one.
            let best = preview;
            let bd = Infinity;
            for (const d of song.downbeats) {
              const dd = Math.abs(d - preview);
              if (dd < bd) {
                bd = dd;
                best = d;
              }
            }
            setSongStart(clampStart(bd < 1.5 ? best : preview));
          }
          setPreview(null);
        }}
      >
        <canvas ref={canvas} />
        <span className="wave-window" style={{ left: `${(start / song.duration) * 100}%`, width: `${(win / song.duration) * 100}%` }}>
          <span className="num">{formatTime(start, false)}</span>
        </span>
      </div>
      <p className="hint">Drag the highlight to choose which part of the song plays. It snaps to the start of a bar.</p>
      <div className="row gap">
        <button className="btn" type="button" onClick={bestSongStart}>
          <Icon name="spark" size={15} /> Use the best part
        </button>
        <button className="btn ghost" type="button" onClick={() => void saveMusic()}>
          <Icon name="download" size={15} /> Save audio
        </button>
      </div>
    </div>
  );
}
