import { defineConfig } from "vite";
import { computeBuildId } from "./scripts/build-id.mjs";

export default defineConfig({
  define: {
    __CHATSCRIBE_BUILD_ID__: JSON.stringify(computeBuildId()),
  },
  build: {
    rollupOptions: {
      input: {
        background: "src/background.ts",
        popup: "src/popup.ts",
        options: "src/options.ts",
        offscreen: "src/offscreen.ts",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
