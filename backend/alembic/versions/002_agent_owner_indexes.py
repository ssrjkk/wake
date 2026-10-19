"""agent_trades: владелец и статус; индексы под реальные запросы

Revision ID: 002_agent_owner_indexes
Revises: 001_initial
Create Date: 2026-10-17

agent_trades появилась в 001 как будущая персистентная версия памяти агента, но
таблица пустовала, потому что строке не хватало владельца: без user_id нельзя
выбрать историю одного пользователя, и api/agent.py держал её словарём в
процессе. status записывается рядом, чтобы симуляция (dry_run) не выглядела
исполненным ордером.

Индексы — под два запроса, которые без них досматривают таблицу целиком:
список открытых рынков (status + дедлайн) и позиции пользователя по сделкам
(user_id + рынок + исход).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "002_agent_owner_indexes"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_trades",
        sa.Column("user_id", sa.String(), nullable=False, server_default=""),
    )
    op.alter_column("agent_trades", "user_id", server_default=None)
    op.add_column(
        "agent_trades",
        sa.Column("status", sa.String(), nullable=False, server_default="dry_run"),
    )
    op.create_index("idx_agent_trades_user", "agent_trades", ["user_id", "opened_at"])

    op.create_index(
        "idx_predict_markets_status",
        "predict_markets",
        ["status", "resolve_at"],
    )
    op.create_index(
        "idx_predict_trades_user",
        "predict_trades",
        ["user_id", "market_id", "outcome"],
    )


def downgrade() -> None:
    op.drop_index("idx_predict_trades_user", table_name="predict_trades")
    op.drop_index("idx_predict_markets_status", table_name="predict_markets")
    op.drop_index("idx_agent_trades_user", table_name="agent_trades")
    op.drop_column("agent_trades", "status")
    op.drop_column("agent_trades", "user_id")
