"""Полный жизненный цикл price-рынка через все три модуля разом:
создание -> торговля двух юзеров -> резолюция реальной ценой -> честная выплата.
python3 test_predict_integration.py"""

import os
import tempfile
import time
import uuid
import predict_db as pdb
from predict_resolution import resolve_price_market, Comparator

# tempfile вместо зашитого /tmp — на Windows такой путь не создаётся.
TEST_DB = os.path.join(tempfile.mkdtemp(prefix="wake-predict-int-"), "predict.db")
pdb.init_predict_db(TEST_DB)

with pdb.connect(TEST_DB) as conn:
    pdb.create_market(conn, "m1", "price", "ETH выше $4000 к дедлайну?",
                       resolve_at=time.time() + 3600, b=200,
                       lighter_market_id=1, threshold=4000, comparator=">=")

# Двое торгуют до дедлайна — цена рынка (не Lighter, а вероятность YES) должна
# сдвигаться в сторону мнения большинства покупок.
with pdb.connect(TEST_DB) as conn:
    pdb.record_trade(conn, str(uuid.uuid4()), "alice", "m1", "yes", 50)   # верит в YES
    pdb.record_trade(conn, str(uuid.uuid4()), "bob", "m1", "yes", 30)     # тоже YES
    pdb.record_trade(conn, str(uuid.uuid4()), "carol", "m1", "no", 10)    # не верит

with pdb.connect(TEST_DB) as conn:
    m = pdb.get_market(conn, "m1")
    from predict_amm import LMSRMarket
    amm = LMSRMarket(b=m["b"], q_yes=m["q_yes"], q_no=m["q_no"])
    p_yes = amm.price_yes()
    print(f"после торгов: q_yes={m['q_yes']} q_no={m['q_no']} implied P(yes)={p_yes:.3f}")
    assert p_yes > 0.5, "при таком перекосе покупок YES implied-вероятность должна быть > 50%"

# Дедлайн наступил. РЕАЛЬНАЯ (в проде — с getCandles) цена ETH пришла: $4150.
# Не Lighter API, а сам факт "вот что вернул бы реальный источник" — это единственная
# точка, где реальный код (src/lib/lighter.ts) подключается к этому тесту.
observed_eth_price = 4150.0
resolution = resolve_price_market(observed_eth_price, threshold=4000, comparator=Comparator.GTE)
print(f"resolve_price_market(observed={observed_eth_price}, threshold=4000, >=) -> {resolution.outcome}")
assert resolution.outcome == "yes"

with pdb.connect(TEST_DB) as conn:
    pdb.resolve_market(conn, "m1", resolution.outcome, resolved_by="auto:lighter_mark_price", evidence_url=None)

# Выплаты: alice и bob были на yes (победили), carol на no (проиграла).
with pdb.connect(TEST_DB) as conn:
    alice_payout = pdb.claim_winnings(conn, "alice", "m1")
    bob_payout = pdb.claim_winnings(conn, "bob", "m1")
    carol_payout = pdb.claim_winnings(conn, "carol", "m1")

    print(f"выплаты: alice=${alice_payout} bob=${bob_payout} carol=${carol_payout}")
    assert alice_payout == 50.0, "alice держала 50 yes-shares, рынок resolved yes -> $50"
    assert bob_payout == 30.0
    assert carol_payout == 0.0, "carol держала no-shares, рынок resolved yes -> $0"

os.remove(TEST_DB)
print()
print("ПОЛНЫЙ ЦИКЛ ПОДТВЕРЖДЁН: LMSR-ценообразование, база и резолюция")
print("реальной ценой работают вместе корректно от создания рынка до выплаты.")
