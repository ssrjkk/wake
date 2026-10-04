/// <reference types="vite/client" />

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