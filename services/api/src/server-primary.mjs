import './server.mjs';
import { Pool } from 'pg';
import { createConfiguredMemberAutoTradeRealMarketRuntime } from './member-autotrade-real-market-runtime-factory.mjs';
import { createMemberAutoTradeShadowScheduler } from './member-autotrade-shadow-scheduler.mjs';

const enabled = String(process.env.AUTOTRADE_SHADOW_SCHEDULER_ENABLED || 'false').trim().toLowerCase() === 'true';
const executionMode = String(process.env.EXECUTION_MODE || 'SHADOW').trim().toUpperCase();
const liveEnabled = String(process.env.LIVE_ENABLED || 'false').trim().toLowerCase() === 'true';

async function waitForStateTable(pool, { attempts = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1 FROM member_autotrade_states LIMIT 1');
      return;
    } catch (error) {
      if (attempt === attempts) throw new Error(`autotrade_shadow_state_table_unavailable:${String(error?.message || 'unknown')}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function startShadowWorker() {
  if (!enabled) return;
  if (executionMode !== 'SHADOW' || liveEnabled) throw new Error('autotrade_shadow_scheduler_safety_gate_failed');
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('autotrade_shadow_scheduler_database_unconfigured');

  const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
  await waitForStateTable(workerPool);
  const runtime = createConfiguredMemberAutoTradeRealMarketRuntime({ env: process.env });
  const scheduler = createMemberAutoTradeShadowScheduler({
    pool: workerPool,
    runtime,
    intervalMs: Number(process.env.AUTOTRADE_SHADOW_SCHEDULER_INTERVAL_MS || 15000),
    batchLimit: Number(process.env.AUTOTRADE_SHADOW_BATCH_LIMIT || 20),
    initialBalanceUsdc: Number(process.env.AUTOTRADE_SHADOW_INITIAL_BALANCE_USDC || 100),
    staleAfterMs: Number(process.env.AUTOTRADE_SHADOW_STALE_AFTER_MS || 120000),
    onError(error) { console.error('autotrade_shadow_tick_failed', String(error?.message || error)); }
  });
  scheduler.start();
  console.log('AETHER SHADOW Auto Trade scheduler started', scheduler.status());
}

startShadowWorker().catch(error => {
  console.error('autotrade_shadow_scheduler_startup_failed', String(error?.message || error));
  process.exitCode = 1;
});

export const MEMBER_AUTOTRADE_PRIMARY_SERVER_WIRING = Object.freeze({
  scheduler_opt_in_required: true,
  required_execution_mode: 'SHADOW',
  live_enabled_required: false,
  signer_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
