import { defineConfig } from "vite";
import { computeBuildId } from "./scripts/build-id.mjs";

// The bridge runs in ChatGPT's MAIN world through chrome.scripting and is
// declared as a classic content script in the browser manifests. Bundle all
// dependencies into one IIFE so Chrome never receives ES-module imports here.
export default defineConfig({
  define: {
    __CHATSCRIBE_BUILD_ID__: JSON.stringify(computeBuildId()),
  },
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: "src/bridge.ts",
      output: {
        entryFileNames: "bridge.js",
        format: "iife",
      },
    },
  },
});
