import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.message?.includes("annotation") && warning.message?.includes("Rollup cannot interpret")) {
          return;
        }
        warn(warning);
      },
    },
  },
});
