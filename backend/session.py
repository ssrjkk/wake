"""
Сессия Wake: чем бэкенд подтверждает «этот запрос — от того, кому мы выдали
вход».

Повод появиться: до этого бэкенд принимал user_id и follower_id из тела или
query, то есть идентичность клиента была тем, что клиент сам о себе написал.
Зная чужой follower_id, можно было записать сделку на его позиции, забрать его
выигрыш и остановить его подписки. С тех пор как в follows лежат аллокации, это
не косметика, а доступ к чужим деньгам.

Форма — компактная, без JWT-зависимости: base64url(JSON {sub, iat, exp}) плюс
HMAC-SHA256 по этой строке. Проверка — compare_digest, затем exp. отзыва не
хранится: у токена короткий срок, а доступ, который он даёт, — некастодиальный
терминал, а не сессия банка.

Секрет — WAKE_SESSION_SECRET. Без него выдача отвечает 503, а не подписывает
чем-попало: токен, подписанный угадываемым ключом, это открытая подпись.
"""

import base64
import hashlib
import hmac
import json
import time

from config import SESSION_SECRET, SESSION_TTL_S


class SessionError(Exception):
    """Причина отказа с кодом и HTTP-статусом для единого формата ошибок.

    Статус по умолчанию 401 — «не пустили». 503 нужен для другой причины:
    сервер не может проверить подпись, потому что секрета нет; клиент тут ни
    при чём, и предлагать ему перелогиниться — значит отправить его в цикл."""

    def __init__(self, code: str, message: str, status_code: int = 401):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def issue(user_id: str, now: float | None = None) -> tuple[str, float]:
    """Возвращает (токен, epoch-секунды до истечения).

    exp отдаётся наружу, потому что фронт по нему и решает, когда снова просить
    подпись кошелька, а не гадать по 401."""
    if not SESSION_SECRET:
        raise SessionError(
            "SESSION_NOT_CONFIGURED",
            "Вход невозможен: на сервере нет WAKE_SESSION_SECRET",
            503,
        )
    issued_at = time.time() if now is None else now
    expires_at = issued_at + SESSION_TTL_S
    payload = _b64(
        json.dumps(
            {"sub": user_id, "iat": int(issued_at), "exp": int(expires_at)},
            separators=(",", ":"),
        ).encode()
    )
    return f"wk1.{payload}.{_sign(payload, SESSION_SECRET)}", expires_at


def verify(token: str, now: float | None = None) -> str:
    """Возвращает subject токена. SessionError — если это не токен, не наш
    токен, недействительная подпись или истёкший срок."""
    if not SESSION_SECRET:
        raise SessionError(
            "SESSION_NOT_CONFIGURED",
            "Сессии не выдаются: на сервере нет WAKE_SESSION_SECRET",
        )
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "wk1":
        raise SessionError("SESSION_MALFORMED", "Токен имеет не форму сессии Wake")
    payload, signature = parts[1], parts[2]
    if not hmac.compare_digest(signature, _sign(payload, SESSION_SECRET)):
        raise SessionError("SESSION_BAD_SIGNATURE", "Подпись токена не совпала")
    try:
        claims = json.loads(_unb64(payload))
        subject = claims["sub"]
        expires_at = float(claims["exp"])
    except Exception:
        raise SessionError("SESSION_MALFORMED", "Внутренняя часть токена не читается")

    moment = time.time() if now is None else now
    if moment > expires_at:
        raise SessionError("SESSION_EXPIRED", "Срок токена истёк — нужен новый вход")
    return str(subject)
