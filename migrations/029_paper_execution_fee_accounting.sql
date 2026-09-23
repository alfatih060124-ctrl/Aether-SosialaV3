-- Add explicit execution-fee accounting to real-market PAPER/SHADOW cycles.
ALTER TABLE member_paper_arbitrage_accounts
  ADD COLUMN IF NOT EXISTS execution_fees_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (execution_fees_usdc >= 0);

ALTER TABLE member_paper_arbitrage_cycles
  ADD COLUMN IF NOT EXISTS execution_fee_bps integer NOT NULL DEFAULT 0 CHECK (execution_fee_bps >= 0 AND execution_fee_bps <= 10000),
  ADD COLUMN IF NOT EXISTS execution_fee_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (execution_fee_usdc >= 0);