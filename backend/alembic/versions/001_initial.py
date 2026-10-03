"""initial schema — all tables from SQLite + new agent_trades and subscriptions

Revision ID: 001_initial
Revises:
Create Date: 2026-10-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Copy-trading ──────────────────────────────────────────────────────────
    op.create_table(
        "leaders",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("lighter_account_index", sa.Integer(), nullable=False),
        sa.Column("handle", sa.String(), nullable=False),
        sa.Column("fee_bps", sa.Integer(), nullable=False, server_default="8"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "followers",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("l1_address", sa.String(), nullable=False, unique=True),
        sa.Column("lighter_account_index", sa.Integer()),
        sa.Column("telegram_id", sa.Integer(), unique=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "follows",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "follower_id", sa.String(), sa.ForeignKey("followers.id"), nullable=False
        ),
        sa.Column(
            "leader_id", sa.String(), sa.ForeignKey("leaders.id"), nullable=False
        ),
        sa.Column("allocation_usd", sa.Float(), nullable=False),
        sa.Column("max_leverage", sa.Float(), nullable=False, server_default="3"),
        sa.Column(
            "current_mirrored_size", sa.Float(), nullable=False, server_default="0"
        ),
        sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("follower_id", "leader_id"),
    )
    op.create_index("idx_follows_leader", "follows", ["leader_id", "paused"])

    op.create_table(
        "mirror_log",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "follow_id", sa.String(), sa.ForeignKey("follows.id"), nullable=False
        ),
        sa.Column("market_id", sa.Integer(), nullable=False),
        sa.Column("side", sa.String(), nullable=False),
        sa.Column("base_amount", sa.Float(), nullable=False),
        sa.Column(
            "reduce_only", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("tx_hash", sa.String()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_mirror_log_follow", "mirror_log", ["follow_id", "created_at"]
    )

    # ── Predict ───────────────────────────────────────────────────────────────
    op.create_table(
        "predict_markets",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("lighter_market_id", sa.Integer()),
        sa.Column("threshold", sa.Float()),
        sa.Column("comparator", sa.String()),
        sa.Column("resolve_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("b", sa.Float(), nullable=False),
        sa.Column("q_yes", sa.Float(), nullable=False, server_default="0"),
        sa.Column("q_no", sa.Float(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("outcome", sa.String()),
        sa.Column("resolved_by", sa.String()),
        sa.Column("evidence_url", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "predict_positions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column(
            "market_id",
            sa.String(),
            sa.ForeignKey("predict_markets.id"),
            nullable=False,
        ),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("shares", sa.Float(), nullable=False, server_default="0"),
        sa.Column("claimed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("user_id", "market_id", "outcome"),
    )
    op.create_index(
        "idx_predict_positions_user", "predict_positions", ["user_id", "market_id"]
    )

    op.create_table(
        "predict_trades",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column(
            "market_id",
            sa.String(),
            sa.ForeignKey("predict_markets.id"),
            nullable=False,
        ),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("shares", sa.Float(), nullable=False),
        sa.Column("cost_usd", sa.Float(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # ── Audit ─────────────────────────────────────────────────────────────────
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("resource", sa.String()),
        sa.Column("details", sa.Text()),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("idx_audit_actor_time", "audit_log", ["actor", "created_at"])
    op.create_index("idx_audit_action_time", "audit_log", ["action", "created_at"])
    op.create_index("idx_audit_log_resource", "audit_log", ["resource"])

    # ── Agent memory (NEW — persisted from agent_memory.py) ───────────────────
    op.create_table(
        "agent_trades",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("market_id", sa.Integer(), nullable=False),
        sa.Column("side", sa.String(), nullable=False),
        sa.Column("entry_price", sa.Float(), nullable=False),
        sa.Column("size", sa.Float(), nullable=False),
        sa.Column("context_note", sa.Text(), nullable=False, server_default=""),
        sa.Column("exit_price", sa.Float()),
        sa.Column(
            "opened_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
    )
    op.create_index(
        "idx_agent_trades_market", "agent_trades", ["market_id", "opened_at"]
    )

    # ── Subscriptions (NEW — persisted from subscription.py) ──────────────────
    op.create_table(
        "subscriptions",
        sa.Column("user_id", sa.String(), primary_key=True),
        sa.Column("tier", sa.String(), nullable=False, server_default="free"),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("trial_started_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_table("subscriptions")
    op.drop_index("idx_agent_trades_market", table_name="agent_trades")
    op.drop_table("agent_trades")
    op.drop_index("idx_audit_log_resource", table_name="audit_log")
    op.drop_index("idx_audit_action_time", table_name="audit_log")
    op.drop_index("idx_audit_actor_time", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_table("predict_trades")
    op.drop_index("idx_predict_positions_user", table_name="predict_positions")
    op.drop_table("predict_positions")
    op.drop_table("predict_markets")
    op.drop_index("idx_mirror_log_follow", table_name="mirror_log")
    op.drop_table("mirror_log")
    op.drop_index("idx_follows_leader", table_name="follows")
    op.drop_table("follows")
    op.drop_table("followers")
    op.drop_table("leaders")
