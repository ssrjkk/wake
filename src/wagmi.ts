import { http, createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

// Lighter's main-account registration and deposits are signed by a regular
// Ethereum L1 wallet (see docs.lighter.xyz/perpetual-futures/sub-accounts-and-api-keys).
// Order placement is a SEPARATE signing scheme (Lighter API keys, not this wallet) —
// see src/lib/lighter.ts and the README for why that matters.
//
// Get a real project id at https://cloud.walletconnect.com before shipping.
const WALLETCONNECT_PROJECT_ID = "REPLACE_ME";

export const config = createConfig({
  chains: [mainnet],
  connectors: [injected(), walletConnect({ projectId: WALLETCONNECT_PROJECT_ID })],
  transports: {
    [mainnet.id]: http(),
  },
});
