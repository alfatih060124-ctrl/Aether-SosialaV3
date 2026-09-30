import crypto from 'node:crypto';

const SCHEMA = 'aether.solana_rpc.cluster_identity_evidence.v1';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const ENDPOINT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function canonicalIso(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be an ISO timestamp string`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${field} must be canonical ISO-8601 UTC`);
  }
  return value;
}

function canonicalGenesisHash(value, field) {
  if (typeof value !== 'string' || !BASE58_RE.test(value)) {
    throw new TypeError(`${field} must be canonical Base58 text`);
  }
  return value;
}

function canonicalEndpointLabel(value) {
  if (typeof value !== 'string' || !ENDPOINT_LABEL_RE.test(value)) {
    throw new TypeError('rpc_endpoint_label must be an opaque identifier');
  }
  return value;
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildSolanaRpcClusterEvidence({
  expected_genesis_hash,
  returned_genesis_hash,
  rpc_endpoint_label,
  request_started_at,
  observed_at,
}) {
  const expected = canonicalGenesisHash(expected_genesis_hash, 'expected_genesis_hash');
  const returned = canonicalGenesisHash(returned_genesis_hash, 'returned_genesis_hash');
  const endpoint = canonicalEndpointLabel(rpc_endpoint_label);
  const started = canonicalIso(request_started_at, 'request_started_at');
  const observed = canonicalIso(observed_at, 'observed_at');
  if (Date.parse(observed) < Date.parse(started)) throw new RangeError('observed_at cannot precede request_started_at');

  const provenance = {
    schema: SCHEMA,
    source_type: 'SOLANA_RPC',
    rpc_method: 'getGenesisHash',
    rpc_endpoint_label: endpoint,
    expected_genesis_hash: expected,
    returned_genesis_hash: returned,
    request_started_at: started,
    observed_at: observed,
  };

  const cluster_identity_match = expected === returned;
  return {
    ...provenance,
    provenance_hash: hashCanonical(provenance),
    cluster_identity_match,
    collection_status: 'PENDING_DATA',
    status_reason: cluster_identity_match
      ? 'cluster_identity_corroborated_reconciliation_required'
      : 'cluster_identity_mismatch',
    source_reference: null,
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
  };
}

export async function collectSolanaRpcClusterEvidence({
  rpc,
  expected_genesis_hash,
  rpc_endpoint_label,
  clock = () => new Date(),
}) {
  if (!rpc || typeof rpc.call !== 'function') throw new TypeError('rpc.call is required');
  canonicalGenesisHash(expected_genesis_hash, 'expected_genesis_hash');
  canonicalEndpointLabel(rpc_endpoint_label);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  const requestStarted = clock();
  if (!(requestStarted instanceof Date) || Number.isNaN(requestStarted.getTime())) throw new TypeError('clock must return valid Date');
  const response = await rpc.call('getGenesisHash', []);
  const observed = clock();
  if (!(observed instanceof Date) || Number.isNaN(observed.getTime())) throw new TypeError('clock must return valid Date');

  if (!response || typeof response !== 'object' || typeof response.result !== 'string') {
    throw new TypeError('getGenesisHash response must contain string result');
  }

  return buildSolanaRpcClusterEvidence({
    expected_genesis_hash,
    returned_genesis_hash: response.result,
    rpc_endpoint_label,
    request_started_at: requestStarted.toISOString(),
    observed_at: observed.toISOString(),
  });
}

export function verifySolanaRpcClusterEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  try {
    const rebuilt = buildSolanaRpcClusterEvidence(evidence);
    return evidence.schema === SCHEMA
      && evidence.provenance_hash === rebuilt.provenance_hash
      && evidence.cluster_identity_match === rebuilt.cluster_identity_match
      && evidence.collection_status === 'PENDING_DATA'
      && evidence.source_reference === null
      && evidence.metrics_available === false
      && evidence.trades_count === null
      && evidence.total_return_bps === null
      && evidence.win_rate_bps === null
      && evidence.drawdown_bps === null
      && evidence.reputation_score === null
      && evidence.verified === false
      && evidence.published === false
      && evidence.live_execution_authorized === false;
  } catch {
    return false;
  }
}
