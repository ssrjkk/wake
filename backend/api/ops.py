"""
Операторское чтение состояния сервиса: GET /audit.

Аудит пишется после каждого чувствительного действия — вход, выдача токена,
сделка копи-движка, резолюция рынка, клима выигрыша. До этого роута его мог
прочитать только тот, у есть доступ к самой базе: в audit_log жили две
функции-читателя, ни одна не вызывалась приложением, и вопрос «кто вообще заходил
в этот аккаунт» разбирался через psql.

Роут под require_curator, а не под сессией пользователя: события чужих входов и
чужих сделок интересуют оператора, а не подписчика, и выдавать их по токену
сессии значило бы отдать любому клиенту чужую историю авторизаций.

Потолок строк — тот же, что у слоя хранения (audit_log.MAX_ROWS), поэтому
запрос «покажи всё» не выгружает таблицу в память процесса. details наружу
идут разобраным объектом: клиент, который читает причину отказа, не обязан
разбирать JSON внутри JSON.
"""

import json

from fastapi import APIRouter, Depends, Query

import audit_log as al
from api.guards import require_curator

router = APIRouter()


def _details(raw: str | None) -> object:
    """Строка колонки Text — в объект для ответа.

    Битая строка (таблицу дописали руками, колонку перепутали) не имеет права
    ронять выдачу: иначе отказ разбора выглядел бы как «сервис лежит», а не как
    «в одной строке не JSON». Такая строка уходит как есть."""
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


@router.get("/audit", dependencies=[Depends(require_curator)])
async def audit_events(
    actor: str | None = Query(
        None, max_length=200, description="user:…, follower:…, curator:…"
    ),
    action: str | None = Query(
        None, max_length=100, description="sign_in, trade_executed, …"
    ),
    failed_only: bool = Query(False, description="только отвергнутые действия"),
    since: float | None = Query(
        None, ge=0, description="epoch-секунды нижняя граница окна"
    ),
    limit: int = Query(al.DEFAULT_ROWS, ge=1, le=al.MAX_ROWS),
):
    rows = await al.recent_actions(
        actor=actor, action=action, failed_only=failed_only, since=since, limit=limit
    )
    return {
        "count": len(rows),
        "ceiling": al.MAX_ROWS,
        "rows": [dict(row, details=_details(row["details"])) for row in rows],
    }
