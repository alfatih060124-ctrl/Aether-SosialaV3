export async function getMemberEngineRentalState(pool, userId, now = new Date()) {
  if (!userId) return { allowed:false, reason:'user_id_required', subscription:null };

  const plans = await pool.query(`
    SELECT plan_id,code,name,billing_period_days,price_usdc,active
    FROM member_engine_plans
    WHERE active=true
    ORDER BY price_usdc ASC, created_at ASC
  `);

  const q = await pool.query(`
    SELECT s.subscription_id,s.user_id,s.plan_id,s.status,s.payment_status,
           s.amount_usdc,s.payment_provider,s.payment_reference,
           s.period_start,s.period_end,s.paid_at,s.created_at,s.updated_at,
           p.code AS plan_code,p.name AS plan_name,p.billing_period_days,p.price_usdc
    FROM member_engine_subscriptions s
    JOIN member_engine_plans p ON p.plan_id=s.plan_id
    WHERE s.user_id=$1
    ORDER BY s.created_at DESC
    LIMIT 1
  `,[userId]);

  const subscription = q.rows[0] ?? null;
  const available_plans = plans.rows;
  if (!subscription) return { allowed:false, reason:'engine_subscription_required', subscription:null, available_plans };
  if (subscription.status !== 'ACTIVE') return { allowed:false, reason:`engine_subscription_${String(subscription.status).toLowerCase()}`, subscription, available_plans };
  if (subscription.payment_status !== 'PAID' || !subscription.paid_at) return { allowed:false, reason:'engine_subscription_payment_required', subscription, available_plans };
  if (!subscription.period_end || new Date(subscription.period_end) <= now) return { allowed:false, reason:'engine_subscription_expired', subscription, available_plans };
  return { allowed:true, reason:'engine_subscription_active', subscription, available_plans };
}

export async function createMemberEngineCheckout(pool, userId, planCode) {
  if (!userId) throw new Error('user_id_required');
  if (!planCode) throw new Error('plan_code_required');
  const planQ = await pool.query(`SELECT plan_id,code,name,billing_period_days,price_usdc FROM member_engine_plans WHERE code=$1 AND active=true LIMIT 1`,[planCode]);
  const plan = planQ.rows[0];
  if (!plan) throw new Error('engine_plan_not_found');

  const activeQ = await pool.query(`SELECT subscription_id FROM member_engine_subscriptions WHERE user_id=$1 AND status='ACTIVE' AND payment_status='PAID' AND period_end>now() LIMIT 1`,[userId]);
  if (activeQ.rows[0]) throw new Error('engine_subscription_already_active');

  const existingQ = await pool.query(`
    SELECT subscription_id,user_id,plan_id,status,payment_status,amount_usdc,payment_provider,payment_reference,period_start,period_end,paid_at,created_at,updated_at
    FROM member_engine_subscriptions
    WHERE user_id=$1 AND plan_id=$2 AND status='PENDING' AND payment_status='PENDING'
    ORDER BY created_at DESC LIMIT 1
  `,[userId,plan.plan_id]);
  if (existingQ.rows[0]) return { subscription:existingQ.rows[0], plan, reused:true };

  const created = await pool.query(`
    INSERT INTO member_engine_subscriptions(user_id,plan_id,status,payment_status,amount_usdc)
    VALUES($1,$2,'PENDING','PENDING',$3)
    RETURNING subscription_id,user_id,plan_id,status,payment_status,amount_usdc,payment_provider,payment_reference,period_start,period_end,paid_at,created_at,updated_at
  `,[userId,plan.plan_id,plan.price_usdc]);
  return { subscription:created.rows[0], plan, reused:false };
}

export async function activatePaidMemberEngineSubscription(pool, { subscriptionId, paymentProvider, paymentReference, paidAt = new Date() }) {
  if (!subscriptionId) throw new Error('subscription_id_required');
  if (!paymentProvider) throw new Error('payment_provider_required');
  if (!paymentReference) throw new Error('payment_reference_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(`
      SELECT s.subscription_id,s.user_id,s.plan_id,s.status,s.payment_status,p.billing_period_days
      FROM member_engine_subscriptions s JOIN member_engine_plans p ON p.plan_id=s.plan_id
      WHERE s.subscription_id=$1 FOR UPDATE
    `,[subscriptionId]);
    const row = q.rows[0];
    if (!row) throw new Error('engine_subscription_not_found');
    if (row.payment_status === 'PAID' && row.status === 'ACTIVE') {
      await client.query('COMMIT');
      return row;
    }
    const start = new Date(paidAt);
    const end = new Date(start.getTime() + Number(row.billing_period_days) * 24 * 60 * 60 * 1000);
    await client.query(`UPDATE member_engine_subscriptions SET status='EXPIRED',updated_at=now() WHERE user_id=$1 AND status='ACTIVE' AND subscription_id<>$2`,[row.user_id,subscriptionId]);
    const updated = await client.query(`
      UPDATE member_engine_subscriptions
      SET status='ACTIVE',payment_status='PAID',payment_provider=$2,payment_reference=$3,paid_at=$4,period_start=$4,period_end=$5,updated_at=now()
      WHERE subscription_id=$1
      RETURNING *
    `,[subscriptionId,paymentProvider,paymentReference,start,end]);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
