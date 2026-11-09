/// <reference types="vite/client" />

// Без этого флага `ImportMetaEnv` дополняется индексным типом `Record<string, any>`
// (см. node_modules/vite/types/importMeta.d.ts), и опечатка в имени переменной
// компилируется: `VITE_SIGNING_URL` вместо `VITE_SIGNING_SERVICE_URL` даёт `any`
// и `undefined` на рантайме, а не ошибку типов. С флагом любое имя вне списка
// ниже краснеет на `npx tsc --noEmit`, который CI и так гоняет.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_SIGNING_SERVICE_URL?: string;
  readonly VITE_LIGHTER_NETWORK?: "mainnet" | "testnet";
  readonly VITE_TELEGRAM_BOT_NAME?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}