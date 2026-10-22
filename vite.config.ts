import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Pages-проект не привязан к Git: бандл собирается здесь и загружается отсюда,
// поэтому VITE_* в нём — те, что лежат в локальном .env, а не что-то из дашборда.
// Сборка с VITE_BACKEND_URL на loopback уезжает на прод молча: сайт открывается,
// чип бэкенда честно пишет «бэкенд недоступен», и разница с настоящим простоем
// видна только если посмотреть в бандл. Так что петлю запрещаем на сборке.
const LOOPBACK = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

export default defineConfig(({ mode }) => {
  const backend = loadEnv(mode, process.cwd(), "VITE_").VITE_BACKEND_URL;
  if (mode === "production" && backend && LOOPBACK.test(backend)) {
    throw new Error(
      `VITE_BACKEND_URL=${backend}: боевая сборка не может указывать фронтенд на loopback — ` +
        "каждый посетитель будет стучаться в собственную машину. Убери переменную " +
        "(дефолт в src/lib/config.ts — развёрнутый бэкенд) или поставь боевой адрес.",
    );
  }

  return {
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
  };
});
