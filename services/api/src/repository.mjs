export class Repository {
  constructor(pool) {
    this.pool = pool;
  }

  async getHealth() {
    const result = await this.pool.query('SELECT now() AS now');
    return { status: 'ok', database: 'connected', server_time: result.rows[0].now };
  }

  async getTraderByWallet(walletAddress) {
    const result = await this.pool.query(
      `SELECT id, wallet_address, display_name, reputation_score, drawdown_bps
       FROM trader_profiles WHERE wallet_address = $1 LIMIT 1`,
      [walletAddress]
    );
    return result.rows[0] ?? null;
  }

  async createTradeEvent(event) {
    const result = await this.pool.query(
      `INSERT INTO trade_events
       (event_id, chain, dex, trader_wallet, token_in, token_out, amount_in_raw,
        amount_out_raw, amount_usd, tx_hash, slot, slippage_bps, confidence,
        observed_at, decoder_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [event.event_id, event.chain, event.dex, event.trader_wallet,
       event.token_in, event.token_out, event.amount_in_raw, event.amount_out_raw,
       event.amount_usd ?? null, event.tx_hash, event.slot, event.slippage_bps ?? null,
       event.confidence, event.observed_at, event.decoder_version]
    );
    return result.rows[0] ?? null;
  }

  async createExecutionRequest(input) {
    const result = await this.pool.query(
      `INSERT INTO execution_requests
       (idempotency_key, event_id, follower_user_id, mode, requested_amount_usd)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [input.idempotency_key, input.event_id, input.follower_user_id,
       input.mode ?? 'SHADOW', input.requested_amount_usd ?? null]
    );
    return result.rows[0];
  }
}
