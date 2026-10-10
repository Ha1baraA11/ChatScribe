import { defineConfig } from "vite";

// Browser content scripts are classic scripts, so bundle this entry and every
// runtime dependency into one self-contained IIFE instead of emitting imports.
export default defineConfig({
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
