"""
Proof-of-ownership кошелька: вход, где вместо доверия слову клиента — подпись.

Повод появиться: эндпоинт регистрации подписчика принимал любой l1_address, и
записаться «чужим кошельком» было делом одной строки JSON; follow_id из такой
записи открывал чужие подписки и чужой mirror-лог. Теперь бэкенд выдаёт текст,
который умеет подписать только владелец приватного ключа, проверяет подпись
(eth-account восстанавливает адрес из подписи) и признаёт адрес своим только
после совпадения.

Challenge лежит в Redis (SET с TTL + GETDEL): одноразовость и пятиминутный срок
обязаны переживать рестарт процесса и работать одновременно в нескольких
воркерах, а в памяти процесса их держать нельзя — второй воркер не увидел бы
выданное первым. Без Redis вход кошельком отвечает 503, а не «подпишем на
веру».
"""

import hashlib
import json
import logging
import re
import secrets
import time

import redis.asyncio as redis
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import to_checksum_address

from config import REDIS_URL

logger = logging.getLogger("wake.wallet_auth")

CHALLENGE_TTL_S = 300
_NONCE_RE = re.compile(r"^nonce: ([0-9a-f]{32})$", re.MULTILINE)
_LOG_NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
_REASONS = frozenset({"не JSON", "не объект JSON", "нет полей", "тип поля"})
_KEY = "wake:wallet:"


def _nonce_for_log(nonce: str) -> str:
    """Nonce приходит из тела клиента и стоит ровно пять минут, поэтому в аудит
    уходит только префикс его образа: строку лога это по-прежнему сопоставляет с
    запросом, а сырой hex (и перевод строки внутри него) наружу не печатается."""
    if not _LOG_NONCE_RE.fullmatch(nonce):
        return "<invalid>"
    return hashlib.sha256(nonce.encode()).hexdigest()[:12]


class WalletAuthError(Exception):
    """Отказ proof-of-ownership с кодом и статусом для единого формата ошибок:
    кривой адрес — 400, непрошедшая подпись — 401, недоступный Redis — 503."""

    def __init__(self, code: str, message: str, status_code: int = 401):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


_client: redis.Redis | None = None


def _store() -> redis.Redis:
    global _client
    if _client is None:
        # Таймаут, а не вечное ожидание: Redis, который висит, должен превращать
        # вход в 503 (проверяется в new_challenge/verify_signature), а не в
        # зависший запрос, держащий соединение браузера.
        _client = redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_timeout=2.0,
            socket_connect_timeout=2.0,
        )
    return _client


async def close() -> None:
    """Закрыть клиент Redis (вызывается lifespan'ом на остановке).

    Клиент живёт на уровне модуля, как и у лимитера: пул соединений переживает
    один запрос и должен умирать вместе с процессом, иначе рестарт оставляет
    висящие соединения на стороне сервера."""
    global _client
    client, _client = _client, None
    if client is not None:
        await client.aclose()


def normalize_address(l1_address: str) -> str:
    """EIP-55 checksum или явная ошибка: адрес в базе должен иметь одну форму во
    всех записях, иначе «тот же» кошелёк в нижнем регистре создаст вторую
    строку."""
    try:
        return to_checksum_address(l1_address)
    except (ValueError, TypeError):
        raise WalletAuthError(
            "INVALID_ADDRESS", f"Не Ethereum-адрес: {l1_address!r}", 400
        ) from None


def challenge_text(address: str, nonce: str, expires_at: float) -> str:
    """Текст, который подписывает кошелёк. Адрес и срок входят в тело подписи,
    поэтому подпись нельзя ни перенести на другой адрес, ни использовать после
    истечения — и нельзя подставить в чужое приложение: строка называет Wake."""
    return (
        f"Wake sign-in\naddress: {address}\nnonce: {nonce}\nexpires: {int(expires_at)}"
    )


async def new_challenge(l1_address: str) -> tuple[str, float]:
    """Выдаёт (текст подписи, epoch истечения).Nonce случайный и хранится под
    своим ключом: угадать challenge, чтобы потом подделать подпись, нельзя."""
    address = normalize_address(l1_address)
    nonce = secrets.token_hex(16)
    expires_at = time.time() + CHALLENGE_TTL_S
    message = challenge_text(address, nonce, expires_at)
    try:
        await _store().set(
            f"{_KEY}{nonce}",
            json.dumps(
                {"address": address, "message": message, "exp": int(expires_at)}
            ),
            ex=CHALLENGE_TTL_S,
        )
    except redis.RedisError as e:
        raise WalletAuthError(
            "CHALLENGE_STORE_UNAVAILABLE",
            "Сервер не смог сохранить challenge (Redis недоступен) — вход кошельком временно недоступен",
            503,
        ) from e
    return message, expires_at


def _nonce_of(message: str) -> str:
    match = _NONCE_RE.search(message)
    if not match:
        raise WalletAuthError("CHALLENGE_UNKNOWN", "Это не тот текст, что выдавал Wake")
    return match.group(1)


def _broken_record(nonce: str, reason: str) -> WalletAuthError:
    """Challenge в Redis читается, но не как запись Wake.

    Ключ `wake:wallet:*` пишет только этот модуль, поэтому битая форма — это
    повреждение хранилища (ручная правка ключа, чужой дамп на том же инстансе), а
    не вина клиента. Отвечать таким 400 значит отправлять человека переделывать то,
    что он не трогал, и спрятать инцидент: в аудите он выглядел бы как неудачная
    попытка входа, а не как отказ сервиса.

    reason — одна из меток `_REASONS`: разбор записи даёт строки, производные от
    клиентских байтов, а в аудит попадает только замкнутый словарь."""
    logger.error(
        "challenge %s: запись Redis повреждена (%s)",
        _nonce_for_log(nonce),
        reason if reason in _REASONS else "unclassified",
    )
    return WalletAuthError(
        "CHALLENGE_STORE_CORRUPTED",
        "Сервер не смог разобрать сохранённый challenge — вход кошельком временно недоступен",
        503,
    )


def _record_of(raw: str, nonce: str) -> dict:
    """Разбор challenge-записи: объект JSON с теми же полями, что пишет new_challenge.

    Каждый доступ к полю ниже идёт без guard'а, поэтому проверка типов стоит здесь
    один раз: `json.loads` может дать число или список, а `record["exp"]` —
    отсутствовать, и тогда вход падал ValueError'ом в конвертер ошибок."""
    try:
        record = json.loads(raw)
    except (TypeError, ValueError):
        raise _broken_record(nonce, "не JSON") from None
    if not isinstance(record, dict):
        raise _broken_record(nonce, "не объект JSON")
    missing = {"address", "message", "exp"} - record.keys()
    if missing:
        raise _broken_record(nonce, "нет полей")
    for field, kind in (("address", str), ("message", str), ("exp", (int, float))):
        if not isinstance(record[field], kind):
            raise _broken_record(nonce, "тип поля")
    return record


async def verify_signature(message: str, signature: str) -> str:
    """Проверяет подпись и возвращает подтверждённый адрес.

    Подпись снимается с challenge одним GETDEL: повторный прогон того же
    (message, signature) не даёт второй вход, даже если его перехватили."""
    nonce = _nonce_of(message)
    try:
        raw = await _store().getdel(f"{_KEY}{nonce}")
    except redis.RedisError as e:
        raise WalletAuthError(
            "CHALLENGE_STORE_UNAVAILABLE",
            "Сервер не смог проверить challenge (Redis недоступен)",
            503,
        ) from e
    if raw is None:
        raise WalletAuthError(
            "CHALLENGE_STALE", "Challenge не найден или уже использован — запроси новый"
        )

    record = _record_of(raw, nonce)
    if time.time() > record["exp"]:
        raise WalletAuthError("CHALLENGE_EXPIRED", "Challenge истёк — запроси новый")
    if message != record["message"]:
        raise WalletAuthError(
            "CHALLENGE_MISMATCH", "Текст подписи не совпадает с выданным"
        )

    try:
        recovered = Account.recover_message(
            encode_defunct(text=message), signature=signature
        )
    except Exception:
        raise WalletAuthError(
            "BAD_SIGNATURE",
            "Подпись не восстанавливается в адрес — проверь, что подписал именно этот текст",
        ) from None

    # EIP-55, а не то, что вернула библиотека: адрес — первичный ключ follower,
    # и одна и та же строка в базе должна быть в одной форме у всех.
    if recovered.lower() != record["address"].lower():
        raise WalletAuthError(
            "ADDRESS_MISMATCH",
            "Подпись оставлена другим кошельком, а не тем адресом, что запрашивал вход",
        )
    return to_checksum_address(recovered)
