"""
Хранилище ключей подписчиков: файл, в котором лежат API-ключи, чьими ордерами
работает копи-движок.

python3 -m unittest test_key_store -v

Три свойства, которые раньше не держались:

  - конструктор не создаёт файл: опечатка в WAKE_KEYSTORE_PATH не должна
    порождать пустое хранилище рядом с настоящим;
  - запись атомарна: умереть между truncate и записью — значит потерять ключи
    всех подписчиков разом;
  - недоступное хранилище не роняет листенер: leader_listener читает исключение
    как обрыв вебсокета, а это отказ по конфигу процесса, а не по данным
    подписчика.

Сеть и база не нужны: файл в TemporaryDirectory, а у листенера проверяется только
хелпер.
"""

import os
import stat
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from cryptography.fernet import Fernet

from encrypted_key_store import EncryptedKeyStore, generate_master_key
import leader_listener


class KeyStoreCase(unittest.TestCase):
    def setUp(self):
        self.dir = TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "keystore.enc")
        self.key = generate_master_key()

    def store(self, master_key: str | None = None) -> EncryptedKeyStore:
        return EncryptedKeyStore(self.path, master_key or self.key)


class TestConstructionAndRoundTrip(KeyStoreCase):
    def test_constructor_does_not_create_the_file(self):
        self.store()
        self.assertFalse(
            os.path.exists(self.path),
            "пустой файл по неверному пути — это потерянное настоящее хранилище",
        )

    def test_missing_file_reads_as_empty_store(self):
        store = self.store()
        self.assertIsNone(store.get_key("f1"))
        self.assertEqual(store.follower_ids(), [])

    def test_set_get_remove_roundtrip(self):
        store = self.store()
        store.set_key("f1", 3, "0xprivateone")
        store.set_key("f2", 0, "0xprivatetwo")
        self.assertEqual(
            store.get_key("f1"), {"api_key_index": 3, "private_key": "0xprivateone"}
        )
        self.assertEqual(sorted(store.follower_ids()), ["f1", "f2"])
        self.assertTrue(store.remove_key("f1"))
        self.assertFalse(store.remove_key("f1"))
        self.assertEqual(store.follower_ids(), ["f2"])

    def test_file_on_disk_does_not_contain_the_key(self):
        store = self.store()
        store.set_key("f1", 3, "0xsupersecret")
        with open(self.path, "rb") as f:
            blob = f.read()
        self.assertNotIn(b"0xsupersecret", blob)
        self.assertTrue(blob.startswith(b"gAAAAA"), "форма токена Fernet")

    @unittest.skipIf(
        os.name != "posix", "права на файл проверяются там, где они работают"
    )
    def test_file_is_owner_readable_only(self):
        self.store().set_key("f1", 3, "0xsecret")
        mode = stat.S_IMODE(os.stat(self.path).st_mode)
        self.assertEqual(
            mode & 0o077, 0, "группа и остальные не читают хранилище ключей"
        )


class TestMasterKeyErrors(KeyStoreCase):
    def test_missing_master_key_is_a_clear_refusal(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                EncryptedKeyStore(self.path)
        self.assertIn("WAKE_MASTER_KEY", str(ctx.exception))

    def test_wrong_master_key_does_not_look_like_an_empty_store(self):
        self.store().set_key("f1", 3, "0xsecret")
        other = self.store(master_key=Fernet.generate_key().decode())
        with self.assertRaises(RuntimeError) as ctx:
            other.get_key("f1")
        self.assertIn("WAKE_MASTER_KEY", str(ctx.exception))


class TestAtomicWrite(KeyStoreCase):
    def test_failed_write_keeps_the_previous_contents(self):
        """Запись идёт в .tmp и меняется через os.replace. Если между ними
        авария, на диске остаётся предыдущая таблица ключей — а не пустой файл,
        из-за которого копи-движок теряет ВСЕХ подписчиков."""
        store = self.store()
        store.set_key("f1", 3, "0xfirst")

        def boom(*args, **kwargs):
            raise OSError("disk full")

        with patch("os.replace", side_effect=boom), self.assertRaises(OSError):
            store.set_key("f2", 1, "0xsecond")

        self.assertEqual(self.store().follower_ids(), ["f1"])
        self.assertEqual(self.store().get_key("f1")["private_key"], "0xfirst")
        self.assertFalse(
            os.path.exists(self.path + ".tmp"), "временный файл не остаётся мусором"
        )

    def test_failed_attempt_leaves_no_temp_file(self):
        """Неудачная запись не оставляет .tmp рядом с хранилищем: в нём тот же
        набор ключей, и лишний файл на диске — это лишний путь к нему."""
        store = self.store()
        store.set_key("f1", 3, "0xfirst")
        with patch.object(store.fernet, "encrypt", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                store.set_key("f2", 1, "0xsecond")
        self.assertFalse(os.path.exists(self.path + ".tmp"))
        # настоящее хранилище не тронуто
        self.assertEqual(self.store().follower_ids(), ["f1"])


class TestListenerKeyStoreBoundary(unittest.TestCase):
    def test_unavailable_store_returns_none_instead_of_raising(self):
        """Нет WAKE_MASTER_KEY — и ни один ордер не должен стоить обрыва
        вебсокета: helper отвечает None, а листенер пишет failed-строчку."""
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(leader_listener._key_store())

    def test_available_store_is_returned(self):
        with TemporaryDirectory() as d:
            path = os.path.join(d, "ks.enc")
            key = generate_master_key()
            # Пути по умолчанию тест не касается: иначе он пишет keystore.enc в
            # рабочий каталог репозитория, а это чужой файл с чужим ключом.
            with patch.object(
                leader_listener,
                "EncryptedKeyStore",
                lambda: EncryptedKeyStore(path, key),
            ):
                store = leader_listener._key_store()
            self.assertIsInstance(store, EncryptedKeyStore)
            store.set_key("f1", 0, "0xsecret")
            self.assertEqual(store.get_key("f1")["api_key_index"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
