-- Postgres-схема для масштаба в сотни-тысячи одновременных пользователей.
-- Отличия от SQLite-версии не косметические:
--   - UUID/TIMESTAMPTZ вместо TEXT/REAL для id и времени — типобезопасность,
--     не полагаемся на дисциплину приложения
--   - NUMERIC вместо REAL/FLOAT для денег — float теряет точность на суммах,
--     это не гипотетический риск при реальных деньгах
--   - Явные FOREIGN KEY с ON DELETE — SQLite их поддерживает, но часто не
--     включает по умолчанию; здесь это гарантировано схемой
--   - CHECK-констрейнты на уровне БД, не только в Python — вторая линия
--     защиты, если код в обход ORM когда-нибудь появится

CREATE TABLE IF NOT EXISTS leaders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lighter_account_index INTEGER NOT NULL UNIQUE,
    handle TEXT NOT NULL,
    fee_bps INTEGER NOT NULL DEFAULT 8 CHECK (fee_bps >= 0 AND fee_bps <= 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    l1_address TEXT NOT NULL UNIQUE,
    lighter_account_index INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES followers(id) ON DELETE CASCADE,
    leader_id UUID NOT NULL REFERENCES leaders(id) ON DELETE CASCADE,
    allocation_usd NUMERIC(18, 2) NOT NULL CHECK (allocation_usd > 0),
    max_leverage NUMERIC(6, 2) NOT NULL DEFAULT 3 CHECK (max_leverage > 0),
    current_mirrored_size NUMERIC(24, 8) NOT NULL DEFAULT 0,
    paused BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (follower_id, leader_id)
);

CREATE TABLE IF NOT EXISTS mirror_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follow_id UUID NOT NULL REFERENCES follows(id) ON DELETE CASCADE,
    market_id INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('long', 'short')),
    base_amount NUMERIC(24, 8) NOT NULL,
    reduce_only BOOLEAN NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'skipped', 'dry_run', 'sent', 'failed')),
    reason TEXT,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индекс под самый частый запрос в горячем пути: "все активные подписки на
-- этого лидера" — вызывается на КАЖДОЕ движение позиции лидера.
CREATE INDEX IF NOT EXISTS idx_follows_leader_active ON follows(leader_id) WHERE paused = false;
CREATE INDEX IF NOT EXISTS idx_mirror_log_follow_time ON mirror_log(follow_id, created_at DESC);

-- Предсказания
CREATE TABLE IF NOT EXISTS predict_markets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('price', 'event')),
    question TEXT NOT NULL,
    lighter_market_id INTEGER,
    threshold NUMERIC(24, 8),
    comparator TEXT CHECK (comparator IN ('>=', '<=', '>', '<')),
    resolve_at TIMESTAMPTZ NOT NULL,
    b NUMERIC(18, 4) NOT NULL CHECK (b > 0),
    q_yes NUMERIC(24, 8) NOT NULL DEFAULT 0,
    q_no NUMERIC(24, 8) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    outcome TEXT CHECK (outcome IN ('yes', 'no')),
    resolved_by TEXT,
    evidence_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind != 'price' OR (lighter_market_id IS NOT NULL AND threshold IS NOT NULL AND comparator IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS predict_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES followers(id) ON DELETE CASCADE,
    market_id UUID NOT NULL REFERENCES predict_markets(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no')),
    shares NUMERIC(24, 8) NOT NULL DEFAULT 0 CHECK (shares >= 0),
    claimed BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (user_id, market_id, outcome)
);

CREATE TABLE IF NOT EXISTS predict_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES followers(id),
    market_id UUID NOT NULL REFERENCES predict_markets(id),
    outcome TEXT NOT NULL,
    shares NUMERIC(24, 8) NOT NULL,
    cost_usd NUMERIC(18, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_predict_positions_user ON predict_positions(user_id, market_id);
