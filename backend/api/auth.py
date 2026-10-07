"""
Telegram authentication endpoints.

Два разных Telegram-потока ведут на одну и ту же запись follower:
- Login Widget (telegram.org/js/telegram-widget.js) — подпись по полям виджета,
  ключом служит SHA256 от токена бота;
- Mini App (window.Telegram.WebApp.initData) — подпись по query-строке initData,
  ключ выводится как HMAC-SHA256("WebAppData", токен).

Вывод ключа в этих потоках разный, поэтому проверки — две отдельные функции.
Обе отклоняют всё, что не смогли подтвердить токеном.
"""

import hashlib
import hmac
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from aiogram.utils.web_app import check_webapp_signature, safe_parse_webapp_init_data

from database import get_db
from pg_models import Follower
from config import settings

router = APIRouter(prefix="/auth", tags=["auth"])

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


def verify_telegram_auth(data: TelegramAuthData) -> bool:
    """Verify Telegram Login Widget signature per Telegram docs."""
    if not settings.telegram_bot_token:
        return False

    check_hash = data.hash
    token_hash = hashlib.sha256(settings.telegram_bot_token.encode()).digest()

    data_check_string = "\n".join(
        f"{k}={v}"
        for k, v in sorted(data.model_dump(exclude={"hash"}).items())
        if v is not None
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
    """
    user_id = f"tg_{telegram_id}"

    result = await db.execute(
        select(Follower).where(Follower.telegram_id == telegram_id)
    )
    existing = result.scalar_one_or_none()

    if existing:
        return existing.id

    new_follower = Follower(
        id=user_id,
        l1_address=f"tg:{telegram_id}",
        telegram_id=telegram_id,
    )
    db.add(new_follower)
    await db.flush()
    return user_id


@router.post("/telegram")
async def auth_telegram(
    data: TelegramAuthData,
    db: AsyncSession = Depends(get_db),
):
    """Authenticate via Telegram Login Widget, return user_id."""
    if not verify_telegram_auth(data):
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "INVALID_TELEGRAM_AUTH",
                    "message": "Invalid Telegram auth data",
                }
            },
        )

    user_id = await _follower_for_telegram_user(db, data.id)

    return {
        "user_id": user_id,
        "telegram_id": data.id,
        "username": data.username,
        "first_name": data.first_name,
    }


@router.post("/telegram/init")
async def auth_telegram_init(
    data: MiniAppAuthData,
    db: AsyncSession = Depends(get_db),
):
    """Вход изнутри мини-аппа: проверяем initData и отдаём тот же user_id, что и виджет."""
    parsed = verify_mini_app_init_data(data.init_data)

    user_id = await _follower_for_telegram_user(db, parsed.user.id)

    return {
        "user_id": user_id,
        "telegram_id": parsed.user.id,
        "username": parsed.user.username,
        "first_name": parsed.user.first_name,
    }
