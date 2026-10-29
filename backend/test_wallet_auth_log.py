"""Nonce из тела клиента не должен попадать в аудит сырым: перевод строки в нём
позволял бы подделать целую запись лога (CodeQL py/log-injection)."""

import logging

from wallet_auth import WalletAuthError, _broken_record


def test_broken_record_sanitizes_a_forged_nonce(caplog):
    forged = (
        "0" * 32 + "\nchallenge 1111111111111111111111111111111f: запись повреждена"
    )

    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        err = _broken_record(forged, "расшифровка не сошлась")

    assert isinstance(err, WalletAuthError)
    assert err.code == "CHALLENGE_STORE_CORRUPTED"
    assert "1111111111111111111111111111111f" not in caplog.text
    assert "<invalid>" in caplog.text


def test_broken_record_keeps_a_valid_nonce(caplog):
    nonce = "a" * 32

    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        _broken_record(nonce, "расшифровка не сошлась")

    assert nonce in caplog.text
    assert "<invalid>" not in caplog.text


def test_broken_record_flattens_a_forged_detail_line(caplog):
    forged = "нет полей: a\nchallenge aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: вход выполнен"

    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        _broken_record("b" * 32, forged)

    records = [r for r in caplog.records if r.name == "wake.wallet_auth"]
    assert len(records) == 1, (
        "из одного вызова должно получаться ровно одна запись лога"
    )
    assert "\n" not in records[0].getMessage()


def test_broken_record_caps_a_long_detail(caplog):
    with caplog.at_level(logging.ERROR, logger="wake.wallet_auth"):
        _broken_record("c" * 32, "x" * 5000)

    assert "x" * 121 not in caplog.text
    assert "x" * 120 in caplog.text
