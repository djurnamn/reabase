import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

/**
 * reabase's webview UI.
 *
 * Production load is via `file://` inside REAPER's WKWebView (the Lua entry
 * points `Webview_Open` at `ui/dist/index.html`). WebKit silently refuses
 * `<script type="module">` under `file://` — so the build is inlined into a
 * single HTML file by `vite-plugin-singlefile`. (In dev we point the webview
 * at the Vite dev server over http, where modules work normally.)
 *
 * djui + @djui/reaper-webview + @reaper-webview/* are consumed from *source*
 * in their sibling repos under ~/Documents/Code/ rather than from npm:
 *   - those packages aren't published yet;
 *   - their built dists have `.scss` side-effect imports stripped (they
 *     expect the consumer's bundler to see djui's component .scss some other
 *     way) — bundling from source lets Vite pick the .scss up;
 *   - hot reload while we iterate on djui itself (we expect to find and fill
 *     gaps in djui as this UI takes shape).
 *
 * This assumes reabase, djui and reaper-webview-dev are checked out as
 * siblings. `react`/`react-dom` are deduped to this app's copy so the djui
 * source (which resolves React from djui's own node_modules) shares one
 * React instance with us.
 */
const djuiCore = path.resolve(__dirname, "../../djui/packages/core");
const djuiReaperWebview = path.resolve(__dirname, "../../djui/packages/reaper-webview");
const djuiLucide = path.resolve(__dirname, "../../djui/packages/lucide");
const djuiSonner = path.resolve(__dirname, "../../djui/packages/sonner");
const djuiUseFormDefinition = path.resolve(__dirname, "../../djui/packages/use-form-definition");
const reaperWebviewReact = path.resolve(__dirname, "../../reaper-webview-dev/packages/react");
const reaperWebviewClient = path.resolve(__dirname, "../../reaper-webview-dev/packages/client");

export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // These packages aren't in this app's node_modules — map every specifier
      // (bare + subpaths like `djui/styles/global.scss`) to their source tree.
      { find: /^djui\/styles\/(.*)/, replacement: path.join(djuiCore, "src/styles/$1") },
      { find: /^djui$/, replacement: path.join(djuiCore, "src/index.ts") },
      { find: /^@djui\/reaper-webview$/, replacement: path.join(djuiReaperWebview, "src/index.ts") },
      { find: /^@djui\/lucide$/, replacement: path.join(djuiLucide, "src/index.tsx") },
      { find: /^@djui\/sonner$/, replacement: path.join(djuiSonner, "src/index.tsx") },
      { find: /^@djui\/use-form-definition$/, replacement: path.join(djuiUseFormDefinition, "src/index.ts") },
      { find: /^@reaper-webview\/react$/, replacement: path.join(reaperWebviewReact, "src/index.ts") },
      { find: /^@reaper-webview\/client$/, replacement: path.join(reaperWebviewClient, "src/index.ts") },
    ],
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
        // `ui/src` first so we can later drop in our own
        // `djui-config.scss` (REAPER-themed, via reaperConfig + djui's
        // generator) and have djui's `global.scss` `@use "djui-config"`
        // pick it up. Until then it falls through to djui's default config
        // under core/src.
        loadPaths: [
          path.resolve(__dirname, "src"),
          path.join(djuiCore, "src"),
        ],
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
