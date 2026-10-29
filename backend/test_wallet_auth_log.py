"""В аудит входа кошельком попадает только префикс образа nonce и метка из
замкнутого словаря `_REASONS`: сырые данные клиентского запроса в лог не пишут
(CodeQL py/log-injection, py/clear-text-logging-sensitive-data)."""

import hashlib
import logging

import pytest
from wallet_auth import WalletAuthError, _broken_record, _record_of

NONCE = "a" * 32
REF = hashlib.sha256(NONCE.encode()).hexdigest()[:12]


def _logs(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "wake.wallet_auth"]


def test_broken_record_sanitizes_a_forged_nonce(caplog):
    forged = "0" * 32 + "\nchallenge " + "1" * 32 + ": запись повреждена"

    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        err = _broken_record(forged, "не JSON")

    assert isinstance(err, WalletAuthError)
    assert err.code == "CHALLENGE_STORE_CORRUPTED"
    assert err.status_code == 503
    assert _logs(caplog) == ["challenge <invalid>: запись Redis повреждена (не JSON)"]


def test_broken_record_keeps_a_valid_nonce(caplog):
    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        _broken_record(NONCE, "нет полей")

    assert _logs(caplog) == [f"challenge {REF}: запись Redis повреждена (нет полей)"]


def test_broken_record_drops_a_reason_outside_the_vocabulary(caplog):
    secret = "0x" + "b" * 40

    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        _broken_record(NONCE, f"клиент прислал {secret}")

    assert secret not in caplog.text
    assert NONCE not in caplog.text
    assert _logs(caplog) == [f"challenge {REF}: запись Redis повреждена (unclassified)"]


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        ("не json", "не JSON"),
        ("[1,2]", "не объект JSON"),
        ('{"address": "0x1"}', "нет полей"),
        ('{"address": 1, "message": "m", "exp": 2}', "тип поля"),
    ],
)
def test_record_of_reports_only_a_known_reason(caplog, raw, reason):
    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        with pytest.raises(WalletAuthError) as raised:
            _record_of(raw, NONCE)

    assert raised.value.code == "CHALLENGE_STORE_CORRUPTED"
    assert _logs(caplog) == [f"challenge {REF}: запись Redis повреждена ({reason})"]


def test_record_of_accepts_a_well_formed_record():
    record = _record_of('{"address": "0x1", "message": "m", "exp": 12}', NONCE)

    assert record == {"address": "0x1", "message": "m", "exp": 12}
