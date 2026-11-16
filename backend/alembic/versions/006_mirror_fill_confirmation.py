"""mirror_log.filled_base_amount: что площадка подтвердила по заявке

Revision ID: 006_mirror_fill_confirmation
Revises: 005_mirror_positions
Create Date: 2026-11-16

`base_amount` — это то, что листенер ЗАКАЗАЛ. Живой MARKET+IOC отвечает
успешным хэшем и когда исполнился целиком, и когда снят с цены не на одну
сделку, а сверки у пути не было: журнал писал `sent`, учёт двигался на
заказанный размер, и подписчик оставался с позицией, которой на его аккаунте
нет. Следующий reduce планировался от числа листенера, а reduce-ордер на
несуществующую позицию площадка отклоняла — расхождение становилось вечным,
потому что читать его было бы не откуда.

Лента `/api/v1/trades` анонимна, фильтруется по `account_index` + `market_id` +
`role=taker` и несёт `client_order_index` каждой стороны (замер mainnet
2026-11-16), поэтому исполнение одной конкретной заявки различимо без ключа
подписчика. Колонка хранит то, что в ней и называется: исполненный базовый
размер.

Бэкфилла нет и быть не может: строки до этого шага никто не сверял, и число
`filled_base_amount` для них означало бы либо выдуманное «исполнилось», либо
выдуманное «не исполнилось». NULL у старой строки читается как «не сверялось»,
и это ровно правда.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "006_mirror_fill_confirmation"
down_revision: Union[str, None] = "005_mirror_positions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mirror_log", sa.Column("filled_base_amount", sa.Float(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("mirror_log", "filled_base_amount")
