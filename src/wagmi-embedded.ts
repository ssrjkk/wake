// Альтернатива src/wagmi.ts — embedded wallets вместо "поставь MetaMask".
// Пользователь логинится email/соцсетью, кошелёк создаётся для него за кулисами
// (MPC/secure enclave у провайдера) — seed-фразы не видит никто, включая Wake.
// Это НЕ кастодия Wake: приватный ключ управляется инфраструктурой Privy, не
// нашим backend'ом — принципиально другая модель доверия, чем если бы мы сами
// хранили чужие ключи (см. encrypted_key_store.py и почему это dev-стаб, не прод).
//
// npm install @privy-io/react-auth @privy-io/wagmi
// App ID — с https://dashboard.privy.io, реальный, не REPLACE_ME в проде.
//
// [!]  Не тестировалось мной (нет сети на npm install в этой песочнице). API
// Privy может немного отличаться от версии к версии — сверься с
// https://docs.privy.io/guide/react/wallets/embedded/overview перед использованием,
// тот же принцип честности, что с остальными непроверенными файлами в проекте.

import { http, createConfig } from "@privy-io/wagmi";
import { mainnet } from "wagmi/chains";

export const privyWagmiConfig = createConfig({
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
});

export const PRIVY_APP_ID = "REPLACE_ME"; // dashboard.privy.io

export const privyConfig = {
  embeddedWallets: {
    createOnLogin: "users-without-wallets" as const, // если у юзера уже есть MetaMask — используем его, не плодим второй кошелёк
  },
  loginMethods: ["email", "wallet", "google"] as const,
};

/*
Использование в src/main.tsx вместо WagmiProvider напрямую:

  import { PrivyProvider } from "@privy-io/react-auth";
  import { WagmiProvider } from "@privy-io/wagmi";
  import { privyWagmiConfig, PRIVY_APP_ID, privyConfig } from "./wagmi-embedded";

  <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
    <WagmiProvider config={privyWagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </PrivyProvider>

useAccount/useConnect из App.tsx продолжают работать без изменений — Privy's
wagmi-адаптер реализует тот же интерфейс, это и есть весь смысл интеграции
именно через wagmi, а не через отдельный, несовместимый SDK.
*/
