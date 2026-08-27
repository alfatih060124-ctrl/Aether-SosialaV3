export function createTradeEventRepository(pool) {
  return {
    async insert(event) {
      const q = `INSERT INTO trade_events (event_id,chain,dex,trader_wallet,token_in,token_out,amount_in_raw,amount_out_raw,amount_usd,tx_hash,slot,confidence,observed_at,decoder_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (event_id) DO NOTHING RETURNING *`;
      const v = [event.event_id,event.chain,event.dex,event.trader_wallet,event.token_in,event.token_out,event.amount_in_raw,event.amount_out_raw,event.amount_usd,event.tx_hash,event.slot,event.confidence,event.observed_at,event.decoder_version];
      return (await pool.query(q,v)).rows[0] ?? null;
    },
    async getById(eventId) {
      return (await pool.query('SELECT * FROM trade_events WHERE event_id=$1',[eventId])).rows[0] ?? null;
    },
    async recent(limit=50) {
      return (await pool.query('SELECT * FROM trade_events ORDER BY observed_at DESC LIMIT $1',[Math.min(Math.max(Number(limit)||50,1),200)])).rows;
    }
  };
}
