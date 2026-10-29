"""python3 -m unittest test_cache -v

Тесты на ключ кэша, а не на то, что dict работает. Регрессия, из-за которой
это стало багом продукта: ключ был статичной строкой, поэтому
get_funding_rate(2) отдавал ставку market 1 в пределах TTL, а ответ тестнетовой
книги раздавался как mainnet-данные.
"""

import unittest

import cache


class TestCachedKey(unittest.TestCase):
    def setUp(self):
        cache.clear()
        self.calls = []

    def _fetch(self, result):
        def fn(market_id, network="mainnet"):
            self.calls.append((market_id, network))
            return result

        return cache.cached("fx", ttl=60)(fn)

    def test_same_args_hit_cache_once(self):
        fn = self._fetch({"rate": 0.01})
        self.assertEqual(fn(1), {"rate": 0.01})
        self.assertEqual(fn(1), {"rate": 0.01})
        self.assertEqual(self.calls, [(1, "mainnet")])

    def test_different_market_id_is_not_the_previous_markets_value(self):
        by_market = {1: {"rate": 0.01}, 2: {"rate": -0.03}}

        def fetch(market_id):
            self.calls.append(market_id)
            return by_market[market_id]

        fn = cache.cached("fx", ttl=60)(fetch)
        self.assertEqual(fn(1)["rate"], 0.01)
        self.assertEqual(
            fn(2)["rate"],
            -0.03,
            "под market_id 2 вернулась ставка market 1 — общий ключ",
        )

    def test_network_is_part_of_the_key(self):
        fn = self._fetch("mainnet-значение")
        fn(1, "mainnet")
        fn(1, "testnet")
        self.assertEqual(self.calls, [(1, "mainnet"), (1, "testnet")])

    def test_positional_and_keyword_calls_share_a_key(self):
        fn = self._fetch("x")
        fn(7, "testnet")
        fn(market_id=7, network="testnet")
        self.assertEqual(self.calls, [(7, "testnet")])

    def test_expired_entry_is_refetched(self):
        def tick():
            self.calls.append(1)
            return len(self.calls)

        fn = cache.cached("fx", ttl=0)(tick)
        self.assertEqual(fn(), 1)
        self.assertEqual(
            fn(), 2, "ttl=0 — запись сразу протухла, каждый вызов реальный"
        )


class TestCacheIsBounded(unittest.TestCase):
    """Кэш не должен расти на каждый встреченный ключ.

    Пространство ключей здесь открытое: market_id, индекс аккаунта Lighter, сеть.
    Истёкшую запись выкидывало только чтение ЭТОЙ ЖЕ строки, поэтому перебор
    индексов (бот, лидеры, будущий кэш по аккаунтам) добавлял по строке и никогда
    их не убирал — медленный рост в процессе, который держит запросы к базе."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def test_expired_entries_leave_on_write(self):
        cache.set("a", 1, ttl=0)
        cache.set("b", 2, ttl=60)
        self.assertIsNone(cache.get("a"), "ttl=0 — запись протухла сразу")
        # Протухшая «a» обязана исчезнуть из словаря при следующей записи, а не
        # висеть в нём до того момента, пока её снова спросят.
        cache.set("c", 3, ttl=60)
        self.assertNotIn("a", cache._cache)

    def test_size_never_passes_the_cap_and_the_newest_survive(self):
        for i in range(cache.MAX_ENTRIES + 500):
            cache.set(f"k{i}", i, ttl=60)
        self.assertLessEqual(
            len(cache._cache),
            cache.MAX_ENTRIES,
            "словарь растёт на каждый встреченный ключ — протухшее выкидывало "
            "только чтение этой же строки",
        )
        self.assertEqual(
            cache.get(f"k{cache.MAX_ENTRIES + 499}"),
            cache.MAX_ENTRIES + 499,
            "вытесняются старые, а не последние: иначе кэш промахивается по "
            "горячим ключам",
        )

    def test_eviction_keeps_fresh_data_not_the_whole_oldest_half(self):
        """Вытесняются старые, а не половина списка наугад: живые записи должны
        остаться, иначе кэш начинает промахиваться по горячим ключам."""
        for i in range(cache.MAX_ENTRIES):
            cache.set(f"fresh{i}", i, ttl=60)
        self.assertEqual(len(cache._cache), cache.MAX_ENTRIES)
        cache.set("one-more", 1, ttl=60)
        self.assertEqual(len(cache._cache), cache.MAX_ENTRIES)
        self.assertEqual(cache.get("fresh1"), 1, "самые старые ушли, следующие живы")


if __name__ == "__main__":
    unittest.main(verbosity=2)
