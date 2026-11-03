import { defineConfig } from "vite";
import { computeBuildId } from "./scripts/build-id.mjs";

// Claude's isolated-world listener is injected only after optional site access.
export default defineConfig({
  define: {
    __CHATSCRIBE_BUILD_ID__: JSON.stringify(computeBuildId()),
  },
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: "src/claude-content.ts",
      output: {
        entryFileNames: "claude-content.js",
        format: "iife",
      },
    },
  },
});
