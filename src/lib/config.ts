// Конфигурация фронтенда: всё переопределяется переменными окружения VITE_*
// (см. .env или docker-compose). Значения по умолчанию — сборка без .env, как
// в CI и на Railway: backend указывает на развёрнутый сервис, signing service
// остаётся локальным (его поднимают отдельно, в образ фронта он не входит), а
// сеть Lighter — mainnet, как в backend/config.py. Разные сети по умолчанию
// были бы тихой ошибкой: бот и бэкенд показывают основной рынок, а фронт в это
// время дергает testnet с другими market ids.

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "https://wake-backend-production-3483.up.railway.app";
export const SIGNING_SERVICE_URL = import.meta.env.VITE_SIGNING_SERVICE_URL || "http://localhost:8787";
export const LIGHTER_NETWORK: "mainnet" | "testnet" = import.meta.env.VITE_LIGHTER_NETWORK || "mainnet";
export const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME || "";

// Project id WalletConnect выдают в cloud.walletconnect.com, и без него AppKit при
// старте бьётся на 400/403 к pulse.walletconnect.org: публичный placeholder
// ("REPLACE_ME") не работает, а консоль с ошибками — не работает и у юзера.
// Пустое значение здесь означает «relay не настроен», и wagmi.ts в этом случае
// просто не добавляет коннектор: injected-кошелёк (MetaMask, Rabby) заводится
// без чужого облака, а QR-подключение включается вместе с env-переменной.
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";