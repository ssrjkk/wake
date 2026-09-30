# CLAUDE.md

Read `AGENTS.md` in this directory first. It is the single source of truth for this repo.

Critical rules, repeated on purpose:
- Testnet and `WAKE_DRY_RUN=true` are defaults. No real money before `backend/GO-LIVE-CHECKLIST.md` is signed off.
- `encrypted_key_store.py` is not HSM-grade; `kms_key_store.py` was never run. Not for third-party production keys.
- Event-market creation is gated by `WAKE_CURATOR_TOKEN` (see `api/predict.py`); event markets carry regulatory risk — verify rules for your jurisdiction before opening to users.
- Never claim untested code works; keep the tested/untested labels accurate.
