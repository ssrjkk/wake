"""
Резолюция исхода рынка — сюда, а не в predict_amm.py, потому что это два
принципиально разных по доверию механизма, и путать их в одном месте — это
именно то, как в реальных prediction markets возникают споры и потери денег.

resolve_price_market() — АВТОМАТИЧЕСКАЯ резолюция. Работает только для рынков
про цены на самих рынках Lighter (BTC/ETH и т.п.), потому что Lighter уже
является достаточно авторитетным источником mark price для СВОИХ же рынков —
это не привнесённое доверие, а то же доверие, которое уже требуется, чтобы
вообще торговать на Lighter.

resolve_event_market() — НЕ автоматическая. Для "кто победит на выборах",
"кто выиграет матч" и т.п. нет источника правды внутри Lighter или внутри этого
кода — нужен человек-куратор (или в будущем — что-то вроде UMA Optimistic
Oracle с dispute-периодом, как у настоящего Polymarket; здесь этого нет,
намеренно не притворяюсь, что есть). Функция ниже — тонкая, откровенно
"trust me" обёртка с обязательной записью КТО резолвил и КОГДА — минимум
для аудита, не замена реальному decentralized dispute-механизму.
"""

import time
import audit_log as al
from config import AUDIT_DB_PATH
from dataclasses import dataclass
from enum import Enum


class Comparator(Enum):
    GTE = ">="
    LTE = "<="
    GT = ">"
    LT = "<"


_OPS = {
    Comparator.GTE: lambda price, threshold: price >= threshold,
    Comparator.LTE: lambda price, threshold: price <= threshold,
    Comparator.GT: lambda price, threshold: price > threshold,
    Comparator.LT: lambda price, threshold: price < threshold,
}


@dataclass(frozen=True)
class PriceResolution:
    outcome: str          # "yes" | "no"
    observed_price: float
    threshold: float
    comparator: Comparator
    source: str = "lighter_mark_price"


def resolve_price_market(observed_price: float, threshold: float, comparator: Comparator) -> PriceResolution:
    """observed_price — РЕАЛЬНАЯ цена с Lighter (getCandles/getOrderBooks в
    src/lib/lighter.ts) на момент/после дедлайна рынка. Эта функция не делает
    сетевых вызовов сама — ей подают уже полученную реальную цену, чтобы её
    можно было тестировать без сети (см. test_predict_resolution.py)."""
    if observed_price < 0:
        raise ValueError("observed_price не может быть отрицательной")
    is_yes = _OPS[comparator](observed_price, threshold)
    return PriceResolution(
        outcome="yes" if is_yes else "no",
        observed_price=observed_price,
        threshold=threshold,
        comparator=comparator,
    )


@dataclass(frozen=True)
class EventResolution:
    outcome: str
    resolved_by: str    # идентификатор куратора — обязателен, не опционален
    resolved_at: float  # unix timestamp
    evidence_url: str   # ссылка на источник — обязательна, не опциональна
    disputed: bool = False


def resolve_event_market(outcome: str, resolved_by: str, resolved_at: float, evidence_url: str) -> EventResolution:
    """НЕ автоматическая, НЕ трастлесс. resolved_by и evidence_url обязательны
    намеренно — резолюция без указания, кто и на основании чего её вынес, не
    создаётся этой функцией вообще. Это минимум для аудита постфактум, не
    полноценный dispute-механизм."""
    if outcome not in ("yes", "no"):
        raise ValueError("outcome должен быть 'yes' или 'no'")
    if not resolved_by:
        raise ValueError("resolved_by обязателен — резолюция без куратора не создаётся")
    if not evidence_url:
        raise ValueError("evidence_url обязателен — резолюция без источника не создаётся")
    resolution = EventResolution(outcome=outcome, resolved_by=resolved_by, resolved_at=resolved_at, evidence_url=evidence_url)
    with al.connect(AUDIT_DB_PATH) as audit_conn:
        al.log_action(audit_conn, al.AuditEntry(
            actor=resolved_by,
            action="market_resolution",
            resource=f"event_market:{outcome}",
            details={"evidence_url": evidence_url, "resolved_at": resolved_at},
            success=True,
        ))
    return resolution
