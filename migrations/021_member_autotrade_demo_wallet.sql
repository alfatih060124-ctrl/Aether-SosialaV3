-- Persistent per-member Auto Trade demo wallet. SHADOW only; no custody, signer, or live funds.
CREATE TABLE IF NOT EXISTS member_autotrade_demo_accounts (
  user_id uuid PRIMARY KEY,
  initial_balance_usdc numeric(30,10) NOT NULL DEFAULT 100 CHECK (initial_balance_usdc > 0),
  cash_balance_usdc numeric(30,10) NOT NULL DEFAULT 100 CHECK (cash_balance_usdc >= 0),
  realized_net_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  performance_fees_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (performance_fees_usdc >= 0),
  trades_closed integer NOT NULL DEFAULT 0 CHECK (trades_closed >= 0),
  winning_trades integer NOT NULL DEFAULT 0 CHECK (winning_trades >= 0),
  losing_trades integer NOT NULL DEFAULT 0 CHECK (losing_trades >= 0),
  open_position jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_autotrade_demo_trades (
  trade_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  scenario text NOT NULL,
  engine_action text NOT NULL CHECK (engine_action IN ('BUY','SELL','HOLD','REJECT')),
  settlement_status text NOT NULL CHECK (settlement_status IN ('OPENED','CLOSED','HELD','REJECTED','NO_OPEN_POSITION','OPEN_POSITION_EXISTS','INSUFFICIENT_DEMO_BALANCE')),
  notional_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (notional_usdc >= 0),
  gross_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  performance_fee_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (performance_fee_usdc >= 0),
  net_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  pnl_bps integer,
  balance_before_usdc numeric(30,10) NOT NULL,
  balance_after_usdc numeric(30,10) NOT NULL,
  engine_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_member_demo_trades_user_created
  ON member_autotrade_demo_trades(user_id, created_at DESC);
