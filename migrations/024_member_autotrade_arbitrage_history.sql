-- Extend persistent member Auto Trade demo history for the locked TWO_LEG_ARBITRAGE SHADOW strategy.
-- Existing legacy rows remain valid; new web simulator rows may persist atomic arbitrage settlements.
ALTER TABLE member_autotrade_demo_trades
  DROP CONSTRAINT IF EXISTS member_autotrade_demo_trades_engine_action_check;
ALTER TABLE member_autotrade_demo_trades
  ADD CONSTRAINT member_autotrade_demo_trades_engine_action_check
  CHECK (engine_action IN ('BUY','SELL','HOLD','REJECT','ARBITRAGE_SETTLE'));

ALTER TABLE member_autotrade_demo_trades
  DROP CONSTRAINT IF EXISTS member_autotrade_demo_trades_settlement_status_check;
ALTER TABLE member_autotrade_demo_trades
  ADD CONSTRAINT member_autotrade_demo_trades_settlement_status_check
  CHECK (settlement_status IN ('OPENED','CLOSED','HELD','REJECTED','NO_OPEN_POSITION','OPEN_POSITION_EXISTS','INSUFFICIENT_DEMO_BALANCE','ARBITRAGE_CLOSED'));
