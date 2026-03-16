-- sXLM Protocol Analytics Schema
-- Run this once to set up the analytics database

-- Tracks indexed protocol events from Stellar Horizon / Soroban
CREATE TABLE IF NOT EXISTS protocol_events (
  id            BIGSERIAL PRIMARY KEY,
  ledger        BIGINT        NOT NULL,
  timestamp     TIMESTAMPTZ   NOT NULL,
  event_type    VARCHAR(50)   NOT NULL,  -- stake, unstake, borrow, liquidation, flash_loan, lp_deposit, lp_withdraw
  user_address  VARCHAR(56)   NOT NULL,
  contract_id   VARCHAR(56),
  asset         VARCHAR(20)   DEFAULT 'XLM',
  amount        NUMERIC(38,7) DEFAULT 0,
  amount_usd    NUMERIC(38,7) DEFAULT 0,
  revenue_usd   NUMERIC(38,7) DEFAULT 0,
  tx_hash       VARCHAR(64)   UNIQUE NOT NULL,
  raw_data      JSONB
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp   ON protocol_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_type        ON protocol_events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_user        ON protocol_events (user_address);
CREATE INDEX IF NOT EXISTS idx_events_ledger      ON protocol_events (ledger);
CREATE INDEX IF NOT EXISTS idx_events_type_ts     ON protocol_events (event_type, timestamp DESC);

-- Tracks the last indexed ledger per contract so we can resume without re-indexing
CREATE TABLE IF NOT EXISTS ledger_cursors (
  contract_id   VARCHAR(56)   PRIMARY KEY,
  last_ledger   BIGINT        NOT NULL DEFAULT 0,
  paging_token  VARCHAR(64),
  last_tx_hash  VARCHAR(64),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Materialized daily summary for fast dashboard queries
CREATE TABLE IF NOT EXISTS daily_summaries (
  date          DATE          PRIMARY KEY,
  total_staked  NUMERIC(38,7) DEFAULT 0,
  total_borrowed NUMERIC(38,7) DEFAULT 0,
  total_revenue NUMERIC(38,7) DEFAULT 0,
  tvl_usd       NUMERIC(38,7) DEFAULT 0,
  active_users  INT           DEFAULT 0,
  stake_count   INT           DEFAULT 0,
  borrow_count  INT           DEFAULT 0,
  liquidation_count INT       DEFAULT 0,
  flash_loan_count  INT       DEFAULT 0,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summaries (date DESC);
