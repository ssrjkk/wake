"""leaders.active — публикацию можно выключить

Revision ID: 004_leader_active
Revises: 003_follow_tombstone_unique
Create Date: 2026-10-24

Переключатель «Публиковать мои сделки» существовал только в памяти React: ни
POST /leaders, ни таблица leaders не знали ничего про «лидер выключился».
Выключенный лидер продолжал светиться в GET /leaders и — что главное —
leader_listener продолжает читать его позиции и зеркалить сделки на аккаунты
всех подписчиков. Человек дергал рубильник, а его деньги и чужие деньги дальше
двигались по его сигналам.

Колонка с server_default=true: существующие записи становятся активными, а не
выключенными. Иначе миграция молча остановила бы зеркалирование у тех, на кого
копируют прямо сейчас.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "004_leader_active"
down_revision: Union[str, None] = "003_follow_tombstone_unique"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "leaders",
        sa.Column(
            "active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )


def downgrade() -> None:
    op.drop_column("leaders", "active")
