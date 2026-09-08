import { getMarketShadowRuntimeState, startMarketShadowRuntimeScan } from './market-shadow-runtime.mjs';
import { persistQualifiedPaperArbitrageProbe } from './paper-arbitrage-persistence.mjs';
import { commandMemberAutoTradeStateInternal } from './member-autotrade-state-machine.mjs';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_LIMIT = 20;
const DEFAULT_INITIAL_BALANCE_USDC = 100;
const ADVISORY_LOCK_KEY = 210921;

const positiveInt = (value, fallback, max = 300_000) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

const audit = async (repos, event) => {
  if (!repos?.auditEvents?.append) return false;
  try { await repos.auditEvents.append(event); return true; } catch { return false; }
};

export async function settleMemberFromCompletedShadowScan({
  pool, repos, member, scan, performanceFeeBps,
  persist = persistQualifiedPaperArbitrageProbe,
  transition = commandMemberAutoTradeStateInternal,
  initialBalanceUsdc = DEFAULT_INITIAL_BALANCE_USDC
} = {}) {  if (!pool || !member?.user_id || !scan?.scan_id) throw new Error('member_shadow_settlement_context_required');
  if (member.state !== 'RUNNING_SCANNING') return { settled: 0, skipped: true, reason: 'member_not_scanning' };
  if (scan.status !== 'COMPLETE' || scan.mode !== 'SHADOW' || scan.live_execution_authorized !== false) {
    throw new Error('member_shadow_scan_not_settleable');
  }
  const qualified = Array.isArray(scan.summary?.qualified) ? scan.summary.qualified : [];
  let settled = 0;
  let duplicates = 0;
  let currentState = member.state;
  for (let index = 0; index < qualified.length; index += 1) {
    const candidate = qualified[index];
    if (Number(candidate?.expected_net_edge_bps) < 20 || candidate?.net_edge_gate_passed !== true) continue;
    if (currentState !== 'RUNNING_SCANNING') break;
    await transition(pool, member.user_id, 'BEGIN_EXECUTION');
    try {
      const key = `market-shadow:${scan.scan_id}:${index}:${candidate.token_mint}:${candidate.buy_dex}:${candidate.sell_dex}`;
      const result = await persist(pool, { user_id: member.user_id, primary_wallet: member.wallet_address }, candidate, {
        performanceFeeBps,
        initialBalanceUsdc,
        idempotencyKey: key
      });
      await transition(pool, member.user_id, 'BEGIN_SETTLING');
      const finalState = await transition(pool, member.user_id, 'SETTLED');
      currentState = finalState.state;
      settled += result?.duplicate ? 0 : 1;
      duplicates += result?.duplicate ? 1 : 0;
      await audit(repos, {
        event_type: 'MEMBER_AUTOTRADE_SHADOW_CYCLE_SETTLED',
        actor: member.wallet_address || member.user_id,
        entity_type: 'member_autotrade_state',
        entity_id: member.user_id,
        payload: { scan_id: scan.scan_id, token_mint: candidate.token_mint, net_edge_bps: candidate.expected_net_edge_bps, duplicate: result?.duplicate === true, mode: 'SHADOW', live_execution_authorized: false }
      });
    } catch (error) {
      try { await transition(pool, member.user_id, 'FAIL'); } catch {}
      await audit(repos, {
        event_type: 'MEMBER_AUTOTRADE_SHADOW_CYCLE_FAILED',
        actor: member.wallet_address || member.user_id,
        entity_type: 'member_autotrade_state',
        entity_id: member.user_id,
        payload: { scan_id: scan.scan_id, error: String(error?.message || error), mode: 'SHADOW', live_execution_authorized: false }
      });
      throw error;
    }
  }  return {
    settled,
    duplicates,
    qualified_seen: qualified.length,
    final_state: currentState,
    mode: 'SHADOW',
    execution_dispatched: false,
    network_submission_authorized: false,
    signer_authorized: false,
    fund_movement_authorized: false,
    live_execution_authorized: false
  };
}

export function startMemberAutoTradeShadowScheduler({ pool, repos, env = process.env } = {}) {
  if (!pool) return { enabled: false, reason: 'database_unconfigured', stop() {} };
  const enabled = String(env.AUTOTRADE_SHADOW_SCHEDULER_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return { enabled: false, reason: 'disabled_by_default', stop() {} };
  if (String(env.EXECUTION_MODE || 'SHADOW').toUpperCase() !== 'SHADOW' || String(env.LIVE_ENABLED || 'false').toLowerCase() === 'true') {
    throw new Error('member_shadow_scheduler_requires_shadow_live_off');
  }

  const intervalMs = positiveInt(env.AUTOTRADE_SHADOW_SCHEDULER_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const batchLimit = positiveInt(env.AUTOTRADE_SHADOW_BATCH_LIMIT, DEFAULT_BATCH_LIMIT, 200);
  const initialBalanceUsdc = Number(env.AUTOTRADE_SHADOW_INITIAL_BALANCE_USDC || DEFAULT_INITIAL_BALANCE_USDC);
  let busy = false;
  let stopped = false;
  let lastProcessedScanId = null;
  let timer = null;
  let cycles = 0;
  let lastError = null;

  const cycle = async () => {
    if (busy || stopped) return;
    busy = true;
    const lease = await pool.connect();
    let locked = false;
    try {
      locked = (await lease.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY])).rows[0]?.locked === true;
      if (!locked) return;
      const members = (await lease.query(`
        SELECT user_id,wallet_address,state,stop_requested,updated_at
        FROM member_autotrade_states
        WHERE state='RUNNING_SCANNING'
        ORDER BY updated_at ASC
        LIMIT $1
      `, [batchLimit])).rows;
      if (!members.length) return;      const scan = getMarketShadowRuntimeState();
      if (scan.status === 'RUNNING') return;

      if (scan.status === 'COMPLETE' && scan.scan_id && scan.scan_id !== lastProcessedScanId) {
        const feeRow = (await lease.query(`SELECT performance_fee_bps FROM platform_fee_config WHERE config_id=1 AND enabled=true LIMIT 1`)).rows[0];
        const performanceFeeBps = Number(feeRow?.performance_fee_bps ?? 0);
        for (const member of members) {
          try {
            await settleMemberFromCompletedShadowScan({ pool, repos, member, scan, performanceFeeBps, initialBalanceUsdc });
          } catch (error) {
            lastError = String(error?.message || error);
          }
        }
        lastProcessedScanId = scan.scan_id;
      }

      const after = getMarketShadowRuntimeState();
      if (after.status === 'IDLE' || after.status === 'ERROR' || (after.status === 'COMPLETE' && after.scan_id === lastProcessedScanId)) {
        startMarketShadowRuntimeScan();
      }
      cycles += 1;
    } catch (error) {
      lastError = String(error?.message || error);
    } finally {
      if (locked) {
        try { await lease.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]); } catch {}
      }
      lease.release();
      busy = false;
    }
  };

  timer = setInterval(() => { cycle().catch(() => {}); }, intervalMs);
  timer.unref?.();
  cycle().catch(() => {});

  return {
    enabled: true,
    interval_ms: intervalMs,
    batch_limit: batchLimit,
    mode: 'SHADOW',
    live_execution_authorized: false,
    stop() { stopped = true; if (timer) clearInterval(timer); },
    status() { return { enabled: true, busy, stopped, cycles, last_processed_scan_id: lastProcessedScanId, last_error: lastError, mode: 'SHADOW', live_execution_authorized: false }; }
  };
}

export const MEMBER_AUTOTRADE_SHADOW_SCHEDULER = Object.freeze({
  enabled_by_default: false,
  execution_mode: 'SHADOW',
  min_expected_net_edge_bps: 20,
  advisory_lock: true,
  transaction_count_cap: null,
  execution_dispatched: false,
  network_submission_authorized: false,
  signer_authorized: false,
  fund_movement_authorized: false,
  live_execution_authorized: false
});