import { useSyncExternalStore } from "react";
import type { Clip, Pace, Project, Song, StyleId } from "./engine/types.ts";
import { emptyProject } from "./engine/types.ts";

export type RightTab = "auto" | "shots" | "shot" | "look" | "text" | "audio";
export type LeftTab = "footage" | "music";

export interface AutoSettings {
  style: StyleId;
  pace: Pace;
  length: number | "auto";
  order: "story" | "energy";
  hook: boolean;
  useAI: boolean;
  /** Colour filter from the style. Off keeps every video's own colours. */
  filters: boolean;
}

export interface Busy {
  label: string;
  progress?: number;
  cancel?: () => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export type MobileTab = LeftTab | RightTab;

export interface UiState {
  leftTab: LeftTab;
  rightTab: RightTab;
  /** On narrow screens all panels share one tab strip. */
  mobileTab: MobileTab;
  selectedSeg: string | null;
  selectedText: string | null;
  safeZones: boolean;
  pxPerSec: number;
  busy: Busy | null;
  musicBusy: string | null;
  /** A song file the decoder refused: offer to listen to it once instead. */
  musicListen: { file: File; name: string; source: "video" | "audio" } | null;
  /** Recording a song by playing it (see listenForSong). */
  musicListening: boolean;
  toast: Toast | null;
  exportOpen: boolean;
  auto: AutoSettings;
  ai: { available: boolean; images: boolean; checked: boolean };
  directorNote: string | null;
  demo: boolean;
  /** The viewer rearranged shots by hand; automatic re-cuts must keep their order. */
  arranged: boolean;
  /** Clip open in the moment picker. */
  pickerClip: string | null;
}

export interface State {
  clips: Clip[];
  songs: Song[];
  project: Project;
  ui: UiState;
  past: Project[];
  future: Project[];
}

const initial: State = {
  clips: [],
  songs: [],
  project: emptyProject(),
  ui: {
    leftTab: "footage",
    rightTab: "auto",
    mobileTab: "auto",
    selectedSeg: null,
    selectedText: null,
    safeZones: false,
    pxPerSec: 64,
    busy: null,
    musicBusy: null,
    musicListen: null,
    musicListening: false,
    toast: null,
    exportOpen: false,
    auto: { style: "cinema", pace: "beat", length: "auto", order: "story", hook: true, useAI: true, filters: true },
    ai: { available: false, images: false, checked: false },
    directorNote: null,
    demo: false,
    arranged: false,
    pickerClip: null,
  },
  past: [],
  future: [],
};

class Store {
  private state: State = initial;
  private listeners = new Set<() => void>();
  private lastKey: string | null = null;
  private lastTime = 0;

  get = (): State => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  set(fn: (s: State) => State) {
    this.state = fn(this.state);
    this.emit();
  }

  ui(patch: Partial<UiState> | ((u: UiState) => Partial<UiState>)) {
    this.set((s) => {
      const p = typeof patch === "function" ? patch(s.ui) : patch;
      const mobile = p.mobileTab ?? p.rightTab ?? p.leftTab;
      return { ...s, ui: { ...s.ui, ...p, ...(mobile ? { mobileTab: mobile } : {}) } };
    });
  }

  /**
   * Change the project and record an undo step. Rapid edits with the same
   * key (a slider drag) collapse into one step.
   */
  edit(fn: (p: Project) => Project, key?: string) {
    const now = performance.now();
    const coalesce = key && key === this.lastKey && now - this.lastTime < 900;
    this.lastKey = key ?? null;
    this.lastTime = now;
    this.set((s) => {
      const next = fn(s.project);
      if (next === s.project) return s;
      return {
        ...s,
        project: next,
        past: coalesce ? s.past : [...s.past.slice(-79), s.project],
        future: [],
      };
    });
  }

  undo() {
    this.lastKey = null;
    this.set((s) => {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return { ...s, project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future] };
    });
  }

  redo() {
    this.lastKey = null;
    this.set((s) => {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, project: next, past: [...s.past, s.project], future: rest };
    });
  }
}

export const store = new Store();

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}

let toastId = 0;
export function toast(text: string, kind: "info" | "error" = "info") {
  const id = ++toastId;
  store.ui({ toast: { id, text, kind } });
  setTimeout(() => {
    if (store.get().ui.toast?.id === id) store.ui({ toast: null });
  }, kind === "error" ? 6000 : 3500);
}
