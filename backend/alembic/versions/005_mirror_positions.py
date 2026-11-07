"""mirror_positions: размер зеркальной позиции на (подписка, рынок)

Revision ID: 005_mirror_positions
Revises: 004_leader_active
Create Date: 2026-10-30

follows.current_mirrored_size хранила ОДНО число на все рынки, а движок читал
его как «сколько открыто в рынке события». Закрытие 0.5 BTC у лидера при
позициях подписчика 1.0 BTC + 1.0 ETH планировало reduce на 2.0 BTC — больше,
чем у него есть в BTC, — а после списания суммы учёт уходил в ноль и терял
открытый ETH: следующее закрытие ETH отвечало «нечего уменьшать», и подписчик
оставался в позиции, из которой лидер давно вышел.

mirror_positions — источник правды по каждому рынку. Сумма по рынкам для
отображения считается при чтении (db._mirrored_total), поэтому денормализованной
колонки, которая может разъехаться с собственными строками, больше нет.

Бэкфилл берёт историю из mirror_log: для каждой (подписка, рынок) сумма
отправленных открытий минус отправленных закрытий. Это реконструкция того, что
движок реально делал, а не перекладывание старой суммы в один произвольный
рынок.

leader_tracker_state — состояние трекера позиций лидера, переживающее рестарт
процесса. Без него первый снапшот после деплоя трактовался как «лидер только что
открыл весь портфель» (дубли позиций у подписчиков), а закрытия, сделанные пока
листенер лежал, не эмитились никогда.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "005_mirror_positions"
down_revision: Union[str, None] = "004_leader_active"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "mirror_positions",
        sa.Column(
            "follow_id", sa.String(), sa.ForeignKey("follows.id"), primary_key=True
        ),
        sa.Column("market_id", sa.Integer(), primary_key=True),
        sa.Column("size", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.execute(
        """
        INSERT INTO mirror_positions (follow_id, market_id, size, updated_at)
        SELECT follow_id,
               market_id,
               SUM(CASE WHEN reduce_only THEN -base_amount ELSE base_amount END),
               now()
        FROM mirror_log
        WHERE status = 'sent'
        GROUP BY follow_id, market_id
        HAVING SUM(CASE WHEN reduce_only THEN -base_amount ELSE base_amount END) > 0
        """
    )

    op.drop_column("follows", "current_mirrored_size")

    op.create_table(
        "leader_tracker_state",
        sa.Column(
            "leader_id", sa.String(), sa.ForeignKey("leaders.id"), primary_key=True
        ),
        sa.Column("equity", sa.Float()),
        sa.Column("positions", sa.Text(), nullable=False, server_default="{}"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.add_column(
        "follows",
        sa.Column(
            "current_mirrored_size", sa.Float(), nullable=False, server_default="0"
        ),
    )
    op.execute(
        """
        UPDATE follows f
        SET current_mirrored_size = COALESCE(
            (SELECT SUM(p.size) FROM mirror_positions p WHERE p.follow_id = f.id), 0
        )
        """
    )
    op.drop_table("mirror_positions")
    op.drop_table("leader_tracker_state")
