"""Сажает те же демо-трейдеры, что в UI (TRADERS в App.tsx), в реальную базу как
leaders — без этого createFollow() будет падать по внешнему ключу, потому что
"t3" из фронтенда не существует как реальная строка leaders. python3 seed_demo_leaders.py"""

import db

DEMO_LEADERS = [
    ("t1", 101, "@northstar", 8),
    ("t2", 102, "@vega.eth", 6),
    ("t3", 103, "@driftking", 10),
    ("t4", 104, "@cassian_fx", 5),
]

if __name__ == "__main__":
    db.init_db("wake.db")
    with db.connect("wake.db") as conn:
        for id_, account_index, handle, fee_bps in DEMO_LEADERS:
            db.upsert_leader(conn, id_, account_index, handle, fee_bps)
    print(f"Посажено {len(DEMO_LEADERS)} демо-лидеров в wake.db")
