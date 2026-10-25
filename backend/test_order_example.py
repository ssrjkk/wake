"""Эталонный скрипт ордера: place_order_example.py.

Проверяется не математика (её закрыли test_mirror_engine и test_lighter_rest), а
границы, за которые скрипт отвечает один: какой сетевой режим считается
разрешённым и что происходит с мусором в переменных окружения.

python3 -m unittest test_order_example -v

Проверки живут на уровне импорта модуля (так и задумано: окружение читается
один раз, и неверное значение должно быть видно до первого запроса к бирже),
поэтому каждый тест гоняет отдельный subprocess с своим окружением — импортом в
общий процесс проверить нельзя, а прочитанные константы одного теста просочились
бы в другой. Сеть не трогается ни в одной ветке: отказ от
LIGHTER_API_KEY_PRIVATE_KEY стоит первым внутри main(), до запроса книги.
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Всё, чем тест управляет явно. Значение по умолчанию из shell сделало бы тест
# зависимым от машины, на котором он запущен (в .env прода, например, mainnet).
CONTROLLED = (
    "WAKE_LIGHTER_NETWORK",
    "WAKE_MAINNET_LIVE",
    "WAKE_DRY_RUN",
    "WAKE_ORDER_SYMBOL",
    "WAKE_ORDER_SIZE_USD",
    "WAKE_ORDER_SIDE",
    "LIGHTER_ACCOUNT_INDEX",
    "LIGHTER_API_KEY_INDEX",
    "LIGHTER_API_KEY_PRIVATE_KEY",
)


def _env(**overrides) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in CONTROLLED}
    # dry_run=true — не настройка скрипта (он её не читает), а тихий фикстур:
    # config.py при импорте проверяет пару «mainnet без сухого прогона», и на
    # машине, где в .env или в shell стоит WAKE_DRY_RUN=false, тест ловил бы
    # отказ конфигурации вместо того, что проверяет.
    env["WAKE_DRY_RUN"] = "true"
    for key, value in overrides.items():
        if value is not None:
            env[key] = value
    return env


def run_script(**overrides) -> subprocess.CompletedProcess:
    """Только импорт модуля: все проверки конфигурации скрипт делает на этом шаге."""
    return subprocess.run(
        [sys.executable, "-c", "import place_order_example as m; print(m.NETWORK)"],
        cwd=HERE,
        env=_env(**overrides),
        capture_output=True,
        text=True,
        timeout=120,
    )


def run_order(**overrides) -> subprocess.CompletedProcess:
    """Запуск скрипта целиком: доходит до проверки приватного ключа и останавливается."""
    return subprocess.run(
        [sys.executable, "place_order_example.py"],
        cwd=HERE,
        env=_env(**overrides),
        capture_output=True,
        text=True,
        timeout=120,
    )


class TestNetworkGate(unittest.TestCase):
    def test_default_is_testnet_and_needs_no_confirmation(self):
        """Дефолт — тестнет, и подтверждение там не требуется: на тестнете терять
        нечего, а лишняя переменная приучила бы ставить её не глядя."""
        r = run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("testnet", r.stdout)

    def test_mainnet_alone_is_not_enough(self):
        """Скрипт выставляет настоящий ордер, а WAKE_LIGHTER_NETWORK=mainnet — это
        и дефолт config.py, и значение в .env прода. Один этот флаг раньше означал
        живой ордер без всякого подтверждения; за продукт в том же случае
        отвечает вторая переменная, и эталонный путь обязан требовать её же."""
        r = run_script(WAKE_LIGHTER_NETWORK="mainnet")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("WAKE_MAINNET_LIVE", r.stderr)

    def test_mainnet_with_second_switch_passes_the_gate(self):
        r = run_script(WAKE_LIGHTER_NETWORK="mainnet", WAKE_MAINNET_LIVE="true")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("mainnet", r.stdout)

    def test_unknown_network_is_refused_before_anything_else(self):
        """Владелец этой проверки — config.py: он валидирует WAKE_LIGHTER_NETWORK
        на импорте lighter_rest, то есть раньше, чем скрипт успевает построить URL
        и обратиться к книге. Держать второй список сетей в скрипте означало бы
        иметь две границы, одна из которых недостижима."""
        r = run_script(WAKE_LIGHTER_NETWORK="staging")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("staging", r.stderr)
        self.assertIn("testnet", r.stderr, "отказ обязан называть доступные сети")


class TestEnvironmentGarbage(unittest.TestCase):
    def test_size_must_be_a_finite_positive_number(self):
        for raw in ("abc", "nan", "inf", "0", "-100"):
            with self.subTest(size=raw):
                r = run_script(WAKE_ORDER_SIZE_USD=raw)
                self.assertNotEqual(r.returncode, 0, f"size={raw!r} пропущен")
                self.assertNotIn(
                    "Traceback",
                    r.stderr,
                    "опечатка в окружении обязана объясняться, а не падать трейсбеком",
                )

    def test_side_is_a_closed_choice(self):
        """`SIDE == "sell"` превращал ЛЮБУЮ другую строку в buy: "SELL", "sll",
        "sell " — не отказ, а противоположная позиция тем же размером. Список
        разрешённых значений закрывает и регистр, и пробелы."""
        for raw in ("SELL", "sell", "Sell", "  buy  ", "BUY"):
            with self.subTest(side=raw):
                r = run_script(WAKE_ORDER_SIDE=raw)
                self.assertEqual(r.returncode, 0, r.stderr)
        for raw in ("SELLL", "short", "", "1"):
            with self.subTest(side=raw):
                r = run_script(WAKE_ORDER_SIDE=raw)
                self.assertNotEqual(r.returncode, 0, f"side={raw!r} пропущен")
                self.assertIn("WAKE_ORDER_SIDE", r.stderr)

    def test_indexes_must_be_whole_and_non_negative(self):
        for raw in ("abc", "1.5", "-1"):
            with self.subTest(index=raw):
                r = run_script(LIGHTER_ACCOUNT_INDEX=raw)
                self.assertNotEqual(r.returncode, 0, f"index={raw!r} пропущен")
                self.assertNotIn("Traceback", r.stderr)

    def test_missing_private_key_stops_before_any_request(self):
        r = run_order()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("LIGHTER_API_KEY_PRIVATE_KEY", r.stderr + r.stdout)


class TestOrderIdentity(unittest.TestCase):
    def test_index_does_not_come_from_the_clock(self):
        """Два ордера в одну секунду делили бы client_order_index, а
        signing_service на таком ключе идемпотентен: второй запрос вернул бы
        первый tx_hash, ничего не отправив. Эталон обязан показывать вывод из
        uuid — как в боевом пути (leader_listener.build_order_args)."""
        source = (HERE / "place_order_example.py").read_text(encoding="utf-8")
        self.assertNotIn("client_order_index=int(time.time())", source)
        self.assertIn("uuid.uuid4().int", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
