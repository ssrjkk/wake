"""
Вход в Wake: три способа, один результат — подписанный токен сессии.

Два Telegram-потока ведут на одну и ту же запись follower:
- Login Widget (telegram.org/js/telegram-widget.js) — подпись по полям виджета,
  ключом служит SHA256 от токена бота;
- Mini App (window.Telegram.WebApp.initData) — подпись по query-строке initData,
  ключ выводится как HMAC-SHA256("WebAppData", токен).

Вывод ключа в этих потоках разный, поэтому проверки — две отдельные функции.
Обе отклоняют всё, что не смогли подтвердить токеном.

Третий способ — кошелёк. Здесь слово клиента ничего не стоит, поэтому вход
устроен как challenge/response (wallet_auth.py): бэкенд выдаёт текст, кошелёк
его подписывает, бэкенд восстанавливает адрес из подписи и сверяет.

Ответ любого подтверждённого входа — токен сессии (session.py). Дальше роутеры
читают субъект из токена, а не из тела запроса: user_id, присланный клиентом,
это ровно то, что клиент хочет, чтобы о нём подумали.
"""

import hashlib
import hmac
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool
from aiogram.utils.web_app import check_webapp_signature, safe_parse_webapp_init_data

import audit_log as al
import net
import session
import wallet_auth

# copy_db, а не db: в теле Telegram-эндпоинтов db — это сессия из Depends.
import db as copy_db
from config import LIGHTER_NETWORK, settings
from database import get_db
from lighter_rest import get_account_index_by_l1
from pg_models import Follower

router = APIRouter(prefix="/auth", tags=["auth"])

logger = logging.getLogger("wake.auth")

# Подпись живёт в URL и в истории сессий, поэтому свежесть — часть проверки, а не
# вежливость. 24 часа — столько же, сколько отведено Login Widget.
MAX_AUTH_AGE_S = 86400


class TelegramAuthData(BaseModel):
    id: int
    first_name: str
    last_name: str | None = None
    username: str | None = None
    photo_url: str | None = None
    auth_date: int
    hash: str


class MiniAppAuthData(BaseModel):
    # Строка целиком, как её отдаёт window.Telegram.WebApp.initData: разбирать и
    # проверять должен бэкенд на своём токене, а не браузер.
    init_data: str


class WalletChallengeRequest(BaseModel):
    l1_address: str


class WalletSignatureRequest(BaseModel):
    message: str
    signature: str


def verify_telegram_auth(data: TelegramAuthData) -> bool | None:
    """Verify Telegram Login Widget signature per Telegram docs.

    Возвращает False на неподтверждённой подписи и None, когда проверять нечем
    (на сервере нет TELEGRAM_BOT_TOKEN). Это разные ответы: второе — вина
    конфигурации, и роут отдаёт по нему 503, как это делает Mini App-поток для
    того же случая. 401 без токена учит клиента перелогиниться и вход не чинит.

    Два уточнения, каждое дороже остального:

      Проверка свежести (auth_date) обязательна: подпись живёт в URL и в истории
      сессий, и без неё один перехваченный ответ годился бы вечно.

      Значения полей не должны содержать перевод строки и «=». check_string
      склеивается как k=v\\n, поэтому поле, вписавшее в себя перевод строки с
      новой парой k=v, сдвигает границы между полями. Подпись Telegram на такую
      строку не подделать, но сверять её становится не с чем: имя пользователя и
      фото — текст, который Telegram не нормализует."""
    if not settings.telegram_bot_token:
        return None

    check_hash = data.hash
    token_hash = hashlib.sha256(settings.telegram_bot_token.encode()).digest()

    values = data.model_dump(exclude={"hash"})
    for key, value in values.items():
        if isinstance(value, str) and ("\n" in value or "=" in value):
            return False

    data_check_string = "\n".join(
        f"{k}={v}" for k, v in sorted(values.items()) if v is not None
    )

    h = hmac.new(token_hash, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(h, check_hash):
        return False

    if time.time() - data.auth_date > MAX_AUTH_AGE_S:
        return False

    return True


def verify_mini_app_init_data(init_data: str):
    """Проверяет подпись initData и возвращает разобраный payload.

    Ошибки — HTTPException: 503 без токена, 400 на пустой строке, 401 на чужой
    подписи, отсутствии пользователя или протухшем auth_date.
    """
    if not settings.telegram_bot_token:
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "TELEGRAM_NOT_CONFIGURED",
                    "message": "Telegram-вход не настроен: на бэкенде нет TELEGRAM_BOT_TOKEN",
                }
            },
        )
    if not init_data:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "EMPTY_INIT_DATA",
                    "message": "Пустой initData",
                }
            },
        )

    # aiogram разбирает query-строку ровно так, как её подписывает Telegram (включая
    # percent-encoding поля user), и считает HMAC по действующей спецификации.
    if not check_webapp_signature(settings.telegram_bot_token, init_data):
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "INVALID_SIGNATURE",
                    "message": "Подпись initData не совпала",
                }
            },
        )

    parsed = safe_parse_webapp_init_data(settings.telegram_bot_token, init_data)
    if parsed.user is None:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "NO_USER_IN_INIT_DATA",
                    "message": "В initData нет пользователя",
                }
            },
        )

    auth_date = parsed.auth_date
    # pydantic разворачивает unix-seconds в datetime с tzinfo=UTC, так что
    # .timestamp() даёт корректный абсолютный момент.
    if time.time() - auth_date.timestamp() > MAX_AUTH_AGE_S:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "INIT_DATA_EXPIRED",
                    "message": "initData старше 24 часов",
                }
            },
        )

    return parsed


async def _follower_for_telegram_user(db: AsyncSession, telegram_id: int) -> str:
    """Найти или создать follower по telegram_id.

    Один follower на оба Telegram-входа: ищем по telegram_id, чтобы виджет и
    мини-апп не плодили два аккаунта под одного человека. l1_address — NOT NULL
    UNIQUE, а L1-адреса у Telegram-входа нет, поэтому туда идёт то же имя, что и
    в user_id.

    Вставка обёрнута в SAVEPOINT и на IntegrityError перечитывается: два первых
    входа одного человека приходят обычно одним двойным тапом по кнопке, и без
    этого второй запрос ловил UNIQUE на l1_address — 500 вместо входа. Откат к
    savepoint при этом не трогает ничего вокруг: сессия запроса остаётся живой.
    """
    user_id = f"tg_{telegram_id}"

    result = await db.execute(
        select(Follower).where(Follower.telegram_id == telegram_id)
    )
    existing = result.scalar_one_or_none()

    if existing:
        return existing.id

    try:
        async with db.begin_nested():
            db.add(
                Follower(
                    id=user_id,
                    l1_address=f"tg:{telegram_id}",
                    telegram_id=telegram_id,
                )
            )
            await db.flush()
    except IntegrityError:
        row = await db.scalar(
            select(Follower).where(Follower.telegram_id == telegram_id)
        )
        if row is None:
            raise
        return row.id
    return user_id


async def _signed_in(user_id: str, via: str, request: Request) -> dict:
    """Один ответ на все способы входа и одна запись в аудит.

    Аудит по успешному входу нужен постфактум ровно в одном месте: без него
    «кто вообще заходил в этот аккаунт» не выясняется ничем, а это первый вопрос
    при разборе подозрительной сделки."""
    token, expires_at = session.issue(user_id)
    await al.log_action(
        al.AuditEntry(
            actor=user_id,
            action="sign_in",
            resource=f"follower:{user_id}",
            details={
                "via": via,
                "ip": net.client_ip(request),
            },
            success=True,
        )
    )
    return {"user_id": user_id, "token": token, "expires_at": expires_at}


@router.post("/telegram")
async def auth_telegram(
    data: TelegramAuthData,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Вход через Login Widget: проверяет подпись, создаёт запись и отдаёт токен."""
    verdict = verify_telegram_auth(data)
    if verdict is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "TELEGRAM_NOT_CONFIGURED",
                    "message": "Telegram-вход не настроен: на бэкенде нет TELEGRAM_BOT_TOKEN",
                }
            },
        )
    if not verdict:
        await al.log_action(
            al.AuditEntry(
                actor=f"tg_{data.id}",
                action="sign_in",
                resource="telegram",
                details={"via": "widget", "reason": "signature_rejected"},
                success=False,
            )
        )
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "INVALID_TELEGRAM_AUTH",
                    "message": "Telegram не подтвердил подпись полей входа",
                }
            },
        )

    user_id = await _follower_for_telegram_user(db, data.id)
    return await _signed_in(user_id, "telegram_widget", request)


@router.post("/telegram/init")
async def auth_telegram_init(
    data: MiniAppAuthData,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Вход изнутри мини-аппа: тот же follower и тот же токен, что у виджета."""
    parsed = verify_mini_app_init_data(data.init_data)
    user_id = await _follower_for_telegram_user(db, parsed.user.id)
    return await _signed_in(user_id, "telegram_miniapp", request)


@router.post("/wallet/challenge")
async def wallet_challenge(req: WalletChallengeRequest):
    """Текст, который нужно подписать (personal_sign), и срок его действия.

    Ответ не содержит ничего, чем можно воспользоваться без подписи: это
    одноразовый challenge, который живёт пять минут и снимается первым же
    /wallet/verify. Отказ (кривой адрес, мёртвый Redis) форматит обработчик в
    app.py — у WalletAuthError уже есть и код, и статус.
    """
    message, expires_at = await wallet_auth.new_challenge(req.l1_address)
    return {"message": message, "expires_at": expires_at}


@router.post("/wallet/verify")
async def wallet_verify(req: WalletSignatureRequest, request: Request):
    """Проверяет подпись кошелька и выдаёт токен.

    Индекс аккаунта Lighter берётся с Lighter по подтверждённому адресу, а не из
    запроса: присланный клиентом индекс позволял опубликовать лидера под чужим
    аккаунтом. Если Lighter не отвечает, вход всё равно остаётся входом — просто
    без привязанного индекса, а публикация лидера до его появления отклоняется
    явно.
    """
    try:
        address = await wallet_auth.verify_signature(req.message, req.signature)
    except wallet_auth.WalletAuthError as e:
        await al.log_action(
            al.AuditEntry(
                actor="wallet",
                action="sign_in",
                resource="unverified",
                details={"via": "wallet", "reason": e.code},
                success=False,
            )
        )
        raise

    try:
        account_index = await run_in_threadpool(
            get_account_index_by_l1, address, LIGHTER_NETWORK
        )
    except Exception as e:
        # Не только RuntimeError: Lighter может отдать битую форму строки, и
        # вход кошелька не должен из-за этого становиться 500 — индекс аккаунта
        # это удобство для публикации лидера, а не условие входа.
        logger.warning("индекс аккаунта Lighter не получен для %s: %s", address, e)
        account_index = None

    await copy_db.upsert_follower(
        id_=address, l1_address=address, lighter_account_index=account_index
    )

    body = await _signed_in(address, "wallet", request)
    body["lighter_account_index"] = account_index
    return body
