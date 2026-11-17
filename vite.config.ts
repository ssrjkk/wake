import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { lighterOrigin, type LighterNetwork } from "./src/lib/networks.ts";

// Pages-проект не привязан к Git: бандл собирается здесь и загружается отсюда,
// поэтому VITE_* в нём — те, что лежат в локальном .env, а не что-то из дашборда.
// Сборка с VITE_BACKEND_URL на loopback уезжает на прод молча: сайт открывается,
// чип бэкенда честно пишет «бэкенд недоступен», и разница с настоящим простоем
// видна только если посмотреть в бандл. Так что петлю запрещаем на сборке —
// тем же разбором адреса, которым панель решает, называть ли адрес в тексте
// ошибки (src/lib/loopback.ts): два пересказа правила разошлись бы тихо.
import { loopbackBuildProblem } from "./src/lib/loopback.ts";

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

// Адрес сайта, который видит мир: canonical, og:url, og:image, twitter:image.
// Литералом он лежал в index.html до того, как фронт вообще умел собираться
// куда-то, кроме Pages: на собственном домене страница назвала бы чужой, а
// карточку ссылки в чате мессенджер строит именно по этим тегам — JavaScript он
// для этого не исполняет. Отсюда же preconnect: греть соединение имеет смысл
// только к тому узлу, к которому сборка реально ходит, поэтому хост берётся из
// того же модуля, что и клиентский адрес (src/lib/networks.ts).
const SITE_URL_DEFAULT = "https://wake-7k6.pages.dev";

function siteMeta(env: Record<string, string | undefined>) {
  const site = env.VITE_SITE_URL || SITE_URL_DEFAULT;
  let origin: string;
  try {
    origin = new URL(site).origin;
  } catch {
    throw new Error(
      `VITE_SITE_URL="${site}" — не абсолютный адрес: canonical и og:url требуют схему, например https://wake.example.com`,
    );
  }
  const network: LighterNetwork = env.VITE_LIGHTER_NETWORK === "testnet" ? "testnet" : "mainnet";
  return {
    name: "wake-site-meta",
    transformIndexHtml: (html: string) =>
      html.replaceAll("%SITE_URL%", origin).replaceAll("%LIGHTER_ORIGIN%", lighterOrigin(network)),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const backend = env.VITE_BACKEND_URL;
  const problem = loopbackBuildProblem(mode, backend);
  if (problem) throw new Error(problem);

  return {
    plugins: [react(), siteMeta(env)],
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
              if (id.includes("lightweight-charts")) {
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
