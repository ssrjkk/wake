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


if __name__ == "__main__":
    unittest.main(verbosity=2)
