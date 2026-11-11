"""python3 -m unittest test_net -v

net.client_ip решает две вещи сразу: чей адрес попадает в аудит и в чьё ведро
rate limit. Ошибка здесь стоит не «неточной строчкой в логе», а тем, что весь
сервис делит одно ведро на всех, или что в аудите не разобраться, кто был.
"""

import unittest
from types import SimpleNamespace

import net


def request_for(peer: str, xff: str | None = None):
    headers = {} if xff is None else {"x-forwarded-for": xff}
    return SimpleNamespace(
        client=SimpleNamespace(host=peer),
        headers=headers,
    )


class TestClientIp(unittest.TestCase):
    def setUp(self):
        self.original = net.TRUSTED_PROXY_IPS
        self.addCleanup(setattr, net, "TRUSTED_PROXY_IPS", self.original)

    def test_untrusted_peer_wins_over_the_header(self):
        """Соединение не от прокси — значит X-Forwarded-For написал сам клиент.
        Доверять ему в этом случае — способ залогировать чужой адрес как свой."""
        net.TRUSTED_PROXY_IPS = ["10.0.0.1"]
        self.assertEqual(
            net.client_ip(request_for("203.0.113.7", "198.51.100.1")),
            "203.0.113.7",
        )

    def test_single_proxy_chain(self):
        net.TRUSTED_PROXY_IPS = ["10.0.0.1"]
        self.assertEqual(
            net.client_ip(request_for("10.0.0.1", "198.51.100.9")), "198.51.100.9"
        )

    def test_two_proxy_chain_takes_the_rightmost_untrusted(self):
        """Cloudflare → Railway → приложение. Правый элемент цепочки дописал
        Railway и равен адресу Cloudflare; брать его — значит получить один IP
        прокси на всю аудиторию. Пустой список доверенных не помогал: он вообще
        не читал заголовок."""
        net.TRUSTED_PROXY_IPS = ["10.0.0.1", "172.71.0.0"]
        req = request_for("10.0.0.1", "203.0.113.33, 172.71.0.0")
        self.assertEqual(net.client_ip(req), "203.0.113.33")

    def test_forged_left_side_is_ignored(self):
        net.TRUSTED_PROXY_IPS = ["10.0.0.1"]
        req = request_for("10.0.0.1", "1.2.3.4, 198.51.100.9")
        self.assertEqual(
            net.client_ip(req),
            "198.51.100.9",
            "левую часть цепочки клиент пишет сам — берём правый недоверенный",
        )

    def test_chain_of_only_trusted_falls_back_to_peer(self):
        net.TRUSTED_PROXY_IPS = ["10.0.0.1"]
        self.assertEqual(net.client_ip(request_for("10.0.0.1", "10.0.0.1")), "10.0.0.1")

    def test_no_header_and_no_peer_is_unknown(self):
        net.TRUSTED_PROXY_IPS = []
        self.assertEqual(net.client_ip(request_for("")), "unknown")
        self.assertEqual(net.client_ip(request_for("10.0.0.1")), "10.0.0.1")


class TestAddressesAreNotStrings(unittest.TestCase):
    """Один и тот же адрес прокси и клиент могут записать по-разному: dual-stack
    сокет отдаёт IPv4 как `::ffff:a.b.c.d`, Cloudflare в цепочке пишет IPv6 со
    скобками и портом, регистр и свёртка hex вольные. Сверка строк на этом не
    падает и не ругается — она просто перестаёт узнавать доверенный прокси, и
    сервис молча возвращается к исходному дефекту: один bucket и одна строчка
    в аудите на всех."""

    def setUp(self):
        self.original = net.TRUSTED_PROXY_IPS
        self.addCleanup(setattr, net, "TRUSTED_PROXY_IPS", self.original)
        net.TRUSTED_PROXY_IPS = ["10.0.0.1", "172.71.0.0"]

    def test_spelled_peer_is_still_the_trusted_proxy(self):
        """`::ffff:10.0.0.1` — это 10.0.0.1, а не «неизвестный сосед»: иначе
        заголовок не читался бы вовсе."""
        for peer in ["::ffff:10.0.0.1", "10.0.0.1", " 10.0.0.1 "]:
            with self.subTest(peer=peer):
                self.assertEqual(
                    net.client_ip(request_for(peer, "198.51.100.9")), "198.51.100.9"
                )

    def test_spelled_proxy_in_the_chain_is_skipped_not_returned(self):
        """Правый элемент — адрес Cloudflare, записанный в форме IPv6-в-IPv4.
        Строковое сравнение вернула бы его как «клиента», и весь сервис лежал
        бы в одном ведре."""
        for proxy in ["::ffff:172.71.0.0", "172.71.0.0"]:
            with self.subTest(proxy=proxy):
                req = request_for("10.0.0.1", f"203.0.113.33, {proxy}")
                self.assertEqual(net.client_ip(req), "203.0.113.33")

    def test_client_address_comes_back_canonical(self):
        """Возвращённое значение — ключ ведра rate limit (`app.py`) и поле `ip`
        в аудите: два написания одного адреса не должны давать два ведра."""
        cases = {
            "::ffff:198.51.100.9": "198.51.100.9",
            "[2001:DB8::1]:443": "2001:db8::1",
            "2001:db8:0:0:0:0:0:1": "2001:db8::1",
            "0:0:0:0:0:0:0:1": "::1",
            "198.51.100.9": "198.51.100.9",
        }
        for written, canonical in cases.items():
            with self.subTest(written=written):
                self.assertEqual(
                    net.client_ip(request_for("10.0.0.1", written)), canonical
                )
                self.assertEqual(net.canonical_ip(written), canonical)

    def test_not_an_address_is_left_alone(self):
        """Мусор или имя хоста в заголовке — не повод ни падать, ни молча
        подставлять на его место «unknown»: сравниваем то, что пришло."""
        self.assertEqual(net.canonical_ip("example.com"), "example.com")
        self.assertEqual(net.canonical_ip("256.1.1.1"), "256.1.1.1")
        self.assertEqual(
            net.client_ip(request_for("10.0.0.1", "example.com")), "example.com"
        )

    def test_is_not_the_string_compare_it_replaced(self):
        """Наивная версия — `value not in TRUSTED_PROXY_IPS` — краснеет ровно
        на этих строках, и краснеет тихо: она считает «другое написание» другим
        адресом."""

        def naive(peer, chain, trusted):
            if peer not in trusted:
                return peer
            for value in reversed([v.strip() for v in chain.split(",") if v.strip()]):
                if value not in trusted:
                    return value
            return peer

        self.assertEqual(
            naive("::ffff:10.0.0.1", "198.51.100.9", ["10.0.0.1"]), "::ffff:10.0.0.1"
        )
        self.assertEqual(
            net.client_ip(request_for("::ffff:10.0.0.1", "198.51.100.9")),
            "198.51.100.9",
            "строковое сравнение отдало бы адрес соединения вместо клиента",
        )
        self.assertEqual(
            naive(
                "10.0.0.1",
                "203.0.113.33, ::ffff:172.71.0.0",
                ["10.0.0.1", "172.71.0.0"],
            ),
            "::ffff:172.71.0.0",
        )
        self.assertEqual(
            net.client_ip(request_for("10.0.0.1", "203.0.113.33, ::ffff:172.71.0.0")),
            "203.0.113.33",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
