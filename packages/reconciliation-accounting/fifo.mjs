import crypto from 'node:crypto';

const USD_SCALE = 1_000_000n;
const MAX_EVENTS = 10_000;
const MAX_DECIMAL_PLACES = 6;
export const INVENTORY_SCOPE = 'OBSERVED_EVENTS_ONLY_ZERO_OPENING_BALANCE';

function requiredText(value, name, max = 160) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`invalid_${name}`);
  return text;
}

function rawAmount(value, name) {
  const text = requiredText(value, name, 120);
  if (!/^\d+$/.test(text)) throw new Error(`invalid_${name}`);
  const amount = BigInt(text);
  if (amount <= 0n) throw new Error(`invalid_${name}`);
  return amount;
}

export function usdToMinor(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_amount_usd');
    value = value.toFixed(MAX_DECIMAL_PLACES);
  }
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text);
  if (!match) throw new Error('invalid_amount_usd');
  const whole = BigInt(match[1]);
  const fractionRaw = match[2] || '';
  const kept = (fractionRaw + '0'.repeat(MAX_DECIMAL_PLACES)).slice(0, MAX_DECIMAL_PLACES);
  const discarded = fractionRaw.slice(MAX_DECIMAL_PLACES);
  if (discarded && /[1-9]/.test(discarded)) throw new Error('amount_usd_precision_exceeds_scale');
  const minor = whole * USD_SCALE + BigInt(kept || '0');
  if (minor <= 0n) throw new Error('invalid_amount_usd');
  return minor;
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function eventOrder(a, b) {
  const slotA = Number(a.slot);
  const slotB = Number(b.slot);
  if (slotA !== slotB) return slotA - slotB;
  const timeA = Date.parse(a.observed_at);
  const timeB = Date.parse(b.observed_at);
  if (timeA !== timeB) return timeA - timeB;
  return String(a.event_id).localeCompare(String(b.event_id));
}

function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('invalid_trade_event');
  const eventId = requiredText(event.event_id, 'event_id');
  const txHash = requiredText(event.tx_hash, 'tx_hash');
  const decoderVersion = requiredText(event.decoder_version, 'decoder_version');
  if (/shadow/i.test(eventId) || /shadow/i.test(txHash) || /shadow/i.test(decoderVersion)) throw new Error('synthetic_trade_event_blocked');
  if (String(event.chain || '').toLowerCase() !== 'solana') throw new Error('unsupported_chain');
  const slot = Number(event.slot);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('invalid_slot');
  const confidence = Number(event.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.90 || confidence > 1) throw new Error('accounting_event_confidence_too_low');
  const observedAtMs = Date.parse(event.observed_at);
  if (!Number.isFinite(observedAtMs)) throw new Error('invalid_observed_at');
  return {
    event_id: eventId,
    tx_hash: txHash,
    decoder_version: decoderVersion,
    trader_wallet: requiredText(event.trader_wallet, 'trader_wallet'),
    token_in: requiredText(event.token_in, 'token_in'),
    token_out: requiredText(event.token_out, 'token_out'),
    amount_in_raw: rawAmount(event.amount_in_raw, 'amount_in_raw'),
    amount_out_raw: rawAmount(event.amount_out_raw, 'amount_out_raw'),
    amount_usd_minor: usdToMinor(event.amount_usd),
    slot,
    confidence,
    observed_at: new Date(observedAtMs).toISOString()
  };
}

function safeNumberMinor(value) {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) throw new Error('accounting_minor_value_overflow');
  return Number(value);
}

function consumeFifo(lots, quantity) {
  let remaining = quantity;
  let cost = 0n;
  const sourceLots = [];
  while (remaining > 0n && lots.length) {
    const lot = lots[0];
    const take = lot.remaining_quantity_raw <= remaining ? lot.remaining_quantity_raw : remaining;
    let allocatedCost;
    if (take === lot.remaining_quantity_raw) {
      allocatedCost = lot.remaining_cost_minor;
    } else {
      allocatedCost = (lot.remaining_cost_minor * take) / lot.remaining_quantity_raw;
    }
    sourceLots.push({
      event_id: lot.event_id,
      quantity_raw: take.toString(),
      cost_minor: safeNumberMinor(allocatedCost)
    });
    lot.remaining_quantity_raw -= take;
    lot.remaining_cost_minor -= allocatedCost;
    cost += allocatedCost;
    remaining -= take;
    if (lot.remaining_quantity_raw === 0n) lots.shift();
  }
  return { fulfilled: remaining === 0n, remaining, cost, sourceLots };
}

export function buildFifoAccountingCandidates({ events = [], quoteMints = [] } = {}) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new Error('invalid_accounting_events');
  if (!Array.isArray(quoteMints) || quoteMints.length < 1) throw new Error('quote_mints_required');
  const quoteSet = new Set(quoteMints.map(mint => requiredText(mint, 'quote_mint')));
  if (quoteSet.size !== quoteMints.length) throw new Error('duplicate_quote_mint');

  const normalized = events.map(validateEvent).sort(eventOrder);
  const wallets = new Set(normalized.map(event => event.trader_wallet));
  if (wallets.size > 1) throw new Error('mixed_trader_wallets');
  const seenEvents = new Set();
  const lotsByMint = new Map();
  const blockedTokens = new Map();
  const candidates = [];
  const issues = [];
  const skipped = [];

  for (const event of normalized) {
    if (seenEvents.has(event.event_id)) throw new Error('duplicate_trade_event');
    seenEvents.add(event.event_id);
    const inQuote = quoteSet.has(event.token_in);
    const outQuote = quoteSet.has(event.token_out);
    if (inQuote === outQuote) {
      skipped.push({ event_id: event.event_id, reason: inQuote ? 'QUOTE_TO_QUOTE_UNSUPPORTED' : 'NON_QUOTE_PAIR_UNSUPPORTED' });
      continue;
    }

    const side = inQuote ? 'BUY' : 'SELL';
    const baseMint = side === 'BUY' ? event.token_out : event.token_in;
    const quoteMint = side === 'BUY' ? event.token_in : event.token_out;
    if (blockedTokens.has(baseMint)) {
      skipped.push({ event_id: event.event_id, reason: 'TOKEN_ACCOUNTING_BLOCKED', token_mint: baseMint });
      continue;
    }

    if (side === 'BUY') {
      const lots = lotsByMint.get(baseMint) || [];
      lots.push({
        event_id: event.event_id,
        remaining_quantity_raw: event.amount_out_raw,
        remaining_cost_minor: event.amount_usd_minor
      });
      lotsByMint.set(baseMint, lots);
      continue;
    }

    const lots = lotsByMint.get(baseMint) || [];
    const result = consumeFifo(lots, event.amount_in_raw);
    if (!result.fulfilled) {
      const reason = 'INSUFFICIENT_FIFO_INVENTORY';
      blockedTokens.set(baseMint, reason);
      issues.push({
        event_id: event.event_id,
        token_mint: baseMint,
        reason,
        inventory_scope: INVENTORY_SCOPE,
        missing_quantity_raw: result.remaining.toString(),
        reconciliation_ready: false,
        evidence_ready: false,
        live_execution_authorized: false
      });
      lotsByMint.set(baseMint, []);
      continue;
    }
    lotsByMint.set(baseMint, lots);
    const proceeds = event.amount_usd_minor;
    const grossPnl = proceeds - result.cost;
    const hashPayload = {
      schema_version: 1,
      accounting_method: 'FIFO_COST_BASIS_V1',
      inventory_scope: INVENTORY_SCOPE,
      event_id: event.event_id,
      source_signature: event.tx_hash,
      source_slot: event.slot,
      base_mint: baseMint,
      quote_mint: quoteMint,
      quantity_raw: event.amount_in_raw.toString(),
      proceeds_minor: safeNumberMinor(proceeds),
      cost_basis_minor: safeNumberMinor(result.cost),
      gross_realized_pnl_minor: safeNumberMinor(grossPnl),
      source_lots: result.sourceLots
    };
    candidates.push({
      ...hashPayload,
      accounting_hash: canonicalHash(hashPayload),
      observed_at: event.observed_at,
      status: 'PENDING_FEES_AND_EQUITY',
      fee_minor: null,
      net_realized_pnl_minor: null,
      equity_after_minor: null,
      capital_minor: null,
      valuation_reference: null,
      reconciliation_ready: false,
      evidence_ready: false,
      verified: false,
      published: false,
      live_execution_authorized: false
    });
  }

  const openLots = {};
  for (const [mint, lots] of [...lotsByMint.entries()].sort(([a],[b]) => a.localeCompare(b))) {
    openLots[mint] = lots.map(lot => ({
      event_id: lot.event_id,
      remaining_quantity_raw: lot.remaining_quantity_raw.toString(),
      remaining_cost_minor: safeNumberMinor(lot.remaining_cost_minor)
    }));
  }

  return {
    accounting_method: 'FIFO_COST_BASIS_V1',
    inventory_scope: INVENTORY_SCOPE,
    usd_minor_scale: Number(USD_SCALE),
    trader_wallet: normalized[0]?.trader_wallet || null,
    candidates,
    issues,
    skipped,
    blocked_tokens: [...blockedTokens.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([token_mint, reason]) => ({token_mint, reason})),
    open_lots: openLots,
    reconciliation_ready: false,
    evidence_ready: false,
    live_execution_authorized: false
  };
}
