"""
[!]   DEV-СТАБ. НЕ ПРОДАКШН. НЕ ДЛЯ ЧУЖИХ РЕАЛЬНЫХ КЛЮЧЕЙ.

Хранит API-ключи в незашифрованном локальном JSON-файле. Это осознанно упрощённая
заглушка, чтобы весь пайплайн (лидер -> mirror_engine -> исполнение) можно было
прогнать на СВОИХ тестовых ключах в Фазе 1/начале Фазы 2 и увидеть, что архитектура
в целом связывается воедино.

Настоящее решение для чужих торговых ключей — HSM/KMS или обоснованная замена,
с security-ревью именно этого компонента. Это блокирующий гейт Фазы 2 в
не то, что можно закрыть заменой одного файла на другой
без переосмысления всей модели угроз (кто имеет доступ к процессу, как ротируются
ключи, что происходит при компрометации хоста, где физически лежат секреты).

Если этот файл всё ещё используется в момент, когда к системе подключён первый
человек, который не является частью команды и не согласился явно на риск, —
это не "техдолг на потом", это причина остановиться.
"""

import json
import os

DEFAULT_PATH = os.environ.get("WAKE_DEV_KEYSTORE_PATH", "dev_keystore.local.json")


class DevKeyStore:
    def __init__(self, path: str = DEFAULT_PATH):
        self.path = path
        if not os.path.exists(path):
            with open(path, "w") as f:
                json.dump({}, f)

    def _read(self) -> dict:
        with open(self.path) as f:
            return json.load(f)

    def _write(self, data: dict):
        with open(self.path, "w") as f:
            json.dump(data, f, indent=2)

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
