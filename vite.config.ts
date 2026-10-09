import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        bridge: "src/bridge.ts",
        content: "src/content.ts",
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
