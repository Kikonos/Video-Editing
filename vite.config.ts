import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode artifact` builds one self-contained bundle (no code splitting, assets inlined)
// that scripts/make-artifact.mjs folds into a single HTML page.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  build: {
    outDir: mode === "artifact" ? "artifact/build" : "dist",
    emptyOutDir: true,
    assetsInlineLimit: mode === "artifact" ? 100_000_000 : 4096,
    cssCodeSplit: mode !== "artifact",
    rollupOptions:
      mode === "artifact" ? { output: { inlineDynamicImports: true } } : undefined,
  },
}));
