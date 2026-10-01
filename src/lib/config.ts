// Конфигурация фронтенда. Всё, что обычно хардкодилось на localhost, теперь
// переопределяется переменными окружения VITE_* (см. .env или docker-compose).
// Значения по умолчанию — локальная разработка: testnet Lighter + локальные
// backend и signing service.

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";
export const SIGNING_SERVICE_URL = import.meta.env.VITE_SIGNING_SERVICE_URL ?? "http://localhost:8787";
export const LIGHTER_NETWORK: "mainnet" | "testnet" = import.meta.env.VITE_LIGHTER_NETWORK ?? "testnet";