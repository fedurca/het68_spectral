import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Without an include list vitest walks the whole tree, and the Emscripten SDK
    // cache that CI installs under the workspace contains *.test.js files that are
    // not ours and that fail as soon as they are loaded.
    include: ["packages/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/emsdk-cache/**",
      "**/wasm/**",
      "apps/desktop/release/**",
    ],
  },
});
