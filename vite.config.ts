import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Pages-проект не привязан к Git: бандл собирается здесь и загружается отсюда,
// поэтому VITE_* в нём — те, что лежат в локальном .env, а не что-то из дашборда.
// Сборка с VITE_BACKEND_URL на loopback уезжает на прод молча: сайт открывается,
// чип бэкенда честно пишет «бэкенд недоступен», и разница с настоящим простоем
// видна только если посмотреть в бандл. Так что петлю запрещаем на сборке.
const LOOPBACK = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

// Единственный внешний узел, шум про который мы глушим: wagmi тянет viem/tempo,
// ox/tempo/internal/virtualMasterPool.js импортирует node:worker_threads, и
// rolldown на каждую сборку пишет «externalized for browser compatibility».
//
// Заглушка привязана к ИМЕНИ модуля-импортёра, а не только к тексту шума, и это
// не аккуратность, а единственная доступная here страховка: проверить «модуль не
// доехал до бандла» по результату нельзя — в vite 8 браузерно-внешний узел не
// оставляет в чанке ни строки "node:…", ни записи в imports, ни записи в
// modules (проверено на сборке с намеренно живым импортом: в коде остаётся
// только обращение к require-стабу). Значит безопасность держится на узости
// совпадения: перенесёт upstream этот импорт в другой файл — предупреждение
// вернётся наружу как есть, и его придётся разбирать.
//
// Сегодня tempo-ветка вырезается tree-shaking'ом целиком: ни VirtualMaster, ни
// worker_threads в собранных чанках нет, и до клиента модуль не доезжает.
const IMPORTER = /imported by "([^"]+)"/;

function isTempoWorkerNoise(message: string): boolean {
  if (
    !/^Module "node:[a-z0-9_/]+" has been externalized for browser compatibility/.test(
      message,
    )
  ) {
    return false;
  }
  const importer = IMPORTER.exec(message)?.[1]?.split(/[\\/]/) ?? [];
  // Окно сужено до tempo-ветки ox: чужой node-импорт должен остаться слышимым.
  return importer.includes("ox") && importer.includes("tempo");
}

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
      watch: {
        ignored: [
          "**/coverage/**",
          "**/playwright-report/**",
          "**/test-results/**",
        ],
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        onwarn(warning, warn) {
          if (
            warning.message?.includes("annotation") &&
            warning.message?.includes("Rollup cannot interpret")
          ) {
            return;
          }
          if (
            warning.plugin === "rolldown:vite-resolve" &&
            isTempoWorkerNoise(warning.message ?? "")
          ) {
            return;
          }
          warn(warning);
        },
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (
                id.includes("/react/") ||
                id.includes("/react-dom/") ||
                id.includes("/react-is/") ||
                id.includes("/scheduler/")
              ) {
                return "vendor-react";
              }
              if (id.includes("wagmi") || id.includes("@wagmi")) {
                return "vendor-wagmi";
              }
              if (id.includes("recharts")) {
                return "vendor-charts";
              }
              if (id.includes("lucide-react")) {
                return "vendor-utils";
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
