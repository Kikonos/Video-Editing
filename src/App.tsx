import { useEffect, useState } from "react";
import { checkAi, deleteSeg, duplicateSeg, engine, importFiles, loadDemo, primeAudio, splitAtPlayhead, startFresh } from "./actions.ts";
import { store, useStore, type MobileTab } from "./store.ts";
import { Segmented } from "./ui/controls.tsx";
import { ExportDialog } from "./ui/ExportDialog.tsx";
import { Icon } from "./ui/icons.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { Library } from "./ui/Library.tsx";
import { Monitor } from "./ui/Monitor.tsx";
import { Timeline } from "./ui/Timeline.tsx";

function useNarrow(): boolean {
  const q = "(max-width: 1100px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

const MOBILE_TABS: { value: MobileTab; label: string }[] = [
  { value: "auto", label: "Make" },
  { value: "footage", label: "Footage" },
  { value: "music", label: "Music" },
  { value: "shot", label: "Shot" },
  { value: "look", label: "Look" },
  { value: "text", label: "Text" },
  { value: "audio", label: "Sound" },
];

export function App() {
  const narrow = useNarrow();
  const exportOpen = useStore((s) => s.ui.exportOpen);
  const toastMsg = useStore((s) => s.ui.toast);
  const busy = useStore((s) => s.ui.busy);
  const mobileTab = useStore((s) => s.ui.mobileTab);
  const demo = useStore((s) => s.ui.demo);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    void loadDemo();
    void checkAi();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") && !(el instanceof HTMLInputElement && el.type === "range")) return;
      if (store.get().ui.exportOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      const sel = store.get().ui.selectedSeg;
      if (e.code === "Space") {
        e.preventDefault();
        primeAudio();
        engine.toggle();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        store.redo();
      } else if (!mod && e.key.toLowerCase() === "s") {
        splitAtPlayhead();
      } else if (!mod && e.key.toLowerCase() === "d" && sel) {
        duplicateSeg(sel);
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        deleteSeg(sel);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / 30;
        engine.seek(engine.time + (e.key === "ArrowLeft" ? -step : step));
      } else if (e.key === "Home") {
        engine.seek(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        setDragOver(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    },
  };

  return (
    <div className={`app ${narrow ? "narrow" : "wide"}`} {...dropProps}>
      <TopBar narrow={narrow} />
      {narrow ? (
        <>
          {demo && <DemoNote banner />}
          <Monitor />
          <Timeline />
          <section className="mobile-panels">
            <div className="mobile-tabs">
              <Segmented<MobileTab> label="Panels" value={mobileTab} onChange={(v) => store.ui({ mobileTab: v })} options={MOBILE_TABS} />
            </div>
            {mobileTab === "footage" || mobileTab === "music" ? <Library only={mobileTab} /> : <Inspector only={mobileTab} />}
          </section>
        </>
      ) : (
        <>
          <Library />
          <Monitor />
          <Inspector />
          <Timeline />
        </>
      )}
      {dragOver && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="upload" size={34} />
          <p>Drop videos to add footage, or a song to use as music</p>
        </div>
      )}
      {busy && (
        <div className="busy" role="status">
          <span className="spinner" /> {busy.label}
          {busy.cancel && (
            <button className="link" type="button" onClick={busy.cancel}>
              Stop
            </button>
          )}
        </div>
      )}
      {toastMsg && (
        <div className={`toast ${toastMsg.kind}`} role={toastMsg.kind === "error" ? "alert" : "status"}>
          {toastMsg.text}
        </div>
      )}
      {exportOpen && <ExportDialog />}
    </div>
  );
}

function DemoNote({ banner }: { banner?: boolean }) {
  return (
    <div className={banner ? "demo-banner" : "demo-note"}>
      <span>Sample reel made from built-in clips.</span>
      <button className="link" type="button" onClick={startFresh}>
        Start with my videos
      </button>
    </div>
  );
}

function TopBar({ narrow }: { narrow: boolean }) {
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const hasShots = useStore((s) => s.project.segments.length > 0);
  const demo = useStore((s) => s.ui.demo);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="brand-name">Reel Room</span>
      </div>
      {demo && !narrow && <DemoNote />}
      <span className="spacer" />
      <button className="icon-btn" type="button" onClick={() => store.undo()} disabled={!canUndo} title="Undo (Ctrl/⌘ Z)" aria-label="Undo">
        <Icon name="undo" />
      </button>
      <button className="icon-btn" type="button" onClick={() => store.redo()} disabled={!canRedo} title="Redo (Shift Ctrl/⌘ Z)" aria-label="Redo">
        <Icon name="redo" />
      </button>
      <button
        className="btn primary"
        type="button"
        disabled={!hasShots}
        onClick={() => {
          engine.pause();
          store.ui({ exportOpen: true });
        }}
      >
        <Icon name="download" size={16} /> Export
      </button>
    </header>
  );
}
