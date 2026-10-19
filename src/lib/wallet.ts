// Вход по подписи кошелька: proof-of-ownership из frontend. Бэкенд не верит, что
// адрес принадлежит тому, кто его прислал, пока не увидит подпись под текстом,
// который выдал сам (backend/wallet_auth.py).
//
// Challenge живёт пять минут и снимается первой же проверкой, поэтому повторная
// попытка берёт новый текст, а не переподписывает старый.
//
// Ответ /auth/wallet/verify — тот же, что у двух Telegram-входов, и он же привязывает
// индекс аккаунта Lighter: именно из этой записи его берёт публикация лидера
// (api/copy_trading.py), а не из тела запроса.
import { backendJson } from "./backend";
import type { SignInResponse } from "./session";

export type WalletChallenge = { message: string; expires_at: number };

// `sign` — signMessage из wagmi: personal_sign над строкой ровно такой, какой её
// прислал бэкенд. Любая правка текста (хоть перенос строки) ломает восстановление
// адреса, и вход отклоняется как недействительная подпись.
export async function verifyWalletOwnership(
  l1Address: string,
  sign: (message: string) => Promise<string>
): Promise<SignInResponse> {
  const challenge = await backendJson<WalletChallenge>("/auth/wallet/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ l1_address: l1Address }),
  });
  const signature = await sign(challenge.message);

  return backendJson<SignInResponse>("/auth/wallet/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: challenge.message, signature }),
  });
}
