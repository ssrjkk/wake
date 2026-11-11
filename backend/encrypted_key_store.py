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

import argparse
import getpass
import json
import os
import sys

from cryptography.fernet import Fernet, InvalidToken

DEFAULT_KEYSTORE_PATH = "keystore.enc"


def generate_master_key() -> str:
    """Запусти один раз, сохрани результат ТОЛЬКО в секрет-менеджер/переменную
    окружения — никогда не в файл в репозитории."""
    return Fernet.generate_key().decode()


class EncryptedKeyStore:
    def __init__(self, path: str | None = None, master_key: str | None = None):
        master_key = master_key or os.environ.get("WAKE_MASTER_KEY")
        if not master_key:
            raise RuntimeError(
                "WAKE_MASTER_KEY не задан. Сгенерируй через generate_master_key() "
                "и положи в секрет-менеджер (не в файл в репозитории)."
            )
        self.fernet = Fernet(master_key.encode())
        # Переменная читается при создании, а не при импорте модуля: путь
        # задаётся процессу оператором, а импорт происходит до того, как оператор
        # его задал (и до подмены в тестах).
        self.path = (
            path
            if path is not None
            else os.environ.get("WAKE_KEYSTORE_PATH", DEFAULT_KEYSTORE_PATH)
        )
        # Файл намеренно НЕ создаётся здесь: конструктор не должен оставлять
        # пустое хранилище по опечатке в WAKE_KEYSTORE_PATH, пока настоящая
        # таблица ключей лежит рядом под другим именем.

    def _read(self) -> dict:
        try:
            with open(self.path, "rb") as f:
                blob = f.read()
        except FileNotFoundError:
            # Нет файла — нет и ключей. Это пустое хранилище, а не авария:
            # вызывающий код уже умеет отвечать None на отсутствующего подписчика.
            return {}
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
        """Атомарная запись и права только владельцу.

        Прежний `open(path, "wb")` сначала усекал файл до нуля и только потом
        писал: процесс, умерший между этими двумя шагами, оставлял пустое
        хранилище, то есть терялись ключи ВСЕХ подписчиков разом, и копи-движок
        отвечал «no_key» на каждый ордер. os.replace меняет файл целиком, поэтому
        прежнее содержимое живёт на диске до успешной записи нового.

        Режим 0o600 ставится при создании файла, а не chmod'ом после: между
        `open()` и `chmod()` файл с ключами всех подписчиков лежит с umask
        (обычно 0o644 — читается всеми), и на многоярусном хосте это окно —
        готовая кража."""
        tmp = f"{self.path}.tmp"
        blob = self.fernet.encrypt(json.dumps(data).encode())
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(blob)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)  # O_CREAT маскируется umask'ом — режим доводится
            os.replace(tmp, self.path)
        finally:
            # Неудачная замена не должна оставлять лишний файл с ключами:
            # содержимое то же, что у настоящего хранилища, и доступ к нему
            # ничем не защищён.
            if os.path.exists(tmp):
                os.unlink(tmp)

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


# ── Ключ кладёт оператор, а не подписчик ─────────────────────────────────────
#
# HTTP-эндпоинта для приватного ключа здесь нет нарочно: путь, по которому чужой
# торговый ключ проходит через тот же процесс, что отдаёт публичный JSON, — это
# ещё одна дыра и ещё одна поверхность, где ключ может попасть в лог, в телеметрию
# или в чей-то curl. Но и «ключи подписчиков хранятся в зашифрованном файле» из
# SECURITY.md без способа их положить означало путь, который ни один вызывающий
# код не использует: copy-движок на каждом ордере отвечал бы `no_key`, а человек
# считал бы, что копирует. Поэтому — CLI: читает секрет из stdin, никогда из
# аргументов командной строки (argv видно в `ps` и в истории shell), и никогда не
# печатает его обратно.


def _read_secret(prompt: str) -> str:
    """Одна строка секрета: из терминала без эха или из pipe.

    printf '%s' "$LIGHTER_API_KEY_PRIVATE_KEY" | python encrypted_key_store.py store <follower_id> 0
    """
    if sys.stdin.isatty():
        return getpass.getpass(prompt).strip()
    return sys.stdin.readline().strip()


def _cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="encrypted_key_store.py",
        description=(
            "Ключи подписчиков для копи-движка. Приватный ключ читается из stdin "
            "и в argv не попадает."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    store = sub.add_parser("store", help="положить ключ подписчика")
    store.add_argument("follower_id")
    store.add_argument("api_key_index", type=int)
    remove = sub.add_parser("remove", help="убрать ключ подписчика")
    remove.add_argument("follower_id")
    sub.add_parser("list", help="показать, у кого ключи есть")

    args = parser.parse_args(argv)
    if args.cmd == "store" and args.api_key_index < 0:
        parser.error("api_key_index должен быть не меньше нуля")
    store_obj = EncryptedKeyStore()

    if args.cmd == "store":
        secret = _read_secret("LIGHTER_API_KEY_PRIVATE_KEY: ").strip()
        if not secret:
            # Отказ, а не «записали пусто»: пустая запись выглядит как ключ, и
            # листенер спотыкается о неё уже позже, на ордере.
            print("пустой ключ — ничего не записано", file=sys.stderr)
            return 2
        store_obj.set_key(args.follower_id, args.api_key_index, secret)
        print("ключ записан")
        return 0
    if args.cmd == "remove":
        removed = store_obj.remove_key(args.follower_id)
        print("убрано" if removed else "такого подписчика в хранилище нет")
        return 0 if removed else 1
    for follower_id in store_obj.follower_ids():
        print(follower_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
