export async function checkExecutionEngineRental(pool, traderId, now = new Date()) {
  if (!traderId) return { allowed:false, reason:'trader_id_required' };
  const q = await pool.query(`SELECT rental_id,status,monthly_rate_bps,amount_due_usd,currency,period_start,period_end,paid_at,payment_status,payment_reference FROM execution_engine_rentals WHERE trader_id=$1 ORDER BY created_at DESC LIMIT 1`, [traderId]);
  const rental = q.rows[0] ?? null;
  if (!rental) return { allowed:false, reason:'execution_engine_rental_missing' };
  if (rental.status !== 'ACTIVE') return { allowed:false, reason:`execution_engine_rental_${String(rental.status).toLowerCase()}`, rental };
  if (rental.payment_status !== 'PAID' || !rental.paid_at) return { allowed:false, reason:'execution_engine_rental_payment_required', rental };
  if (new Date(rental.period_end) <= now) return { allowed:false, reason:'execution_engine_rental_expired', rental };
  return { allowed:true, reason:'execution_engine_rental_active', rental };
}
