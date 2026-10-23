"""
Закрывает price-рынки Predict-модуля по наступлении resolve_at. Именно это
делает фразу «цены на Lighter резолвятся автоматически» правдой: без этого
процесса рынок остаётся открытым, пока кто-нибудь не дёрнет
POST /predict/markets/{id}/resolve-price вручную.

Механика нарочито простая: раз в тик выбираем открытые price-рынки с
resolve_at <= now, тянем mark-цену с Lighter, сравниваем с порогом через
протестированный resolve_price_market() и пишем исход. source =
"auto:lighter_mark_price" — в отличие от event-рынков, исход выносит не человек,
а внешний источник цены. Кураторского токена здесь нет по другой причине, чем
можно подумать: у этого процесса нет HTTP-поверхности, он запускается на
инфраструктуре оператора, и доверие переносится с заголовка запроса на того, кто
его запускает. Ручной эндпоинт POST /predict/markets/{id}/resolve-price,
наоборот, под токеном — потому что он берёт цену в момент вызова.

Что здесь осознанно НЕ сделано:
  - Нет спора о цене (dispute-периода). Lighter — единственный оракул; если его
    mark-цена на момент тика выглядит ошибочно, исход будет таким же.
  - Исход считается по последней 1m-свече на момент тика, а не по цене ровно на
    resolve_at. между дедлайном и закрытием рынка может пройти до TICK_SECONDS —
    задержка встроена в саму схему «cron + внешний оракул».
  - Нет резервирования выплат: claim_winnings() платит $1 за победивший share из
    пула, а ликвидность пула (b, max_subsidy) при создании рынка проверяет
    человек, поэтому баланс между «все проиграли» и «все выиграли» — задача
    оператора, не этого кода.

Запуск:
    python3 predict_resolver.py                # один проход (для cron)
    python3 predict_resolver.py --loop         # постоянный процесс

Схема берётся из alembic (alembic upgrade head) — процесс её не создаёт и не
меняет, только читает открытые рынки и пишет исход.
"""

import argparse
import asyncio
import logging
import time

import predict_db as pdb
import audit_log as al
from predict_resolution import resolve_price_market, Comparator
from config import LIGHTER_NETWORK, PREDICT_RESOLVER_TICK

logger = logging.getLogger("wake.predict_resolver")

TICK_SECONDS = PREDICT_RESOLVER_TICK


async def resolve_due_markets(
    now: float, price_fn, network: str = LIGHTER_NETWORK
) -> list[dict]:
    """Закрывает все просроченные открытые price-рынки. price_fn(market_id,
    network, resolve_at) возвращает mark-цену НА МОМЕНТ ДЕДЛАЙНА — инжектится,
    чтобы цикл можно было прогнать тестами без сети (test_predict_resolver.py).
    Рынок, по которому цена не получена, остаётся открытым и будет повторён на
    следующем тике: лучше просроченная резолюция, чем исход, угаданный вместо
    данных.

    resolve_at передаётся в price_fn нарочно. Пока цена бралась «какая сейчас»,
    пропуск резолвера на сутки превращал исход рынка «BTC выше 100k 1 октября»
    в цену 3 октября — то есть просрочка тика была не задержкой выплаты, а другим
    исходом по тем же деньгам. Цена, привязанная к дедлайну, одинакова и на тике
    позже дедлайна, и через неделю.

    Каждое закрытие идёт в аудит: исход вынесла машина по внешнему оракулу, и
    вопрос «почему рынок закрылся именно так» должен иметь ответ в таблице, а не
    в логах процесса, которые rotate'ятся."""
    closed = []
    for m in await pdb.list_markets("open"):
        if m["kind"] != "price" or m["resolve_at"] > now:
            continue
        try:
            observed = price_fn(m["lighter_market_id"], network, m["resolve_at"])
            resolution = resolve_price_market(
                observed, m["threshold"], Comparator(m["comparator"])
            )
        except (RuntimeError, ValueError) as e:
            logger.warning("рынок %s не закрыт: %s", m["id"], e)
            continue
        try:
            await pdb.resolve_market(
                m["id"], resolution.outcome, "auto:lighter_mark_price", None
            )
        except ValueError as e:
            # Кто-то закрыл рынок между list_markets и этим UPDATE (ручной триггер
            # куратора или предыдущий тик). Исход уже записан — перетирать его нельзя.
            logger.warning("рынок %s не закрыт: %s", m["id"], e)
            continue
        await al.log_action(
            al.AuditEntry(
                actor="auto:lighter_mark_price",
                action="market_resolution",
                resource=m["id"],
                details={
                    "outcome": resolution.outcome,
                    "observed_price": resolution.observed_price,
                    "threshold": resolution.threshold,
                    "comparator": resolution.comparator.value,
                    "resolve_at": m["resolve_at"],
                    "network": network,
                },
                success=True,
            )
        )
        logger.info(
            "закрыт %s: %s (цена %s на %s, порог %s %s)",
            m["id"],
            resolution.outcome,
            resolution.observed_price,
            int(m["resolve_at"]),
            resolution.comparator.value,
            m["threshold"],
        )
        closed.append(
            {
                "market_id": m["id"],
                "outcome": resolution.outcome,
                "observed_price": resolution.observed_price,
            }
        )
    return closed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--loop", action="store_true", help=f"работать постоянно, тик {TICK_SECONDS} с"
    )
    args = parser.parse_args()

    from lighter_rest import (
        get_price_at,
    )  # сетевой вызов — только когда реально доходим до дела

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    logger.info("Резолвер Predict: сеть=%s, тик=%ds", LIGHTER_NETWORK, TICK_SECONDS)

    while True:
        closed = asyncio.run(resolve_due_markets(time.time(), get_price_at))
        if closed:
            logger.info("закрыто рынков за тик: %d", len(closed))
        if not args.loop:
            break
        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    main()
