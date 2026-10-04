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
    python3 predict_resolver.py --loop        # постоянный процесс
"""

import argparse
import logging
import os
import time

import predict_db as pdb
from predict_resolution import resolve_price_market, Comparator
from config import DB_PATH, LIGHTER_NETWORK

logger = logging.getLogger("wake.predict_resolver")

TICK_SECONDS = int(os.environ.get("WAKE_PREDICT_RESOLVER_TICK", "300"))


def resolve_due_markets(
    conn, now: float, price_fn, network: str = LIGHTER_NETWORK
) -> list[dict]:
    """Закрывает все просроченные открытые price-рынки. price_fn(market_id, network)
    возвращает mark-цену — инжектится, чтобы цикл можно было прогнать тестами без
    сети (test_predict_resolver.py). Рынок, по которому цена не получена, остаётся
    открытым и будет повторён на следующем тике: лучше просроченная резолюция,
    чем исход, угаданный вместо данных."""
    closed = []
    for m in pdb.list_markets(conn, "open"):
        if m["kind"] != "price" or m["resolve_at"] > now:
            continue
        try:
            observed = price_fn(m["lighter_market_id"], network)
            resolution = resolve_price_market(
                observed, m["threshold"], Comparator(m["comparator"])
            )
        except (RuntimeError, ValueError) as e:
            logger.warning("рынок %s не закрыт: %s", m["id"], e)
            continue
        try:
            pdb.resolve_market(
                conn, m["id"], resolution.outcome, "auto:lighter_mark_price", None
            )
        except ValueError as e:
            # Кто-то закрыл рынок между list_markets и этим UPDATE (ручной триггер
            # куратора или предыдущий тик). Исход уже записан — перетирать его нельзя.
            logger.warning("рынок %s не закрыт: %s", m["id"], e)
            continue
        logger.info(
            "закрыт %s: %s (цена %s, порог %s %s)",
            m["id"],
            resolution.outcome,
            resolution.observed_price,
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
        get_mark_price,
    )  # сетевой вызов — только когда реально доходим до дела

    pdb.init_predict_db(DB_PATH)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    logger.info("Резолвер Predict: сеть=%s, база=%s", LIGHTER_NETWORK, DB_PATH)

    while True:
        with pdb.connect(DB_PATH) as conn:
            closed = resolve_due_markets(conn, time.time(), get_mark_price)
        if closed:
            logger.info("закрыто рынков за тик: %d", len(closed))
        if not args.loop:
            break
        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    main()
