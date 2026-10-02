import { http, createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { WALLETCONNECT_PROJECT_ID } from "./lib/config";

// Lighter's main-account registration and deposits are signed by a regular
// Ethereum L1 wallet (see docs.lighter.xyz/perpetual-futures/sub-accounts-and-api-keys).
// Order placement is a SEPARATE signing scheme (Lighter API keys, not this wallet) —
// see src/lib/lighter.ts and the README for why that matters.

// walletConnect() требует project id от cloud.walletconnect.com: с пустым или
// placeholder-значением AppKit при инициализации получает 400/403, и вся страница
// стартует с ошибками в консоли. Поэтому коннектор появляется только когда id
// задан — injected работает без внешнего облака и без него.
const connectors = [
  injected(),
  ...(WALLETCONNECT_PROJECT_ID ? [walletConnect({ projectId: WALLETCONNECT_PROJECT_ID })] : []),
];

export const config = createConfig({
  chains: [mainnet],
  connectors,
  transports: {
    [mainnet.id]: http(),
  },
});
