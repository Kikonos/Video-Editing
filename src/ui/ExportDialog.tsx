import { useEffect, useRef, useState } from "react";
import { engine, newCaption, primeAudio, saveCover, setProject } from "../actions.ts";
import { exportFormat, type ExportResult } from "../engine/engine.ts";
import { saveBlob } from "../engine/platform.ts";
import { ASPECTS } from "../engine/types.ts";
import { store, toast, useStore } from "../store.ts";
import { Segmented } from "./controls.tsx";
import { Icon } from "./icons.tsx";

type Phase = "setup" | "rendering" | "done" | "error";

export function ExportDialog() {
  const aspect = useStore((s) => s.project.aspect);
  const caption = useStore((s) => s.project.caption);
  const hashtags = useStore((s) => s.project.hashtags);
  const ai = useStore((s) => s.ui.ai);
  const [quality, setQuality] = useState<"1080" | "720">("1080");
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captionBusy, setCaptionBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const fmt = exportFormat();
  const base = ASPECTS[aspect];
  const k = quality === "1080" ? 1 : 720 / 1080;
  const W = Math.round((base.w * k) / 2) * 2;
  const H = Math.round((base.h * k) / 2) * 2;
  const total = engine.duration;

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const close = () => {
    if (phase === "rendering") return;
    store.ui({ exportOpen: false });
  };

  const start = async () => {
    primeAudio();
    abort.current = new AbortController();
    setPhase("rendering");
    setProgress(0);
    setError(null);
    try {
      const r = await engine.exportVideo({
        width: W,
        height: H,
        fps: 30,
        bitrate: quality === "1080" ? 14_000_000 : 8_000_000,
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      setResult(r);
      setUrl(URL.createObjectURL(r.blob));
      setPhase("done");
    } catch (e) {
      if ((e as DOMException).name === "AbortError") {
        setPhase("setup");
      } else {
        setError((e as Error).message || "Export failed.");
        setPhase("error");
      }
    }
  };

  const save = async () => {
    if (!result) return;
    const name = `reel-${new Date().toISOString().slice(0, 10)}.${result.ext}`;
    const r = await saveBlob(name, result.blob);
    if (r.status === "saved") toast("Video saved. Open Instagram, tap +, choose Reel and pick it.");
    else if (r.status !== "declined") toast(r.message ?? "Couldn't save the video.", "error");
  };

  const fullCaption = [caption, hashtags.join(" ")].filter(Boolean).join("\n\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullCaption);
      toast("Caption copied");
    } catch {
      const el = document.getElementById("caption-box") as HTMLTextAreaElement | null;
      el?.select();
      toast("Press Ctrl+C or ⌘C to copy the selected caption.");
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title" tabIndex={-1} ref={dialog} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <h2 id="export-title" className="panel-title">
            Export reel
          </h2>
          <button className="icon-btn" type="button" onClick={close} disabled={phase === "rendering"} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {phase === "setup" && (
          <div className="stack">
            <div className="spec num">
              <span>
                {W}×{H}
              </span>
              <span>30 fps</span>
              <span>{total.toFixed(1)} s</span>
              <span>{fmt ? (fmt.ext === "mp4" ? "MP4 · H.264" : "WebM") : "—"}</span>
            </div>
            <Segmented<"1080" | "720">
              label="Quality"
              value={quality}
              onChange={setQuality}
              options={[
                { value: "1080", label: "Full HD · best for Instagram" },
                { value: "720", label: "720p · smaller file" },
              ]}
            />
            {!fmt && <p className="err">This browser can't record video. Open the editor in Chrome, Edge or Safari to export.</p>}
            {fmt?.ext === "webm" && (
              <p className="hint">This browser records WebM. Instagram prefers MP4: if the upload is refused, export from Chrome or Safari instead.</p>
            )}
            <p className="hint">The reel plays through once while it records, so this takes about {Math.ceil(total)} seconds. Keep this tab open and in front until it finishes.</p>
            <button className="btn primary big" type="button" onClick={() => void start()} disabled={!fmt || total <= 0}>
              <Icon name="film" size={18} /> Render video
            </button>
          </div>
        )}

        {phase === "rendering" && (
          <div className="stack">
            <div className="progress big">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="num">
              Recording {Math.round(progress * 100)}% · {(progress * total).toFixed(1)} / {total.toFixed(1)} s
            </p>
            <p className="hint">Watch the preview behind this window: that's exactly what's being recorded.</p>
            <button className="btn" type="button" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="stack">
            <p className="err">{error}</p>
            <button className="btn" type="button" onClick={() => setPhase("setup")}>
              Try again
            </button>
          </div>
        )}

        {phase === "done" && result && url && (
          <div className="done">
            <video className="result" src={url} controls playsInline loop style={{ aspectRatio: `${W} / ${H}` }} />
            <div className="stack">
              <p className="num dim">
                {(result.blob.size / 1024 / 1024).toFixed(1)} MB · {result.ext.toUpperCase()} · {W}×{H}
              </p>
              <button className="btn primary big" type="button" onClick={() => void save()}>
                <Icon name="download" size={18} /> Save video
              </button>
              <button className="btn" type="button" onClick={() => void saveCover()}>
                <Icon name="image" size={15} /> Save cover image (current frame)
              </button>
              <label className="field" htmlFor="caption-box">
                <span className="eyebrow">Caption</span>
                <textarea
                  id="caption-box"
                  rows={5}
                  value={fullCaption}
                  onChange={(e) => {
                    const [first, ...rest] = e.target.value.split(/\n\s*\n/);
                    const tags = rest.join(" ").split(/\s+/).filter((t) => t.startsWith("#"));
                    setProject({ caption: first, hashtags: tags }, "caption");
                  }}
                />
              </label>
              <div className="row gap">
                <button className="btn" type="button" onClick={() => void copy()}>
                  <Icon name="copy" size={15} /> Copy caption
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={captionBusy}
                  onClick={async () => {
                    setCaptionBusy(true);
                    await newCaption();
                    setCaptionBusy(false);
                  }}
                >
                  {captionBusy ? <span className="spinner" /> : <Icon name="spark" size={15} />} {ai.available ? "Write another with Claude" : "Another idea"}
                </button>
              </div>
              <button className="link" type="button" onClick={() => setPhase("setup")}>
                Export again with different settings
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
