BEGIN;

-- Keep persistence support aligned with the executable DEX universe.
-- PAPER remains SHADOW-only; this only permits accounting after the existing
-- build/simulation/exact-cost/NET-edge gates have all passed.
ALTER TABLE member_paper_arbitrage_cycles
  DROP CONSTRAINT IF EXISTS member_paper_arbitrage_cycles_buy_dex_check,
  DROP CONSTRAINT IF EXISTS member_paper_arbitrage_cycles_sell_dex_check;

ALTER TABLE member_paper_arbitrage_cycles
  ADD CONSTRAINT member_paper_arbitrage_cycles_buy_dex_check
    CHECK (buy_dex IN ('orca','raydium','meteora','pumpfun','phoenix')),
  ADD CONSTRAINT member_paper_arbitrage_cycles_sell_dex_check
    CHECK (sell_dex IN ('orca','raydium','meteora','pumpfun','phoenix'));

COMMIT;