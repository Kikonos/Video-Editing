import { detectBeats } from "./beats.ts";

self.onmessage = (e: MessageEvent<{ id: number; mono: Float32Array; sr: number }>) => {
  const { id, mono, sr } = e.data;
  try {
    const result = detectBeats(mono, sr);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
