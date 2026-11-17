// Единственный владельца адреса Lighter. Его читают два места, и они обязаны
// называть один узел: клиент (откуда брать данные) и сборка (к какому origin
// страница греет соединение через preconnect). Два списка хостов разошлись бы
// молча — соединение грелось бы не к тому узлу, к которому реально идёт запрос,
// и никто бы этого не увидел: preconnect не ошибка, когда бесполезен.
//
// Адреса подтверждены официальными источниками Lighter (apidocs.lighter.xyz,
// GitHub elliottech/lighter-agent-kit), не угаданы из документации.

export const LIGHTER_API_URLS = {
  mainnet: "https://mainnet.zklighter.elliot.ai/api/v1",
  testnet: "https://testnet.zklighter.elliot.ai/api/v1",
} as const;

export type LighterNetwork = keyof typeof LIGHTER_API_URLS;

// Хост без пути и без схемы: его требует `rel="preconnect"`, где лишний путь
// просто не сработает.
export function lighterOrigin(network: LighterNetwork): string {
  return new URL(LIGHTER_API_URLS[network]).origin;
}
