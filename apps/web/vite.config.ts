import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Electron loads the same bundle from disk, so every asset reference has to be
    // relative rather than rooted at the server.
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  base: "./",
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    headers: {
      // Mirrors what the Cloudflare worker sends in production. Without these
      // SharedArrayBuffer is unavailable and the live audio ring would have to copy
      // every block, so development has to run under the same rules or the
      // difference only shows up after deployment.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
