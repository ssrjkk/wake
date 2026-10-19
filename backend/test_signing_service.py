"""
Проверка сервиса подписи.

Повод появиться: `/place-order` зовёт браузер напрямую, мимо основного бэкенда,
а ключ подписи лежит в этом процессе. Значит, «сухой ход» обязан решаться здесь:
иначе WAKE_DRY_RUN=false у бэкенда — или просто прямая кнопка в Терминале —
отправляли бы живой ордер в mainnet, пока весь остальной проект считает, что
ничего не отправляется.

Форму fake-клиента задаёт не фантазия, а вызов из place_order(): create_order
принимаёт именованные аргументы и возвращает (tx, tx_hash, err), клиент
закрывается в finally.
"""

import os
import unittest
from unittest import mock

import httpx

import signing_service

_ORDER = {
    "market_index": 1,
    "client_order_index": 777,
    "base_amount": 10_000_000,
    "price": 60_000_00000,
    "is_ask": False,
    "reduce_only": False,
}


class FakeSigner:
    ORDER_TYPE_MARKET = "market"
    ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL = "ioc"
    DEFAULT_IOC_EXPIRY = 1_800_000_000

    def __init__(self, tx_hash="0x" + "ab" * 32, err=None):
        self.calls = []
        self.closed = 0
        self._tx_hash = tx_hash
        self._err = err

    async def create_order(self, **kwargs):
        self.calls.append(kwargs)
        return {"market_index": kwargs["market_index"]}, self._tx_hash, self._err

    async def close(self):
        self.closed += 1


class TestSigningService(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Кэш идемпотентности — состояние модуля: без очистки индексы из одного
        # теста делали бы второй «повтором», и тест проверял бы мусор предыдущего.
        signing_service._idempotency_cache.clear()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=signing_service.app),
            base_url="http://signing.test",
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        signing_service._idempotency_cache.clear()

    async def _place(self, order=None):
        # `order or _ORDER` подменил бы пустой dict валидным телом — а пустое тело
        # как раз и проверяется, поэтому сравнение с None.
        return await self.client.post(
            "/place-order", json=_ORDER if order is None else order
        )

    async def test_dry_run_never_reaches_lighter(self):
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", True),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            r = await self._place()
        body = r.json()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(body["dry_run"])
        self.assertIsNone(body["tx_hash"])
        self.assertEqual(signer.calls, [])
        self.assertEqual(signer.closed, 0)

    async def test_dry_run_echoes_the_plan_that_would_be_sent(self):
        with (
            mock.patch.object(signing_service, "DRY_RUN", True),
            mock.patch.object(signing_service, "_get_client"),
        ):
            body = (await self._place()).json()
        self.assertEqual(body["order"], _ORDER)

    async def test_live_path_signs_and_returns_tx_hash(self):
        signer = FakeSigner(tx_hash="0xdeadbeef")
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            body = (await self._place()).json()
        self.assertFalse(body["dry_run"])
        self.assertEqual(body["tx_hash"], "0xdeadbeef")
        self.assertFalse(body["idempotent_replay"])
        call = signer.calls[0]
        self.assertEqual(call["market_index"], _ORDER["market_index"])
        self.assertEqual(call["base_amount"], _ORDER["base_amount"])
        self.assertEqual(call["price"], _ORDER["price"])
        self.assertEqual(call["order_type"], FakeSigner.ORDER_TYPE_MARKET)
        self.assertEqual(
            call["time_in_force"], FakeSigner.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
        )
        self.assertEqual(call["order_expiry"], FakeSigner.DEFAULT_IOC_EXPIRY)
        self.assertTrue(call["reduce_only"] is False)
        self.assertEqual(signer.closed, 1)

    async def test_same_client_order_index_is_not_sent_twice(self):
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            first = (await self._place()).json()
            second = (await self._place()).json()
        self.assertFalse(first["idempotent_replay"])
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(second["tx_hash"], first["tx_hash"])
        self.assertEqual(len(signer.calls), 1)

    async def test_lighter_rejection_is_reported_and_client_closed(self):
        signer = FakeSigner(err="market index out of range")
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            r = await self._place()
        self.assertEqual(r.status_code, 400)
        self.assertIn("Lighter отклонил ордер", r.json()["detail"])
        # Ключ утечки сокетов здесь нет: close() стоит в finally, и проверка это
        # фиксирует — без неё ошибка Lighter оставляла бы соединение живым.
        self.assertEqual(signer.closed, 1)

    async def test_missing_key_fails_as_bad_configuration_not_as_success(self):
        # Реальный _get_client, а не заглушка: отсутствие LIGHTER_ACCOUNT_INDEX /
        # LIGHTER_API_KEY_PRIVATE_KEY в окружении должно быть видно по ответу.
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.dict(os.environ, {}, clear=True),
        ):
            r = await self._place()
        self.assertEqual(r.status_code, 400)
        self.assertIn("Настройка сервиса неполная", r.json()["detail"])

    async def test_health_reports_the_mode_the_button_will_act_in(self):
        for value in (True, False):
            with mock.patch.object(signing_service, "DRY_RUN", value):
                body = (await self.client.get("/health")).json()
            self.assertEqual(body["dry_run"], value)
            self.assertEqual(body["network"], signing_service.LIGHTER_NETWORK)

    async def test_order_model_rejects_garbage(self):
        cases = [
            {"market_index": "abc"},
            {},
            {**_ORDER, "base_amount": -1},
            {**_ORDER, "price": 0},
            {**_ORDER, "market_index": -1},
            {**_ORDER, "client_order_index": -5},
        ]
        for broken in cases:
            with (
                mock.patch.object(signing_service, "DRY_RUN", True),
                mock.patch.object(signing_service, "_get_client"),
            ):
                r = await self._place(broken)
            self.assertEqual(r.status_code, 422, broken)


if __name__ == "__main__":
    unittest.main()
