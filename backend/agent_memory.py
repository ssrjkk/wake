"""
Память AI-агента. Не "чёрный ящик, поверь мне, что умный" — набор чистых,
тестируемых функций над историей сделок: что было куплено/продано, по какой
цене, с каким исходом, и что "думал" агент в момент входа (context_note —
свободный текст, полезен и человеку, и как контекст для LLM-рассуждения).

Разделение осознанное: эта память и статистика по ней тестируются полностью
(test_agent_memory.py). Само "рассуждение" (llm_agent.py) требует реального
вызова LLM API — не тестируется в этой песочнице (нет сети), поэтому это два
разных файла с явно разным уровнем доверия, тот же принцип, что предсказание
цены (автоматическое) против предсказания событий (ручное) в predict_resolution.py.
"""

import time
from dataclasses import dataclass


@dataclass
class TradeRecord:
    id: str
    market_id: int
    side: str  # "long" | "short"
    entry_price: float
    size: float
    opened_at: float
    context_note: str = ""  # что "думал" агент при входе — для будущего LLM-контекста
    exit_price: float | None = None
    closed_at: float | None = None

    @property
    def is_open(self) -> bool:
        return self.exit_price is None

    @property
    def pnl_usd(self) -> float | None:
        if self.exit_price is None:
            return None
        direction = 1 if self.side == "long" else -1
        return direction * (self.exit_price - self.entry_price) * self.size


class AgentMemoryStore:
    def __init__(self):
        self.trades: list[TradeRecord] = []

    def record_open(
        self,
        id_: str,
        market_id: int,
        side: str,
        entry_price: float,
        size: float,
        context_note: str = "",
    ) -> TradeRecord:
        if side not in ("long", "short"):
            raise ValueError("side должен быть 'long' или 'short'")
        t = TradeRecord(
            id=id_,
            market_id=market_id,
            side=side,
            entry_price=entry_price,
            size=size,
            opened_at=time.time(),
            context_note=context_note,
        )
        self.trades.append(t)
        return t

    def record_close(self, trade_id: str, exit_price: float) -> TradeRecord:
        t = next((t for t in self.trades if t.id == trade_id), None)
        if t is None:
            raise ValueError(f"сделка {trade_id} не найдена")
        if not t.is_open:
            raise ValueError(f"сделка {trade_id} уже закрыта")
        t.exit_price = exit_price
        t.closed_at = time.time()
        return t

    def closed_trades(self, market_id: int | None = None) -> list:
        return [
            t
            for t in self.trades
            if not t.is_open and (market_id is None or t.market_id == market_id)
        ]

    def open_trades(self, market_id: int | None = None) -> list:
        return [
            t
            for t in self.trades
            if t.is_open and (market_id is None or t.market_id == market_id)
        ]

    def win_rate(self, market_id: int | None = None) -> float | None:
        closed = self.closed_trades(market_id)
        if not closed:
            return None
        wins = sum(1 for t in closed if (t.pnl_usd or 0) > 0)
        return wins / len(closed)

    def avg_pnl(self, market_id: int | None = None) -> float | None:
        closed = self.closed_trades(market_id)
        if not closed:
            return None
        return sum(t.pnl_usd for t in closed) / len(closed)

    def recent_trades(self, n: int = 10) -> list:
        return sorted(self.trades, key=lambda t: t.opened_at, reverse=True)[:n]

    def summarize_for_reasoning(self, market_id: int | None = None, n: int = 5) -> str:
        """Человеко-читаемая сводка — то, что реально пойдёт в промпт LLM в
        llm_agent.py. Чистая строковая функция, поэтому тестируется без сети."""
        closed = self.closed_trades(market_id)
        wr = self.win_rate(market_id)
        avg = self.avg_pnl(market_id)
        lines = []
        if wr is not None:
            lines.append(
                f"Винрейт за {len(closed)} закрытых сделок: {wr * 100:.0f}%, средний PnL ${avg:.2f}"
            )
        else:
            lines.append("Закрытых сделок ещё нет — истории для статистики нет.")
        recent = self.recent_trades(n)
        if recent:
            lines.append("Последние сделки:")
            for t in recent:
                status = (
                    f"закрыта, PnL ${t.pnl_usd:.2f}" if not t.is_open else "открыта"
                )
                lines.append(
                    f"  {t.side} market={t.market_id} @ {t.entry_price} ({status}) — {t.context_note or 'без заметки'}"
                )
        return "\n".join(lines)
