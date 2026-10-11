import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode artifact` builds one self-contained script (React comes from the
// cdnjs UMD build) that scripts/make-artifact.mjs folds into a single page.
export default defineConfig(({ mode }) => {
  const artifact = mode === "artifact";
  return {
    base: "./",
    plugins: [react()],
    worker: { format: "es" },
    resolve: artifact
      ? { alias: [{ find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("./src/jsx-shim.ts", import.meta.url)) }] }
      : undefined,
    build: {
      outDir: artifact ? "artifact/build" : "dist",
      // Keep the artifact page readable: it is reviewed before each publish.
      minify: artifact ? false : "esbuild",
      emptyOutDir: true,
      assetsInlineLimit: artifact ? 100_000_000 : 4096,
      cssCodeSplit: !artifact,
      rollupOptions: artifact
        ? {
            external: ["react", "react-dom", "react-dom/client"],
            output: {
              format: "iife",
              inlineDynamicImports: true,
              globals: { react: "React", "react-dom": "ReactDOM", "react-dom/client": "ReactDOM" },
            },
          }
        : undefined,
    },
  };
});
