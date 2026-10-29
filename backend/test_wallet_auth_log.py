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
