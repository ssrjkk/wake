"""follows: tombstone при отписке; leaders: один лидер на аккаунт

Revision ID: 003_follow_tombstone_unique
Revises: 002_agent_owner_indexes
Create Date: 2026-10-23

DELETE /follows/{id} удалял строку подписки. На подписке, по которой копи-движок
уже хоть что-то исполнил, висит FOREIGN KEY mirror_log.follow_id — и удаление
давало IntegrityError, то есть 500 на самой обычной кнопке «отписаться».
Журнал при этом и есть единственный ответ на вопрос «что движок сделал с моими
деньгами», поэтому оставлять его нельзя, а каскадное удаление стёрло бы его
вместе с подпиской. Схема помечает строку deleted_at: отписка работает, история
остается, `follows_for_*` такие строки не отдают.

UNIQUE на leaders.lighter_account_index: POST /leaders читает существующего
лидера по индексу аккаунта и потому идемпотентен, но между «проверить» и
«вставить» в двух параллельных запросов у одного аккаунта заводилось по записи.
Две карточки одного трейдера в Discover — это и удвоенный AUM, и неопределённый
ответ на «чей это лидер» при смене комиссии.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "003_follow_tombstone_unique"
down_revision: Union[str, None] = "002_agent_owner_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "follows",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "uq_leaders_lighter_account_index",
        "leaders",
        ["lighter_account_index"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_leaders_lighter_account_index", table_name="leaders")
    op.drop_column("follows", "deleted_at")
