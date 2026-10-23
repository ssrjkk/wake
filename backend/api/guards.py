"""
Проверки доступа, общие для роутеров: «кто этот человек» и «оператор ли это».

require_user отдаёт субъект подписанного токена (session.py). Роуты, у которых
есть владелец записи, больше не принимают идентификатор из запроса: право читать
и менять строку решает совпадение субъекта токена с колонкой владельца в базе, а
не то, что пришло в теле.

require_curator — машинный токен оператора: создание и резолюция рынков, ручной
прогон копи-движка. Это не пользователь, поэтому и держится отдельно от сессий:
сравнение по hmac.compare_digest, значение — в WAKE_CURATOR_TOKEN.
"""

import hmac

from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer

import session
from config import CURATOR_TOKEN

_bearer = HTTPBearer(auto_error=False)
# Схема вместо чтения Request.headers: тогда /docs и /openapi.json показывают,
# что операторские эндпоинты требуют заголовок. auto_error=False — отсутствие
# разберёт require_curator, чтобы ответ остался нашим {error: {code: …}}, а не
# сторонним «Not authenticated».
_curator = APIKeyHeader(
    name="X-Curator-Token",
    auto_error=False,
    description="Значение WAKE_CURATOR_TOKEN: рынки, резолюция, прогон копи-движка.",
)


def deny(status_code: int, code: str, message: str) -> HTTPException:
    """HTTPException в едином формате ошибок {error: {code, message}} — тот же,
    что отдаёт обработчик в app.py."""
    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )


async def require_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """user_id из Authorization: Bearer <токен>.

    Отказ отдаёт SessionError, а не HTTPException: код и формулировка известны
    session.verify, а статус и формат навешивает обработчик в app.py — иначе
    они дублировались бы в каждом роутере."""
    if credentials is None or not credentials.credentials:
        raise session.SessionError(
            "SESSION_REQUIRED",
            "Нужен токен входа в заголовке Authorization: Bearer <токен>",
        )
    return session.verify(credentials.credentials)


async def require_curator(supplied: str | None = Depends(_curator)) -> None:
    """Операторский доступ: токен из заголовка, сверка по постоянному времени.

    compare_digest на байтах, а не на строках: starlette декодирует заголовки как
    latin-1, и не-ASCII в строке иначе уронил бы сверку TypeError'ом (500) вместо
    честного 403."""
    if not CURATOR_TOKEN:
        raise deny(
            503,
            "CURATOR_NOT_CONFIGURED",
            "WAKE_CURATOR_TOKEN не настроен на сервере: операторские эндпоинты закрыты",
        )
        # 503, а не 500: причина — конфигурация сервера, а не запрос. Один язык
        # с SESSION_NOT_CONFIGURED и TELEGRAM_NOT_CONFIGURED нужен, чтобы у
        # клиента был единственный способ отличить «у сервера чего-то нет» от
        # «мой запрос плохой».
    if supplied is None or not hmac.compare_digest(
        supplied.encode(), CURATOR_TOKEN.encode()
    ):
        raise deny(
            403, "CURATOR_TOKEN_INVALID", "Недостаточно прав: требуется токен куратора"
        )
