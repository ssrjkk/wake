"""
[!]  НЕ ТЕСТИРОВАЛОСЬ — нет сети на pip install boto3, нет AWS-аккаунта в этой
песочнице. Написано по стандартному, документированному паттерну AWS KMS
envelope encryption, не выдумано.

Разница с encrypted_key_store.py, ради которой это вообще пишется: там мастер-
ключ лежит в переменной окружения на том же хосте, что и процесс — если хост
скомпрометирован, мастер-ключ доступен вместе с зашифрованными данными. Здесь
сырой ключ шифрования НИКОГДА не покидает AWS KMS: мы просим KMS сгенерировать
"data key" (получаем и plaintext-версию для немедленного использования, и
encrypted-версию для хранения), шифруем данные локально plaintext-версией и
сразу её забываем, а для расшифровки заново просим KMS расшифровать encrypted-
версию через сеть — сам компрометированный хост без доступа к AWS credentials
с правом kms:Decrypt ничего не может.

pip install boto3
AWS: создать KMS key (aws kms create-key), IAM role с kms:GenerateDataKey и
kms:Decrypt ТОЛЬКО на этот конкретный key ARN — не на "*".
"""

import json
import os

try:
    import boto3
    from cryptography.fernet import Fernet
except ImportError:
    boto3 = None  # позволяет импортировать файл для чтения/тестирования структуры без boto3 в наличии

KMS_KEY_ID = os.environ.get("WAKE_KMS_KEY_ID")  # arn:aws:kms:...
DEFAULT_PATH = os.environ.get("WAKE_KEYSTORE_PATH", "keystore_kms.enc")


class KmsKeyStore:
    def __init__(self, path: str = DEFAULT_PATH, kms_key_id: str | None = None, region: str = "us-east-1"):
        if boto3 is None:
            raise RuntimeError("boto3 не установлен — pip install boto3")
        self.kms_key_id = kms_key_id or KMS_KEY_ID
        if not self.kms_key_id:
            raise RuntimeError("WAKE_KMS_KEY_ID не задан — нужен ARN ключа KMS")
        self.kms = boto3.client("kms", region_name=region)
        self.path = path
        if not os.path.exists(path):
            self._write({"encrypted_data_key": None, "ciphertext": b""})

    def _generate_data_key(self) -> tuple:
        """Возвращает (plaintext_key, encrypted_key) — plaintext используется сразу
        и не сохраняется на диск НИКОГДА, encrypted_key — то, что хранится."""
        resp = self.kms.generate_data_key(KeyId=self.kms_key_id, KeySpec="AES_256")
        return resp["Plaintext"], resp["CiphertextBlob"]

    def _decrypt_data_key(self, encrypted_key: bytes) -> bytes:
        resp = self.kms.decrypt(CiphertextBlob=encrypted_key, KeyId=self.kms_key_id)
        return resp["Plaintext"]

    def _read_raw(self) -> dict:
        with open(self.path, "rb") as f:
            raw = f.read()
        if not raw:
            return {}
        header_len = int.from_bytes(raw[:4], "big")
        encrypted_data_key = raw[4:4 + header_len]
        ciphertext = raw[4 + header_len:]
        plaintext_key = self._decrypt_data_key(encrypted_data_key)
        fernet = Fernet(_to_fernet_key(plaintext_key))
        return json.loads(fernet.decrypt(ciphertext))

    def _write(self, data: dict):
        plaintext_key, encrypted_key = self._generate_data_key()
        fernet = Fernet(_to_fernet_key(plaintext_key))
        ciphertext = fernet.encrypt(json.dumps(data).encode())
        with open(self.path, "wb") as f:
            f.write(len(encrypted_key).to_bytes(4, "big"))
            f.write(encrypted_key)
            f.write(ciphertext)
        del plaintext_key  # не задерживается в памяти дольше необходимого

    def set_key(self, follower_id: str, api_key_index: int, private_key: str):
        data = self._read_raw() if os.path.getsize(self.path) > 0 else {}
        data[follower_id] = {"api_key_index": api_key_index, "private_key": private_key}
        self._write(data)

    def get_key(self, follower_id: str) -> dict | None:
        if os.path.getsize(self.path) == 0:
            return None
        return self._read_raw().get(follower_id)


def _to_fernet_key(raw_32_bytes: bytes) -> bytes:
    import base64
    return base64.urlsafe_b64encode(raw_32_bytes)
