import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./wagmi";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LIGHTER_NETWORK } from "./lib/config";

// Initialize Sentry for error monitoring (optional — only if VITE_SENTRY_DSN is set)
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    // Сеть берётся из того же значения, что читает lib/lighter.ts. Второй
    // дефолт здесь («|| "testnet"») расходился с дефолтом приложения (mainnet),
    // и прод без .env отчитывался в Sentry как тестнет.
    environment: LIGHTER_NETWORK,
    tracesSampleRate: 0.1,
  });
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
