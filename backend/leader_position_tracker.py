"""
Чистая логика: по официальной схеме account_all_positions/user_stats
(apidocs.lighter.xyz/docs/websocket-reference, подтверждено 2026-08-11) хранит
последнее известное состояние позиций и equity лидера и, при каждом новом
сообщении, вычисляет события изменения позиции сравнением с предыдущим снапшотом.

Никакого сетевого I/O — поэтому в отличие от самого WS-подключения это
протестировано по-настоящему (test_leader_position_tracker.py).

Первое сообщение — БАЗА, а не сделка. Lighter присылает полный снапшот позиций
при подписке, и процесс, которому этот снапшот достался первым, не знает, когда
позиции появились: лидер мог держать их месяцами. Прежняя реализация считала
первый снапшот «открытием всего портфеля» и на каждом рестарте листенера
открывала подписчикам заново весь портфель лидера — то есть деплой или падение
процесса удваивало чужую позицию. Состояние поэтому персистится (listener
кладёт его в leader_tracker_state), а при первом запуске без сохранённого
состояния снапшот только запоминается.

Единственное осознанное упрощение: avg_entry_price из снапшота — это СРЕДНЯЯ цена
входа по всей позиции, не цена именно последнего изменения. Для приращения это
разумное приближение цены исполнения; более точный вариант — отдельно слушать
account_all_trades и брать price оттуда, это следующий шаг, не сделанный здесь
осознанно, чтобы не множить непроверенные предположения в одном файле.
"""

from quant import is_finite


class LeaderPositionTracker:
    def __init__(self):
        self.positions: dict = {}  # market_id -> {"size": float, "sign": int, "price": float}
        self.equity: float | None = None
        self.seeded = False

    def snapshot(self) -> dict:
        """Состояние для leader_tracker_state — JSON-совместимое.

        Ключи рынков становятся строками: JSON не знает int-ключей, и без
        явного str() json.dumps молча превратил бы их сам, а restore() читал бы
        форму, которую никто не описал. Явная форма — часть контракта."""
        return {
            "equity": self.equity,
            "positions": {
                str(market_id): dict(pos) for market_id, pos in self.positions.items()
            },
        }

    def restore(self, state: dict) -> None:
        """Восстановить состояние после рестарта процесса.

        Проверка здесь, а не «доверимся своей же записи»: строка в базе могла
        быть испорчена чем угодно (ручной UPDATE, баг прошлой версии), а
        неконечный size в состоянии отравил бы сравнения навсегда — `NaN > 0` и
        `NaN < 0.5` оба False, поэтому рынок замолчал бы бесшумно. Битое
        состояние — ValueError, и листенер начинает с чистого листа (первый
        снапшот станет базой), а не работает по мусору."""
        equity = state.get("equity")
        if equity is not None:
            equity = float(equity)
            if not is_finite(equity):
                raise ValueError(f"equity в состоянии не конечно: {equity!r}")

        raw_positions = state.get("positions") or {}
        if not isinstance(raw_positions, dict):
            raise ValueError("positions в состоянии — не объект")
        positions = {}
        for market_id_raw, pos in raw_positions.items():
            market_id = int(market_id_raw)
            size = float(pos["size"])
            sign = int(pos["sign"])
            price = float(pos["price"])
            if not is_finite(size) or size <= 0:
                raise ValueError(f"рынок {market_id}: размер {size!r} не положителен")
            if sign not in (-1, 1):
                raise ValueError(f"рынок {market_id}: сторона {sign!r} не ±1")
            if not is_finite(price) or price <= 0:
                raise ValueError(f"рынок {market_id}: цена {price!r} не положительна")
            positions[market_id] = {"size": size, "sign": sign, "price": price}

        self.equity = equity
        self.positions = positions
        self.seeded = True

    def apply_user_stats(self, msg: dict) -> None:
        """msg — полное сообщение канала user_stats (update/user_stats)."""
        equity = float(msg["stats"]["portfolio_value"])
        if not is_finite(equity):
            raise ValueError(f"portfolio_value={equity!r} — не конечное число")
        self.equity = equity

    def apply_position_update(self, msg: dict) -> list:
        """msg — полное сообщение канала account_all_positions
        (update/account_all_positions или subscribed/account_all_positions).
        Возвращает список raw_event-словарей, готовых для handle_leader_event().

        Первый снапшот без восстановленного состояния базу только запоминает и
        событий не даёт. Угадать, какие из этих позиций появились только что, а
        какие лидер держит с прошлого месяца, нельзя; единственная безопасная
        трактовка — «всё, что здесь есть, уже было». Иначе рестарт процесса
        (или обычный деплой) зеркалил бы весь портфель лидера заново поверх уже
        открытых позиций подписчиков.

        Сообщению верят ровно в том объёме, в каком оно говорит: рынок, которого
        в снапшоте нет, считается закрытым, а не «ничего не изменилось». Без этой
        сверки листенер молчал бы вечно: у лидера позиция схлопнулась, ключа нет
        в messages["positions"], сравнить не с чем — подписчик остаётся в рынке,
        из которого лидер вышел, и закрыть его больше нечем."""
        parsed = self._parse(msg)
        if not self.seeded:
            self.positions = parsed
            self.seeded = True
            return []

        events = []
        for market_id, new in parsed.items():
            new_size = new["size"]
            new_sign = new["sign"]
            price = new["price"]

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
                # вести себя как новая (первый снапшот с ней — открытие), а не
                # как «уменьшение от нуля».
                self.positions.pop(market_id, None)
            else:
                self.positions[market_id] = new

        # Рынки, пропавшие из снапшота: эмитим полное закрытие по последней
        # известной цене и убираем их из состояния.
        for market_id in sorted(set(self.positions) - set(parsed)):
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

    def _parse(self, msg: dict) -> dict:
        """Снапшот -> {market_id: {"size", "sign", "price"}} с проверкой.

        Мусор в любом поле — ValueError на весь снапшот: пропустить одну битую
        строку значит либо закрыть позицию, которой лидер не закрывал (если
        счесть её отсутствующей), либо оставить в состоянии NaN. Листенер на
        ValueError пропускает сообщение целиком и ждёт следующего — состояние
        остаётся прежним, события не выдумываются."""
        parsed = {}
        for market_id_str, pos in (msg.get("positions") or {}).items():
            market_id = int(market_id_str)
            size = abs(float(pos["position"]))
            sign = int(pos["sign"])
            price = float(pos["avg_entry_price"])
            if not is_finite(size):
                raise ValueError(f"рынок {market_id}: размер {size!r} не конечен")
            if size > 0:
                # Для схлопнутой строки sign и цена не значат ничего (её
                # единственная роль — закрыть прежнее состояние), а требовать их
                # валидности значило бы навсегда застрять на снапшоте с нулём.
                if sign not in (-1, 1):
                    raise ValueError(f"рынок {market_id}: сторона {sign!r} не ±1")
                if not is_finite(price) or price <= 0:
                    raise ValueError(f"рынок {market_id}: цена входа {price!r}")
            parsed[market_id] = {"size": size, "sign": sign, "price": price}
        return parsed

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
