import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WKWebView on supported macOS (10.13+) ships at least Safari 11, but
    // Tauri 2 itself requires features that effectively cap the minimum at
    // macOS 11+ ≈ Safari 14. xterm 6.x's bundled code hits an esbuild
    // minify bug when downleveled to safari13 — variables get dropped from
    // requestMode causing "Can't find variable: i" at runtime. Safari 14
    // is the safe modern floor.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
