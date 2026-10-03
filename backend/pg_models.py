"""
SQLAlchemy 2.0 models for PostgreSQL.

Этот модуль — единственный источник правды о схеме PostgreSQL. Все таблицы
отражают то, что уже работало в SQLite (db.py, predict_db.py, audit_log.py),
плюс две новые (agent_trades, subscriptions) — чтобы перевести in-memory
состояния в персистентное хранилище.

Имена таблиц и колонок намеренно совпадают со SQLite-версией, чтобы миграция
данных (pgloader / COPY) прошла без трансформации.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
)


def _uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


# ── Copy-trading (db.py) ─────────────────────────────────────────────────────


class Leader(Base):
    __tablename__ = "leaders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    lighter_account_index: Mapped[int] = mapped_column(Integer, nullable=False)
    handle: Mapped[str] = mapped_column(String, nullable=False)
    fee_bps: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    follows: Mapped[list["Follow"]] = relationship(back_populates="leader")


class Follower(Base):
    __tablename__ = "followers"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    l1_address: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    lighter_account_index: Mapped[int | None] = mapped_column(Integer)
    telegram_id: Mapped[int | None] = mapped_column(Integer, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    follows: Mapped[list["Follow"]] = relationship(back_populates="follower")


class Follow(Base):
    __tablename__ = "follows"
    __table_args__ = (
        UniqueConstraint("follower_id", "leader_id"),
        Index("idx_follows_leader", "leader_id", "paused"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    follower_id: Mapped[str] = mapped_column(
        String, ForeignKey("followers.id"), nullable=False
    )
    leader_id: Mapped[str] = mapped_column(
        String, ForeignKey("leaders.id"), nullable=False
    )
    allocation_usd: Mapped[float] = mapped_column(Float, nullable=False)
    max_leverage: Mapped[float] = mapped_column(Float, nullable=False, default=3.0)
    current_mirrored_size: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    paused: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    follower: Mapped[Follower] = relationship(back_populates="follows")
    leader: Mapped[Leader] = relationship(back_populates="follows")
    mirror_log: Mapped[list["MirrorLog"]] = relationship(back_populates="follow")


class MirrorLog(Base):
    __tablename__ = "mirror_log"
    __table_args__ = (Index("idx_mirror_log_follow", "follow_id", "created_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    follow_id: Mapped[str] = mapped_column(
        String, ForeignKey("follows.id"), nullable=False
    )
    market_id: Mapped[int] = mapped_column(Integer, nullable=False)
    side: Mapped[str] = mapped_column(String, nullable=False)
    base_amount: Mapped[float] = mapped_column(Float, nullable=False)
    reduce_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    tx_hash: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    follow: Mapped[Follow] = relationship(back_populates="mirror_log")


# ── Predict (predict_db.py) ──────────────────────────────────────────────────


class PredictMarket(Base):
    __tablename__ = "predict_markets"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    lighter_market_id: Mapped[int | None] = mapped_column(Integer)
    threshold: Mapped[float | None] = mapped_column(Float)
    comparator: Mapped[str | None] = mapped_column(String)
    resolve_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    b: Mapped[float] = mapped_column(Float, nullable=False)
    q_yes: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    q_no: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")
    outcome: Mapped[str | None] = mapped_column(String)
    resolved_by: Mapped[str | None] = mapped_column(String)
    evidence_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    positions: Mapped[list["PredictPosition"]] = relationship(back_populates="market")
    trades: Mapped[list["PredictTrade"]] = relationship(back_populates="market")


class PredictPosition(Base):
    __tablename__ = "predict_positions"
    __table_args__ = (
        UniqueConstraint("user_id", "market_id", "outcome"),
        Index("idx_predict_positions_user", "user_id", "market_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    market_id: Mapped[str] = mapped_column(
        String, ForeignKey("predict_markets.id"), nullable=False
    )
    outcome: Mapped[str] = mapped_column(String, nullable=False)
    shares: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    claimed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    market: Mapped[PredictMarket] = relationship(back_populates="positions")


class PredictTrade(Base):
    __tablename__ = "predict_trades"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    market_id: Mapped[str] = mapped_column(
        String, ForeignKey("predict_markets.id"), nullable=False
    )
    outcome: Mapped[str] = mapped_column(String, nullable=False)
    shares: Mapped[float] = mapped_column(Float, nullable=False)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    market: Mapped[PredictMarket] = relationship(back_populates="trades")


# ── Audit (audit_log.py) ─────────────────────────────────────────────────────


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("idx_audit_actor_time", "actor", "created_at"),
        Index("idx_audit_action_time", "action", "created_at"),
        Index("idx_audit_log_resource", "resource"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actor: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    resource: Mapped[str | None] = mapped_column(String)
    details: Mapped[str | None] = mapped_column(Text)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


# ── Agent memory (agent_memory.py → persisted) ───────────────────────────────


class AgentTrade(Base):
    """Персистентная версия TradeRecord из agent_memory.py.

    In-memory AgentMemoryStore продолжает работать как быстрый кэш; этот
    таблица — источник правды при рестарте процесса.
    """

    __tablename__ = "agent_trades"
    __table_args__ = (Index("idx_agent_trades_market", "market_id", "opened_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    market_id: Mapped[int] = mapped_column(Integer, nullable=False)
    side: Mapped[str] = mapped_column(String, nullable=False)
    entry_price: Mapped[float] = mapped_column(Float, nullable=False)
    size: Mapped[float] = mapped_column(Float, nullable=False)
    context_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    exit_price: Mapped[float | None] = mapped_column(Float)
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ── Subscriptions (subscription.py → persisted) ──────────────────────────────


class Subscription(Base):
    """Персистентная версия Subscription из subscription.py."""

    __tablename__ = "subscriptions"

    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    tier: Mapped[str] = mapped_column(String, nullable=False, default="free")
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    trial_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
