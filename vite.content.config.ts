import { defineConfig } from "vite";
import { computeBuildId } from "./scripts/build-id.mjs";

// Browser content scripts are classic scripts, so bundle this entry and every
// runtime dependency into one self-contained IIFE instead of emitting imports.
export default defineConfig({
  define: {
    __CHATSCRIBE_BUILD_ID__: JSON.stringify(computeBuildId()),
  },
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: "src/content.ts",
      output: {
        entryFileNames: "content.js",
        format: "iife",
      },
    },
  },
});
