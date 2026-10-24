"""
Чистая логика: по официальной схеме account_all_positions/user_stats
(apidocs.lighter.xyz/docs/websocket-reference, подтверждено 2026-08-11) хранит
последнее известное состояние позиций и equity лидера и, при каждом новом
сообщении, вычисляет события изменения позиции сравнением с предыдущим снапшотом.

Никакого сетевого I/O — поэтому в отличие от самого WS-подключения это
протестировано по-настоящему (test_leader_position_tracker.py).

Единственное осознанное упрощение: avg_entry_price из снапшота — это СРЕДНЯЯ цена
входа по всей позиции, не цена именно последнего изменения. Для приращения это
разумное приближение цены исполнения; более точный вариант — отдельно слушать
account_all_trades и брать price оттуда, это следующий шаг, не сделанный здесь
осознанно, чтобы не множить непроверенные предположения в одном файле.
"""


class LeaderPositionTracker:
    def __init__(self):
        self.positions: dict = {}  # market_id -> {"size": float, "sign": int, "price": float}
        self.equity: float | None = None

    def apply_user_stats(self, msg: dict) -> None:
        """msg — полное сообщение канала user_stats (update/user_stats)."""
        self.equity = float(msg["stats"]["portfolio_value"])

    def apply_position_update(self, msg: dict) -> list:
        """msg — полное сообщение канала account_all_positions
        (update/account_all_positions или subscribed/account_all_positions).
        Возвращает список raw_event-словарей, готовых для handle_leader_event().

        Сообщению верят ровно в том объёме, в каком оно говорит: рынок, которого
        в снапшоте нет, считается закрытым, а не «ничего не изменилось». Без этой
        сверки листенер молчал бы вечно: у лидера позиция схлопнулась, ключа нет
        в messages["positions"], сравнить не с чем — подписчик остаётся в рынке,
        из которого лидер вышел, и закрыть его больше нечем. Проверено на
        фикстуре с пустым снапшотом: событий было ноль, состояние — «лонг 0.5».
        """
        events = []
        seen = set()
        for market_id_str, pos in msg.get("positions", {}).items():
            market_id = int(market_id_str)
            seen.add(market_id)
            new_size = abs(float(pos["position"]))
            new_sign = int(pos["sign"])
            price = float(pos["avg_entry_price"])

            prev = self.positions.get(market_id)
            prev_size = prev["size"] if prev else 0.0
            prev_sign = prev["sign"] if prev else new_sign
            effective_prev_size = prev_size

            if new_sign != prev_sign and prev_size > 0:
                # Разворот позиции: сначала полностью закрываем старую сторону.
                # Закрытие не использует leader_equity_usd в mirror_engine, поэтому
                # эмиттим его независимо от того, известен ли equity.
                events.append(
                    self._event(
                        market_id, prev_sign, False, prev_size, price, prev_size
                    )
                )
                effective_prev_size = 0.0

            if new_size > effective_prev_size:
                if self.equity is not None:
                    events.append(
                        self._event(
                            market_id,
                            new_sign,
                            True,
                            new_size - effective_prev_size,
                            price,
                            0,
                        )
                    )
                # else: приращение без известного equity — намеренно не эмиттим, чтобы
                # не считать risk fraction от неизвестного числа. Состояние всё равно
                # обновится ниже, следующее сообщение посчитает дельту от него верно.
            elif new_size < effective_prev_size:
                events.append(
                    self._event(
                        market_id,
                        prev_sign,
                        False,
                        effective_prev_size - new_size,
                        price,
                        effective_prev_size,
                    )
                )

            if new_size == 0:
                # Закрытая позиция из состояния уходит: дальше она должна
                # ведти себя как новая (первый снапшот с ней — открытие), а не
                # как «уменьшение от нуля».
                self.positions.pop(market_id, None)
            else:
                self.positions[market_id] = {
                    "size": new_size,
                    "sign": new_sign,
                    "price": price,
                }

        # Рынки, пропавшие из снапшота: эмитим полное закрытие по последней
        # известной цене и убираем их из состояния.
        for market_id in sorted(set(self.positions) - seen):
            stale = self.positions.pop(market_id)
            events.append(
                self._event(
                    market_id,
                    stale["sign"],
                    False,
                    stale["size"],
                    stale["price"],
                    stale["size"],
                )
            )
        return events

    def _event(
        self,
        market_id: int,
        sign: int,
        is_increase: bool,
        size_delta: float,
        price: float,
        position_before: float,
    ) -> dict:
        return {
            "market_id": market_id,
            "side": "long" if sign > 0 else "short",
            "is_increase": is_increase,
            "size_delta": size_delta,
            "price": price,
            "leader_equity_usd": self.equity if self.equity is not None else 0,
            "leader_position_before": position_before,
        }
