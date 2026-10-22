import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: { ignored: ["**/coverage/**", "**/playwright-report/**", "**/test-results/**"] },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.message?.includes("annotation") && warning.message?.includes("Rollup cannot interpret")) {
          return;
        }
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-is/') || id.includes('/scheduler/')) {
              return 'vendor-react';
            }
            if (id.includes('wagmi') || id.includes('@wagmi')) {
              return 'vendor-wagmi';
            }
            if (id.includes('recharts')) {
              return 'vendor-charts';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-utils';
            }
          }
        },
      },
    },
    sourcemap: false,
    cssCodeSplit: true,
  },
});
