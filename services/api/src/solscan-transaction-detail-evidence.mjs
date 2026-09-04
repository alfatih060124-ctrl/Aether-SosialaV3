import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET = new Set(B58);
const U64_MAX = (1n << 64n) - 1n;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
function b58len(text) {
  if (typeof text !== 'string' || !text.length) return -1;
  let n = 0n;
  for (const ch of text) { if (!B58_SET.has(ch)) return -1; n = n * 58n + BigInt(B58.indexOf(ch)); }
  let bytes = 0; let x = n;
  while (x > 0n) { bytes += 1; x >>= 8n; }
  let leading = 0;
  while (leading < text.length && text[leading] === '1') leading += 1;
  return bytes + leading;
}
function solId(value, bytes, code) { if (b58len(value) !== bytes) fail(code); return value; }
function safeInt(value, code, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(code);
  return value;
}
function iso(value, code) {
  if (typeof value !== 'string') fail(code);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(code);
  return ms;
}
function label(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) fail('invalid_solscan_source_label');
  return value;
}
function integerText(value, code, { unsigned = false } = {}) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code);
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    fail(code);
  }
  const pattern = unsigned ? /^(0|[1-9][0-9]*)$/ : /^(-?[1-9][0-9]*|0)$/;
  if (!pattern.test(text)) fail(code);
  const n = BigInt(text);
  if (unsigned) {
    if (n < 0n || n > U64_MAX) fail(code);
  } else if (n < -U64_MAX || n > U64_MAX) {
    fail(code);
  }
  return text;
}
function uintText(value, code) { return integerText(value, code, { unsigned: true }); }
function sintText(value, code) { return integerText(value, code); }
function keyList(value, code, { required = false, max = 128 } = {}) {
  if (!Array.isArray(value) || value.length > max || (required && value.length === 0)) fail(code);
  const out = value.map((key, index) => solId(key, 32, `${code}_${index}`));
  if (new Set(out).size !== out.length) fail(`${code}_duplicate`);
  return out;
}
function normalizeSolChanges(value, wallet) {
  if (!Array.isArray(value) || value.length > 256) fail('invalid_sol_balance_changes');
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (!plain(row)) fail(`invalid_sol_balance_change_${i}`);
    const address = solId(row.address, 32, `invalid_sol_balance_address_${i}`);
    if (address !== wallet) continue;
    const pre_balance = uintText(row.pre_balance, `invalid_sol_pre_balance_${i}`);
    const post_balance = uintText(row.post_balance, `invalid_sol_post_balance_${i}`);
    const change_amount = sintText(row.change_amount, `invalid_sol_change_amount_${i}`);
    if (BigInt(post_balance) - BigInt(pre_balance) !== BigInt(change_amount)) fail(`sol_balance_delta_mismatch_${i}`);
    out.push({ address, pre_balance, post_balance, change_amount });
  }
  if (out.length > 1) fail('duplicate_wallet_sol_balance_change');
  return out;
}
function normalizeTokenChanges(value, wallet) {
  if (!Array.isArray(value) || value.length > 512) fail('invalid_token_balance_changes');
  const out = []; const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (!plain(row)) fail(`invalid_token_balance_change_${i}`);
    const address = solId(row.address, 32, `invalid_token_account_${i}`);
    const token_address = solId(row.token_address, 32, `invalid_token_mint_${i}`);
    const owner = row.owner == null ? null : solId(row.owner, 32, `invalid_owner_${i}`);
    const pre_owner = row.pre_owner == null ? null : solId(row.pre_owner, 32, `invalid_pre_owner_${i}`);
    const post_owner = row.post_owner == null ? null : solId(row.post_owner, 32, `invalid_post_owner_${i}`);
    if (owner !== wallet && pre_owner !== wallet && post_owner !== wallet) continue;
    if (seen.has(address)) fail('duplicate_wallet_token_account_change');
    seen.add(address);
    const decimals = safeInt(row.decimals, `invalid_token_decimals_${i}`, { max: 30 });
    const pre_balance = uintText(row.pre_balance, `invalid_token_pre_balance_${i}`);
    const post_balance = uintText(row.post_balance, `invalid_token_post_balance_${i}`);
    const change_amount = sintText(row.change_amount, `invalid_token_change_amount_${i}`);
    if (BigInt(post_balance) - BigInt(pre_balance) !== BigInt(change_amount)) fail(`token_balance_delta_mismatch_${i}`);
    if (row.change_type !== 'inc' && row.change_type !== 'dec') fail(`invalid_token_change_type_${i}`);
    const delta = BigInt(change_amount);
    if ((row.change_type === 'inc' && delta < 0n) || (row.change_type === 'dec' && delta > 0n)) fail(`token_change_type_mismatch_${i}`);
    out.push({ address, token_address, change_type: row.change_type, change_amount, decimals, pre_balance, post_balance, owner, pre_owner, post_owner });
  }
  return out;
}
function normalizeFound(data, signature, wallet, observedMs) {
  if (!plain(data)) fail('invalid_solscan_transaction_detail');
  if (data.tx_hash != null) {
    const echoed = solId(data.tx_hash, 64, 'invalid_returned_tx_hash');
    if (echoed !== signature) fail('transaction_signature_mismatch');
  }
  const slot = safeInt(data.block_id, 'invalid_slot');
  const block_time = safeInt(data.block_time, 'invalid_block_time');
  if (block_time * 1000 > observedMs) fail('future_block_time');
  const fee_lamports = safeInt(data.fee, 'invalid_fee');
  const status = safeInt(data.status, 'invalid_status', { max: 1 });
  const compute_units_consumed = data.compute_units_consumed == null ? null : safeInt(data.compute_units_consumed, 'invalid_compute_units');
  const priority_fee_lamports = data.priority_fee == null ? null : safeInt(data.priority_fee, 'invalid_priority_fee');
  const signers = keyList(data.signer, 'invalid_signers', { required: true });
  if (!signers.includes(wallet)) fail('wallet_not_transaction_signer');
  const programs_involved = keyList(data.programs_involved, 'invalid_programs');
  const sol_balance_changes = normalizeSolChanges(data.sol_bal_change, wallet);
  const token_balance_changes = normalizeTokenChanges(data.token_bal_change, wallet);
  return {
    found: true,
    signature,
    slot,
    block_time,
    status,
    fee_lamports,
    compute_units_consumed,
    priority_fee_lamports,
    signers,
    programs_involved,
    sol_balance_changes,
    token_balance_changes,
    source_reference: `solscan:transaction:${signature}@${slot}`,
  };
}
function missingRow() {
  return { found: false, signature: null, slot: null, block_time: null, status: null, fee_lamports: null, compute_units_consumed: null, priority_fee_lamports: null, signers: [], programs_involved: [], sol_balance_changes: [], token_balance_changes: [], source_reference: null };
}
function envelope(provenanceInput) {
  const provenance = { ...provenanceInput };
  return {
    schema: 'aether.solscan.transaction_detail_evidence.v2',
    collection_status: 'PENDING_DATA',
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    calculation_hash: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    reconciliation_required: true,
    source_reference: provenanceInput.row?.source_reference ?? null,
    row: provenanceInput.row,
    provenance,
    source_hash: hash(provenance),
  };
}

export async function collectSolscanTransactionDetailEvidence({ query, transactionSignature, traderWallet, sourceLabel = 'solscan_pro_v2', requestedAt, observedAt }) {
  if (typeof query !== 'function') fail('solscan_query_required');
  const requested_signature = solId(transactionSignature, 64, 'invalid_transaction_signature');
  const requested_wallet = solId(traderWallet, 32, 'invalid_trader_wallet');
  const source_label = label(sourceLabel);
  const requestedMs = iso(requestedAt, 'invalid_requested_at');
  const observedMs = iso(observedAt, 'invalid_observed_at');
  if (observedMs < requestedMs) fail('invalid_observation_chronology');
  const request = { path: '/v2.0/transaction/detail', tx: requested_signature };
  const response = await query(request);
  if (!plain(response) || response.success !== true || !(response.data === null || plain(response.data))) fail('invalid_solscan_response');
  const row = response.data === null ? missingRow() : normalizeFound(response.data, requested_signature, requested_wallet, observedMs);
  return envelope({ provider: 'SOLSCAN_PRO_V2', source_label, endpoint_path: '/v2.0/transaction/detail', requested_signature, requested_wallet, requested_at: requestedAt, observed_at: observedAt, source_reference_policy: 'PROVIDER_VALIDATED_SIGNATURE_SLOT', row });
}

export function verifySolscanTransactionDetailEvidence(evidence) {
  if (!plain(evidence) || evidence.schema !== 'aether.solscan.transaction_detail_evidence.v2') return false;
  try {
    if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false || evidence.reconciliation_required !== true) return false;
    for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score', 'calculation_hash']) if (evidence[key] !== null) return false;
    const provenance = evidence.provenance;
    if (!plain(provenance) || provenance.provider !== 'SOLSCAN_PRO_V2' || provenance.endpoint_path !== '/v2.0/transaction/detail' || provenance.source_reference_policy !== 'PROVIDER_VALIDATED_SIGNATURE_SLOT') return false;
    solId(provenance.requested_signature, 64, 'bad_signature');
    solId(provenance.requested_wallet, 32, 'bad_wallet');
    label(provenance.source_label);
    const requestedMs = iso(provenance.requested_at, 'bad_req');
    const observedMs = iso(provenance.observed_at, 'bad_obs');
    if (observedMs < requestedMs || !plain(provenance.row)) return false;
    let row;
    if (provenance.row.found === false) {
      row = missingRow();
    } else {
      const provider = {
        block_id: provenance.row.slot,
        block_time: provenance.row.block_time,
        status: provenance.row.status,
        fee: provenance.row.fee_lamports,
        compute_units_consumed: provenance.row.compute_units_consumed,
        priority_fee: provenance.row.priority_fee_lamports,
        signer: provenance.row.signers,
        programs_involved: provenance.row.programs_involved,
        sol_bal_change: provenance.row.sol_balance_changes,
        token_bal_change: provenance.row.token_balance_changes,
      };
      row = normalizeFound(provider, provenance.requested_signature, provenance.requested_wallet, observedMs);
    }
    if (stable(row) !== stable(provenance.row) || stable(evidence.row) !== stable(row) || evidence.source_reference !== row.source_reference) return false;
    return evidence.source_hash === hash(provenance);
  } catch {
    return false;
  }
}
