"""
Шифрование ключей на диске (encryption at rest) через Fernet (AES-128-CBC + HMAC).
Это РЕАЛЬНОЕ улучшение над key_store.py (открытый JSON) — но не путай его с HSM/KMS.

Что это даёт: если кто-то получит файл `*.enc` сам по себе — бэкап базы, случайно
закоммиченный файл, скопированный диск — без мастер-ключа он бесполезен.

Что это НЕ даёт: мастер-ключ (WAKE_MASTER_KEY) живёт в переменной окружения на
ТОЙ ЖЕ машине, что и процесс. Если скомпрометирован сам работающий процесс или
хост целиком — у атакующего есть доступ и к зашифрованным данным, и к
переменным окружения, которыми они расшифровываются. Настоящий HSM/KMS не
отдаёт сырой ключ процессу вообще — операция подписи происходит ВНУТРИ
аппаратной границы. Это здесь НЕ реализовано и не может быть реализовано
просто более аккуратным Python-кодом — это отдельная инфраструктура
(AWS KMS / GCP Cloud HSM / Vault Transit и т.п.) —
Фаза 2.

Так что статус честно такой: это заметно лучше, чем было, и это НЕ "теперь можно
чужие реальные деньги". Разница между "encryption at rest" и "custody-grade
key management" — это разница, которую отрасль не зря обозначает разными словами.
"""

import json
import os
from cryptography.fernet import Fernet, InvalidToken

DEFAULT_PATH = os.environ.get("WAKE_KEYSTORE_PATH", "keystore.enc")


def generate_master_key() -> str:
    """Запусти один раз, сохрани результат ТОЛЬКО в секрет-менеджер/переменную
    окружения — никогда не в файл в репозитории."""
    return Fernet.generate_key().decode()


class EncryptedKeyStore:
    def __init__(self, path: str = DEFAULT_PATH, master_key: str | None = None):
        master_key = master_key or os.environ.get("WAKE_MASTER_KEY")
        if not master_key:
            raise RuntimeError(
                "WAKE_MASTER_KEY не задан. Сгенерируй через generate_master_key() "
                "и положи в секрет-менеджер (не в файл в репозитории)."
            )
        self.fernet = Fernet(master_key.encode())
        self.path = path
        if not os.path.exists(path):
            self._write({})

    def _read(self) -> dict:
        with open(self.path, "rb") as f:
            blob = f.read()
        if not blob:
            return {}
        try:
            plaintext = self.fernet.decrypt(blob)
        except InvalidToken as e:
            raise RuntimeError(
                "Не удалось расшифровать keystore — неверный WAKE_MASTER_KEY или файл повреждён"
            ) from e
        return json.loads(plaintext)

    def _write(self, data: dict):
        plaintext = json.dumps(data).encode()
        blob = self.fernet.encrypt(plaintext)
        with open(self.path, "wb") as f:
            f.write(blob)

    def set_key(self, follower_id: str, api_key_index: int, private_key: str):
        data = self._read()
        data[follower_id] = {"api_key_index": api_key_index, "private_key": private_key}
        self._write(data)

    def get_key(self, follower_id: str) -> dict | None:
        return self._read().get(follower_id)

    def remove_key(self, follower_id: str) -> bool:
        data = self._read()
        if follower_id in data:
            del data[follower_id]
            self._write(data)
            return True
        return False

    def follower_ids(self) -> list:
        return list(self._read().keys())
