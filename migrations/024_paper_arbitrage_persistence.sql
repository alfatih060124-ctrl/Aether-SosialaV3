-- Dedicated persistent PAPER/SHADOW ledger for qualified ORCA <-> Raydium two-leg arbitrage.
-- This intentionally does not reuse legacy directional training positions.
CREATE TABLE IF NOT EXISTS member_paper_arbitrage_accounts (
  user_id uuid PRIMARY KEY,
  initial_balance_usdc numeric(30,10) NOT NULL DEFAULT 100 CHECK (initial_balance_usdc > 0),
  cash_balance_usdc numeric(30,10) NOT NULL DEFAULT 100 CHECK (cash_balance_usdc >= 0),
  realized_market_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  performance_fees_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (performance_fees_usdc >= 0),
  member_net_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  cycles_closed integer NOT NULL DEFAULT 0 CHECK (cycles_closed >= 0),
  profitable_cycles integer NOT NULL DEFAULT 0 CHECK (profitable_cycles >= 0),
  losing_cycles integer NOT NULL DEFAULT 0 CHECK (losing_cycles >= 0),
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  strategy text NOT NULL DEFAULT 'TWO_LEG_ARBITRAGE' CHECK (strategy='TWO_LEG_ARBITRAGE'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_paper_arbitrage_cycles (
  cycle_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_mint text NOT NULL,
  quote_mint text NOT NULL,
  buy_dex text NOT NULL CHECK (buy_dex IN ('orca','raydium')),
  sell_dex text NOT NULL CHECK (sell_dex IN ('orca','raydium')),
  buy_pool text NOT NULL,
  sell_pool text NOT NULL,
  notional_usdc numeric(30,10) NOT NULL CHECK (notional_usdc > 0),
  gross_profit_before_costs_usdc numeric(30,10) NOT NULL,
  market_execution_cost_usdc numeric(30,10) NOT NULL CHECK (market_execution_cost_usdc >= 0),
  market_net_pnl_usdc numeric(30,10) NOT NULL,
  performance_fee_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (performance_fee_usdc >= 0),
  member_net_profit_usdc numeric(30,10) NOT NULL,
  gross_edge_bps numeric(20,8) NOT NULL,
  net_edge_bps numeric(20,8) NOT NULL,
  network_fee_usdc numeric(30,10) NOT NULL CHECK (network_fee_usdc >= 0),
  cost_breakdown jsonb NOT NULL,
  assessment jsonb NOT NULL,
  market_source text NOT NULL,
  observed_at timestamptz NOT NULL,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  strategy text NOT NULL DEFAULT 'TWO_LEG_ARBITRAGE' CHECK (strategy='TWO_LEG_ARBITRAGE'),
  execution_dispatched boolean NOT NULL DEFAULT false CHECK (execution_dispatched=false),
  funds_moved boolean NOT NULL DEFAULT false CHECK (funds_moved=false),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buy_dex <> sell_dex)
);

CREATE INDEX IF NOT EXISTS idx_member_paper_cycles_user_created
  ON member_paper_arbitrage_cycles(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_paper_cycles_user_observed
  ON member_paper_arbitrage_cycles(user_id, observed_at DESC);
