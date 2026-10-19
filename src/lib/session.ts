// Токен сессии Wake: где фронт хранит то, что выдаёт вход, и как он им
// пользуется.
//
// Бэкенд больше не верит идентификатору из запроса: `user_id`/`follower_id` в
// теле или в query это ровно то, что клиент о себе написал. Любое чтение или
// изменение чужого состояния теперь требует `Authorization: Bearer <токен>`,
// который подписал сервер (backend/session.py), поэтому у фронта обязано быть
// место, где этот токен лежит, и одна точка, откуда он уходит в заголовке.
//
// Срок годности токен имеет свой, и фронт знает его заранее: ответ входа несёт
// `expires_at`. Проверка на клиенте нужна не для безопасности (бэкенд проверяет
// подпись и так), а чтобы не слать заведомо мёртвый токен и не показывать
// «нет доступа» там, где надо один раз переподключить кошелёк.
//
// Хранилище — localStorage. Отзыва на сервере нет, поэтому выход удаляет токен
// только здесь: это честное «это устройство больше не подписывается под тобой»,
// а не разрыв сессии на сервере.

export type Session = {
  token: string;
  userId: string;
  // epoch-секунды: ту же единицу отдаёт бэкенд, переводить её во фронт-часы
  // значит собрать два разных «истёк» в одном приложении.
  expiresAt: number;
  lighterAccountIndex: number | null;
  // Как именно вошли и чем подписаться в шапке. Это cosmetics: личность определяет
  // server-side subject токена, а label/via нужны, чтобы после перезагрузки страницы
  // не показывать «tg_4350» там, где человек входил как @nick.
  label: string | null;
  via: "wallet" | "telegram" | null;
};

// Ответ любого подтверждённого входа (POST /auth/telegram, /auth/telegram/init,
// /auth/wallet/verify). Поля ровно те, что отдаёт backend/api/auth.py.
export type SignInResponse = {
  user_id: string;
  token: string;
  expires_at: number;
  lighter_account_index?: number | null;
};

const STORAGE_KEY = "wake.session.v1";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Приватный режим Firefox и Safari отдают SecurityError на сам доступ к
    // localStorage: вход без хранилища возможен, переживать перезагрузку — нет.
    return null;
  }
}

export function isSessionExpired(session: Session, now: number = Date.now() / 1000): boolean {
  return session.expiresAt <= now;
}

export function saveSession(response: SignInResponse, init: { label?: string | null; via?: Session["via"] } = {}): Session {
  const session: Session = {
    token: response.token,
    userId: response.user_id,
    expiresAt: response.expires_at,
    lighterAccountIndex: response.lighter_account_index ?? null,
    label: init.label ?? null,
    via: init.via ?? null,
  };
  storage()?.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

// Прочитанный с диска токен может быть истёкшим: процесс бэкенда мог пережить
// перезагрузку страницы, а 30 дней — нет. Наружу отдаётся только живой, иначе
// каждый запрос начинался бы с 401, а интерфейс — с объяснения «войди заново».
export function getSession(): Session | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  let session: Session;
  try {
    const parsed = JSON.parse(raw) as Session;
    if (typeof parsed?.token !== "string" || typeof parsed?.userId !== "string") return null;
    session = {
      token: parsed.token,
      userId: parsed.userId,
      expiresAt: Number(parsed.expiresAt) || 0,
      lighterAccountIndex: parsed.lighterAccountIndex ?? null,
      label: parsed.label ?? null,
      via: parsed.via ?? null,
    };
  } catch {
    return null;
  }
  if (isSessionExpired(session)) {
    clearSession();
    return null;
  }
  return session;
}

export function clearSession(): void {
  storage()?.removeItem(STORAGE_KEY);
}

// Заголовок для `backendJson`. Пустой объект, когда входа нет: запрос уходит
// анонимным, и бэкенд отвечает ему либо данными (публичные маршруты), либо 401.
export function authHeader(): Record<string, string> {
  const session = getSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}
