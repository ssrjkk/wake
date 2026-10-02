"""python3 test_predict_db.py — прямой запуск с ассертами, тот же стиль, что test_db.py"""

import os
import tempfile
import time
import uuid
import predict_db as pdb

# tempfile вместо /tmp: на Windows фикстура с абсолютным unix-путём не создаётся,
# и тест падал бы на open() ещё до первой проверки.
TEST_DB = os.path.join(tempfile.mkdtemp(prefix="wake-predict-"), "predict.db")

pdb.init_predict_db(TEST_DB)

# --- создание рынков ---
with pdb.connect(TEST_DB) as conn:
    pdb.create_market(conn, "m-price", "price", "BTC выше $120k к пятнице?",
                       resolve_at=time.time() + 86400, b=100,
                       lighter_market_id=0, threshold=120_000, comparator=">=")
    pdb.create_market(conn, "m-event", "event", "Победит ли команда А?",
                       resolve_at=time.time() + 86400, b=50)

    try:
        pdb.create_market(conn, "m-bad", "price", "без threshold", resolve_at=time.time(), b=10)
        raise AssertionError("должно было упасть без threshold/comparator для price-рынка")
    except ValueError:
        print("validation: price-рынок без threshold корректно отклонён — OK")

with pdb.connect(TEST_DB) as conn:
    markets = pdb.list_open_markets(conn)
    assert len(markets) == 2
    print(f"list_open_markets: {len(markets)} рынков — OK")

# --- сделки ---
with pdb.connect(TEST_DB) as conn:
    cost1 = pdb.record_trade(conn, str(uuid.uuid4()), "user-alice", "m-price", "yes", 10)
    print(f"alice покупает 10 yes: cost=${cost1:.2f}")
    assert cost1 > 0, "покупка должна стоить положительную сумму"

with pdb.connect(TEST_DB) as conn:
    m = pdb.get_market(conn, "m-price")
    assert m["q_yes"] == 10.0, f"q_yes должен обновиться, получили {m['q_yes']}"
    print(f"q_yes после покупки: {m['q_yes']} — OK")

# --- повторная покупка того же исхода добавляется к позиции, не дублирует ---
with pdb.connect(TEST_DB) as conn:
    pdb.record_trade(conn, str(uuid.uuid4()), "user-alice", "m-price", "yes", 5)

with pdb.connect(TEST_DB) as conn:
    pos = pdb.get_position(conn, "user-alice", "m-price", "yes")
    assert pos["shares"] == 15.0, f"позиция должна суммироваться (10+5=15), получили {pos['shares']}"
    print(f"позиция alice после второй покупки: {pos['shares']} shares — OK (не дублировалась)")

# --- продажа уменьшает позицию, возвращает деньги (отрицательный cost) ---
with pdb.connect(TEST_DB) as conn:
    cost_sell = pdb.record_trade(conn, str(uuid.uuid4()), "user-alice", "m-price", "yes", -5)
    print(f"alice продаёт 5 yes: cost=${cost_sell:.2f} (должно быть отрицательным)")
    assert cost_sell < 0, "продажа должна возвращать деньги — отрицательный cost"

with pdb.connect(TEST_DB) as conn:
    pos = pdb.get_position(conn, "user-alice", "m-price", "yes")
    assert pos["shares"] == 10.0, f"после продажи 5 из 15 должно остаться 10, получили {pos['shares']}"
    print(f"позиция после продажи: {pos['shares']} — OK")

# --- нельзя продать больше, чем есть ---
with pdb.connect(TEST_DB) as conn:
    try:
        pdb.record_trade(conn, str(uuid.uuid4()), "user-alice", "m-price", "yes", -1000)
        raise AssertionError("должно было упасть — продажа больше, чем есть в позиции")
    except ValueError as e:
        print(f"overselling корректно отклонён: {e}")

# --- нельзя продать без позиции вообще ---
with pdb.connect(TEST_DB) as conn:
    try:
        pdb.record_trade(conn, str(uuid.uuid4()), "user-bob", "m-price", "no", -1)
        raise AssertionError("должно было упасть — продажа без позиции")
    except ValueError as e:
        print(f"продажа без позиции корректно отклонена: {e}")

# --- два разных пользователя торгуют один рынок независимо ---
with pdb.connect(TEST_DB) as conn:
    pdb.record_trade(conn, str(uuid.uuid4()), "user-bob", "m-price", "no", 20)

with pdb.connect(TEST_DB) as conn:
    alice_pos = pdb.get_position(conn, "user-alice", "m-price", "yes")
    bob_pos = pdb.get_position(conn, "user-bob", "m-price", "no")
    assert alice_pos["shares"] == 10.0
    assert bob_pos["shares"] == 20.0
    print(f"независимые позиции: alice={alice_pos['shares']} bob={bob_pos['shares']} — OK")

# --- торговля на резолвленном рынке запрещена ---
with pdb.connect(TEST_DB) as conn:
    pdb.resolve_market(conn, "m-price", "yes", resolved_by=None, evidence_url=None)

with pdb.connect(TEST_DB) as conn:
    try:
        pdb.record_trade(conn, str(uuid.uuid4()), "user-carol", "m-price", "yes", 1)
        raise AssertionError("должно было упасть — торговля на резолвленном рынке")
    except ValueError as e:
        print(f"торговля на резолвленном рынке корректно отклонена: {e}")

# --- claim_winnings: победитель получает shares*$1, проигравший — $0 ---
with pdb.connect(TEST_DB) as conn:
    alice_payout = pdb.claim_winnings(conn, "user-alice", "m-price")  # alice была на yes, рынок resolved yes
    bob_payout = pdb.claim_winnings(conn, "user-bob", "m-price")       # bob был на no, проиграл
    print(f"alice (yes, победила) payout=${alice_payout:.2f}, bob (no, проиграл) payout=${bob_payout:.2f}")
    assert alice_payout == 10.0, f"alice должна получить 10 shares * $1 = $10, получили {alice_payout}"
    assert bob_payout == 0.0, f"bob проиграл, payout должен быть 0, получили {bob_payout}"

# --- нельзя забрать дважды ---
with pdb.connect(TEST_DB) as conn:
    second_claim = pdb.claim_winnings(conn, "user-alice", "m-price")
    assert second_claim == 0.0, "повторный claim должен вернуть 0, не повторную выплату"
    print(f"повторный claim: ${second_claim:.2f} — OK (защита от двойной выплаты сработала)")

# --- claim на нерезолвленном рынке запрещён ---
with pdb.connect(TEST_DB) as conn:
    try:
        pdb.claim_winnings(conn, "user-alice", "m-event")
        raise AssertionError("должно было упасть — claim на открытом рынке")
    except ValueError as e:
        print(f"claim на нерезолвленном рынке корректно отклонён: {e}")

os.remove(TEST_DB)
print()
print("ВСЁ ПРОШЛО: predict_db.py — создание, торговля, независимые позиции,")
print("overselling защита, запрет торговли после резолюции, честная выплата,")
print("защита от двойного claim — все реально проверены.")
