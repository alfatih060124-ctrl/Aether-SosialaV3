import { createHash } from 'node:crypto';
import {
  ackMarketShadowPaperEvent,
  getMarketShadowRuntimeState,
  peekMarketShadowPaperEvents,
  retryMarketShadowPaperEvent,
  startMarketShadowRuntimeScan
} from './market-shadow-runtime.mjs';
import { persistQualifiedPaperArbitrageProbe } from './paper-arbitrage-persistence.mjs';
import { commandMemberAutoTradeStateInternal } from './member-autotrade-state-machine.mjs';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_LIMIT = 20;
const DEFAULT_INITIAL_BALANCE_USDC = 100;
const DEFAULT_PAPER_MIN_NET_EDGE_BPS = 0.5;
const DEFAULT_PAPER_POSITION_SIZE_PCT = 25;
const ADVISORY_LOCK_KEY = 210921;

const positiveInt = (value, fallback, max = 300_000) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

const audit = async (repos, event) => {
  if (!repos?.auditEvents?.append) return false;
  try { await repos.auditEvents.append(event); return true; } catch { return false; }
};

export function memberPaperIdempotencyKey(_scanId, candidate) {
  const identity = [
    String(candidate?.observed_at || ''),
    String(candidate?.token_mint || ''), String(candidate?.quote_mint || ''),
    String(candidate?.buy_dex || ''), String(candidate?.sell_dex || ''),
    String(candidate?.buy_pool_address || ''), String(candidate?.sell_pool_address || ''),
    String(candidate?.notional_usdc ?? ''),
    String(candidate?.gross_executable_spread_bps ?? ''),
    String(candidate?.expected_net_edge_bps ?? ''),
    String(candidate?.exact_roundtrip_fee_lamports ?? '')
  ];
  return 'market-shadow:v3:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export async function settleMemberFromCompletedShadowScan({
  pool, repos, member, scan, performanceFeeBps, executionFeeBps = 0, paperMinNetEdgeBps = DEFAULT_PAPER_MIN_NET_EDGE_BPS,
  persist = persistQualifiedPaperArbitrageProbe,
  transition = commandMemberAutoTradeStateInternal,
  initialBalanceUsdc = DEFAULT_INITIAL_BALANCE_USDC
} = {}) {  if (!pool || !member?.user_id || !scan?.scan_id) throw new Error('member_shadow_settlement_context_required');
  if (member.state !== 'RUNNING_SCANNING') return { settled: 0, skipped: true, reason: 'member_not_scanning' };
  if (scan.status !== 'COMPLETE' || scan.mode !== 'SHADOW' || scan.live_execution_authorized !== false) {
    throw new Error('member_shadow_scan_not_settleable');
  }
  const measured = Array.isArray(scan.summary?.measured) ? scan.summary.measured : (Array.isArray(scan.summary?.qualified) ? scan.summary.qualified : []);
  const paperCandidate = candidate => {
    if (
      candidate?.mode !== 'SHADOW' ||
      candidate?.execution_dispatched !== false ||
      candidate?.transaction_signed !== false ||
      candidate?.network_submission_authorized !== false ||
      candidate?.live_execution_authorized !== false ||
      !candidate?.buy_dex ||
      !candidate?.sell_dex ||
      !candidate?.buy_dex_family ||
      !candidate?.sell_dex_family ||
      !candidate?.buy_pool_address ||
      !candidate?.sell_pool_address ||
      candidate.buy_dex_family === candidate.sell_dex_family ||
      candidate.buy_pool_address === candidate.sell_pool_address ||
      candidate?.buy_pool_pair_verified !== true ||
      candidate?.sell_pool_pair_verified !== true ||
      candidate?.net_edge_gate_passed !== true ||
      candidate?.costs_verified !== true ||
      candidate?.exact_transaction_fee_ready !== true ||
      candidate?.transaction_built !== true ||
      candidate?.atomic_two_leg !== true ||
      candidate?.roundtrip_simulation_ok !== true ||
      candidate?.analysis_sla_passed !== true ||
      candidate?.paper_approval_passed !== true
    ) return null;
    if (!Number.isFinite(Number(candidate?.expected_net_edge_bps))) return null;
    const analysisMs = Number(candidate?.analysis_latency_ms);
    if (!Number.isFinite(analysisMs) || analysisMs < 0 || analysisMs > 300) return null;
    return candidate;
  };
  const executionSlaMs = Math.max(500, Math.min(3000, Number(process.env.AETHER_PAPER_EXECUTION_SLA_MS || 3000)));
  const qualified = measured.map(paperCandidate).filter(candidate => {
    if (!candidate || Number(candidate.expected_net_edge_bps) < paperMinNetEdgeBps) return false;
    const ageMs = Number(candidate.opportunity_age_ms);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > executionSlaMs) return false;
    return true;
  });
  let settled = 0;
  let duplicates = 0;
  let currentState = member.state;
  for (let index = 0; index < qualified.length; index += 1) {
    const candidate = qualified[index];
    if (Number(candidate?.expected_net_edge_bps) < paperMinNetEdgeBps) continue;
    if (currentState !== 'RUNNING_SCANNING') break;
    await transition(pool, member.user_id, 'BEGIN_EXECUTION');
    try {
      const key = memberPaperIdempotencyKey(scan.scan_id, candidate);
      const result = await persist(pool, { user_id: member.user_id, primary_wallet: member.wallet_address }, candidate, {
        performanceFeeBps,
        executionFeeBps,
        initialBalanceUsdc,
        idempotencyKey: key,
        minNetEdgeBps: paperMinNetEdgeBps
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
  const paperMinNetEdgeBps = Math.max(0, Math.min(20, Number(env.AUTOTRADE_PAPER_MIN_NET_EDGE_BPS || DEFAULT_PAPER_MIN_NET_EDGE_BPS)));
  const paperPositionSizePct = Math.max(1, Math.min(100, Number(env.AUTOTRADE_PAPER_POSITION_SIZE_PCT || DEFAULT_PAPER_POSITION_SIZE_PCT)));
  const stateRecoveryMs = positiveInt(env.AUTOTRADE_SHADOW_STATE_RECOVERY_MS, 15_000, 300_000);
  let busy = false;
  let stopped = false;
  let lastProcessedScanId = null;
  let timer = null;
  let cycles = 0;
  let lastError = null;
  const startedAtMs = Date.now();

  const cycle = async () => {
    if (busy || stopped) return;
    busy = true;
    const lease = await pool.connect();
    let locked = false;
    try {
      locked = (await lease.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY])).rows[0]?.locked === true;
      if (!locked) return;

      const staleStates = (await lease.query(`
        SELECT user_id,wallet_address,state,stop_requested,updated_at
        FROM member_autotrade_states
        WHERE state IN ('EXECUTING','SETTLING')
          AND updated_at < now() - ($1 * interval '1 millisecond')
        ORDER BY updated_at ASC
        LIMIT $2
      `, [stateRecoveryMs, batchLimit])).rows;
      for (const stale of staleStates) {
        try {
          const recovered = await transition(pool, stale.user_id, 'RECOVER_TIMEOUT');
          await audit(repos, {
            event_type: 'MEMBER_AUTOTRADE_SHADOW_STATE_RECOVERED',
            actor: stale.wallet_address || stale.user_id,
            entity_type: 'member_autotrade_state',
            entity_id: stale.user_id,
            payload: {
              from_state: stale.state,
              to_state: recovered.state,
              stop_requested: stale.stop_requested === true,
              recovery_timeout_ms: stateRecoveryMs,
              mode: 'SHADOW',
              live_execution_authorized: false
            }
          });
        } catch (error) {
          lastError = String(error?.message || error);
        }
      }

      const members = (await lease.query(`
        SELECT s.user_id,s.wallet_address,s.state,s.stop_requested,s.updated_at,a.cash_balance_usdc
        FROM member_autotrade_states s
        LEFT JOIN member_paper_arbitrage_accounts a ON a.user_id::text=s.user_id
        WHERE s.state='RUNNING_SCANNING'
        ORDER BY updated_at ASC
        LIMIT $1
      `, [batchLimit])).rows;
      if (!members.length) return;
      const streamed = peekMarketShadowPaperEvents(batchLimit * 10);
      if (streamed.length) {
        const feeRow = (await lease.query(`SELECT performance_fee_bps,execution_fee_bps FROM platform_fee_config WHERE config_id=1 AND enabled=true LIMIT 1`)).rows[0];
        const performanceFeeBps = Number(feeRow?.performance_fee_bps ?? 0);
        const executionFeeBps = Number(feeRow?.execution_fee_bps ?? 0);
        for (const event of streamed) {
          let eventFailed = false;
          for (const member of members) {
            try {
              const eventScan = { scan_id: `${event.scan_id}:${event.candidate.observed_at || event.received_at}`, status: 'COMPLETE', mode: 'SHADOW', live_execution_authorized: false, summary: { measured: [event.candidate] } };
              await settleMemberFromCompletedShadowScan({ pool, repos, member, scan: eventScan, performanceFeeBps, executionFeeBps, paperMinNetEdgeBps, initialBalanceUsdc });
            } catch (error) {
              eventFailed = true;
              lastError = String(error?.message || error);
            }
          }
          if (eventFailed) retryMarketShadowPaperEvent(event.event_id);
          else ackMarketShadowPaperEvent(event.event_id);
        }
      }
      const scan = getMarketShadowRuntimeState();
      if (scan.status === 'RUNNING') { cycles += 1; return; }

      if (scan.status === 'COMPLETE' && scan.scan_id && scan.scan_id !== lastProcessedScanId) {
        // Streaming events are the PAPER settlement source. Mark the completed batch only
        // so the same real-market observation cannot be settled twice after scan close.
        lastProcessedScanId = scan.scan_id;
      }

      const after = getMarketShadowRuntimeState();
      if (after.status === 'IDLE' || after.status === 'ERROR' || (after.status === 'COMPLETE' && after.scan_id === lastProcessedScanId)) {
        const sizingCash = Number(members[0]?.cash_balance_usdc ?? initialBalanceUsdc);
        const quoteUsdc = Math.max(0.01, sizingCash * paperPositionSizePct / 100);
        const quoteUsdcRaw = Math.max(1, Math.round(quoteUsdc * 1_000_000));
        startMarketShadowRuntimeScan({ quoteUsdcRaw });
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
    status() { const running = !stopped; return { enabled: running, busy, stopped, cycles, running_started_at: running ? new Date(startedAtMs).toISOString() : null, running_elapsed_ms: running ? Math.max(0, Date.now() - startedAtMs) : 0, last_processed_scan_id: lastProcessedScanId, last_error: lastError, paper_min_net_edge_bps: paperMinNetEdgeBps, paper_position_size_pct: paperPositionSizePct, state_recovery_ms: stateRecoveryMs, live_min_net_edge_bps: 20, mode: 'SHADOW', live_execution_authorized: false }; }
  };
}

export const MEMBER_AUTOTRADE_SHADOW_SCHEDULER = Object.freeze({
  enabled_by_default: false,
  execution_mode: 'SHADOW',
  min_expected_net_edge_bps: 0.5,
  paper_min_expected_net_edge_bps: 0.5,
  advisory_lock: true,
  transaction_count_cap: null,
  execution_dispatched: false,
  network_submission_authorized: false,
  signer_authorized: false,
  fund_movement_authorized: false,
  live_execution_authorized: false
});