// Folds the `vite build --mode artifact` output into one self-contained page
// (CSS and app JS inlined, React from cdnjs) in the shape the Claude artifact viewer expects: page
// content only, with <title> and <style> first; the viewer adds the document
// skeleton. Output: artifact/reel-room.html
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const buildDir = "artifact/build";
const html = readFileSync(join(buildDir, "index.html"), "utf8");

const read = (rel) => readFileSync(join(buildDir, rel.replace(/^\.\//, "")), "utf8");

const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\.\/assets\/[^"]+\.css)"[^>]*>/g)].map((m) => read(m[1]));
const js = [...html.matchAll(/<script[^>]+src="(\.\/assets\/[^"]+\.js)"[^>]*><\/script>/g)].map((m) => read(m[1]));
if (!js.length) throw new Error("No script found in build output");

const title = /<title>[\s\S]*?<\/title>/.exec(html)?.[0] ?? "<title>Reel Room</title>";
const fontLinks = [...html.matchAll(/<link[^>]+href="https:\/\/fonts\.(googleapis|gstatic)\.com[^"]*"[^>]*>/g)].map((m) => m[0]);
// Loading screen and startup-error catcher from index.html (replaced once React mounts).
const boot = /<!-- boot -->([\s\S]*?)<!-- \/boot -->/.exec(html)?.[1].trim();
if (!boot) throw new Error("No boot block found in build output");
const safeJs = js.join("\n").replace(/<\/script/gi, "<\\/script");

const REACT = "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js";
const REACT_DOM = "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js";

const page = [
  title,
  `<style>\n${css.join("\n")}\n</style>`,
  ...fontLinks,
  boot,
  `<script src="${REACT}"></script>`,
  `<script src="${REACT_DOM}"></script>`,
  `<script>\n${safeJs}\n</script>`,
  "",
].join("\n");

const out = "artifact/reel-room.html";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
