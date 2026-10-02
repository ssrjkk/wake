// Конфигурация фронтенда. Всё, что обычно хардкодилось на localhost, теперь
// переопределяется переменными окружения VITE_* (см. .env или docker-compose).
// Значения по умолчанию — локальная разработка: локальные backend и signing
// service, а сеть Lighter — mainnet, как в backend/config.py. Разные сети по
// умолчанию были бы тихой ошибкой: бот и бэкенд показывают основной рынок, а
// фронт в это время дергает testnet с другими market ids.

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";
export const SIGNING_SERVICE_URL = import.meta.env.VITE_SIGNING_SERVICE_URL ?? "http://localhost:8787";
export const LIGHTER_NETWORK: "mainnet" | "testnet" = import.meta.env.VITE_LIGHTER_NETWORK ?? "mainnet";
export const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME ?? "";

// Project id WalletConnect выдают в cloud.walletconnect.com, и без него AppKit при
// старте бьётся на 400/403 к pulse.walletconnect.org: публичный placeholder
// ("REPLACE_ME") не работает, а консоль с ошибками — не работает и у юзера.
// Пустое значение здесь означает «relay не настроен», и wagmi.ts в этом случае
// просто не добавляет коннектор: injected-кошелёк (MetaMask, Rabby) заводится
// без чужого облака, а QR-подключение включается вместе с env-переменной.
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";