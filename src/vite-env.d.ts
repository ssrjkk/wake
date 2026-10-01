/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_SIGNING_SERVICE_URL?: string;
  readonly VITE_LIGHTER_NETWORK?: "mainnet" | "testnet";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}