import { runRunnableMemberAutoTradeShadowBatch } from './member-autotrade-shadow-runtime-binding.mjs';

function boundedInt(value, fallback, min, max, code) {
  const number = value === undefined || value === null || String(value).trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(code);
  return number;
}

export function createMemberAutoTradeShadowScheduler({
  pool,
  runtime,
  runBatch = runRunnableMemberAutoTradeShadowBatch,
  intervalMs = 15_000,
  batchLimit = 20,
  performanceFeeBps = 1000,
  initialBalanceUsdc = 100,
  staleAfterMs = 120_000,
  onError = () => {}
} = {}) {
  if (!pool) throw new Error('autotrade_shadow_scheduler_pool_required');
  if (!runtime || typeof runtime.runNextOpportunity !== 'function') throw new Error('autotrade_shadow_scheduler_runtime_required');
  if (typeof runBatch !== 'function') throw new Error('autotrade_shadow_scheduler_batch_runner_required');
  if (typeof onError !== 'function') throw new Error('autotrade_shadow_scheduler_error_handler_required');
  const cadence = boundedInt(intervalMs, 15_000, 5_000, 300_000, 'autotrade_shadow_scheduler_interval_invalid');
  const limit = boundedInt(batchLimit, 20, 1, 100, 'autotrade_shadow_scheduler_batch_limit_invalid');
  let timer = null;
  let running = false;
  let stopped = true;

  async function runOnce() {
    if (running) return Object.freeze({ status: 'SKIPPED_OVERLAP', mode: 'SHADOW', live_execution_authorized: false });
    running = true;
    try {
      return await runBatch({ pool, runtime, performanceFeeBps, initialBalanceUsdc, limit, staleAfterMs });
    } finally {
      running = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await runOnce(); } catch (error) { try { onError(error); } catch {} }
      scheduleNext();
    }, cadence);
    timer.unref?.();
  }

  return Object.freeze({
    async runOnce() { return runOnce(); },
    start() {
      if (!stopped) return false;
      stopped = false;
      scheduleNext();
      return true;
    },
    stop() {
      if (stopped) return false;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      return true;
    },
    status() {
      return Object.freeze({ running_tick: running, scheduler_started: !stopped, interval_ms: cadence, batch_limit: limit, mode: 'SHADOW', live_execution_authorized: false });
    }
  });
}

export const MEMBER_AUTOTRADE_SHADOW_SCHEDULER = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  auto_start_on_import: false,
  overlap_allowed: false,
  default_interval_ms: 15_000,
  transaction_count_cap: null,
  signer_authorized: false,
  funds_moved: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
