"""
LMSR (Logarithmic Market Scoring Rule) — стандартный механизм ценообразования
бинарных рынков предсказаний, тот же класс механизма, что использовали Augur и
академические реализации prediction markets. Не изобретаю новую схему —
реализую хорошо понятную.

Численно стабильная форма (log-sum-exp trick). Наивная формула
exp(q_yes/b)/(exp(q_yes/b)+exp(q_no/b)) переполняется на реалистичных объёмах
торгов — здесь этого не происходит, проверено тестами на больших q.

Что это НЕ решает: откуда берётся правильный исход (YES или NO) — это
predict_resolution.py, две совершенно разные по доверию модели для
цен-на-Lighter (автоматически) и произвольных событий (вручную, курато­ром).
"""

import math


class LMSRMarket:
    def __init__(self, b: float, q_yes: float = 0.0, q_no: float = 0.0):
        if b <= 0:
            raise ValueError("b (параметр ликвидности) должен быть > 0")
        self.b = b
        self.q_yes = q_yes
        self.q_no = q_no

    def _cost(self, q_yes: float, q_no: float) -> float:
        m = max(q_yes, q_no) / self.b
        return self.b * (m + math.log(math.exp(q_yes / self.b - m) + math.exp(q_no / self.b - m)))

    def price_yes(self) -> float:
        """Логистическая форма — эквивалентна наивной, но не переполняется на больших q."""
        return 1 / (1 + math.exp((self.q_no - self.q_yes) / self.b))

    def price_no(self) -> float:
        return 1 - self.price_yes()

    def cost_to_trade(self, outcome: str, delta_shares: float) -> float:
        """Стоимость покупки (delta>0) или продажи (delta<0) shares данного исхода,
        БЕЗ изменения состояния рынка — чистая функция для предпросмотра цены в UI."""
        if outcome not in ("yes", "no"):
            raise ValueError("outcome должен быть 'yes' или 'no'")
        before = self._cost(self.q_yes, self.q_no)
        if outcome == "yes":
            after = self._cost(self.q_yes + delta_shares, self.q_no)
        else:
            after = self._cost(self.q_yes, self.q_no + delta_shares)
        return after - before

    def trade(self, outcome: str, delta_shares: float) -> float:
        """Реально исполняет сделку, меняя состояние рынка. Возвращает стоимость
        (положительная = ты платишь, отрицательная = тебе платят при продаже)."""
        cost = self.cost_to_trade(outcome, delta_shares)
        if outcome == "yes":
            self.q_yes += delta_shares
        else:
            self.q_no += delta_shares
        return cost

    def max_subsidy(self) -> float:
        """Максимальный субсидируемый убыток маркетмейкера при старте с q_yes=q_no=0 —
        b*ln(2). Ровно столько нужно иметь в резерве, создавая рынок с этим b."""
        return self.b * math.log(2)
