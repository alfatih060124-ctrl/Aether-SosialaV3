const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finite = value => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

function u32le(buffer, offset) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + 4) throw new Error('solana_token_risk_mint_layout_invalid');
  return buffer.readUInt32LE(offset);
}

function parseClassicMint(base64) {
  const buffer = Buffer.from(text(base64, 'solana_token_risk_mint_data_required'), 'base64');
  if (buffer.length < 82) throw new Error('solana_token_risk_mint_layout_invalid');
  const mintAuthorityOption = u32le(buffer, 0);
  const decimals = buffer[44];
  const initialized = buffer[45] === 1;
  const freezeAuthorityOption = u32le(buffer, 46);
  if (![0, 1].includes(mintAuthorityOption) || ![0, 1].includes(freezeAuthorityOption)) {
    throw new Error('solana_token_risk_mint_layout_invalid');
  }
  return { mintAuthorityOption, freezeAuthorityOption, decimals, initialized };
}

async function rpcCall(fetchImpl, rpcUrl, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`solana_token_risk_rpc_http_${response?.status || 'error'}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(`solana_token_risk_rpc_${method}_failed`);
    if (payload?.result === undefined || payload?.result === null) throw new Error(`solana_token_risk_rpc_${method}_missing`);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function oldestMintSignature({ fetchImpl, rpcUrl, mint, timeoutMs, maxSignaturePages }) {
  const limit = 1000;
  let before;
  let oldest = null;
  for (let page = 0; page < maxSignaturePages; page += 1) {
    const options = { limit, commitment: 'confirmed' };
    if (before) options.before = before;
    const rows = await rpcCall(fetchImpl, rpcUrl, 'getSignaturesForAddress', [mint, options], timeoutMs);
    if (!Array.isArray(rows)) throw new Error('solana_token_risk_signature_history_invalid');
    for (const row of rows) {
      const blockTime = finite(row?.blockTime);
      if (blockTime !== null && blockTime > 0 && (!oldest || blockTime < oldest.blockTime)) {
        oldest = { signature: String(row.signature || ''), blockTime };
      }
    }
    if (rows.length < limit) return oldest;
    before = String(rows.at(-1)?.signature || '');
    if (!before) throw new Error('solana_token_risk_signature_cursor_invalid');
  }
  throw new Error('solana_token_risk_signature_history_incomplete');
}

export function createSolanaTokenRiskSource({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 4_000,
  maxSignaturePages = 8
} = {}) {
  const endpoint = text(rpcUrl, 'solana_token_risk_rpc_url_required');
  if (typeof fetchImpl !== 'function') throw new Error('solana_token_risk_fetch_required');
  if (!Number.isInteger(maxSignaturePages) || maxSignaturePages < 1 || maxSignaturePages > 50) {
    throw new Error('solana_token_risk_signature_pages_invalid');
  }

  return async function loadTokenRiskSource({ token_mint } = {}) {
    const mint = text(token_mint, 'solana_token_risk_mint_required');
    const [supplyResult, holdersResult, accountResult, slotResult, oldest] = await Promise.all([
      rpcCall(fetchImpl, endpoint, 'getTokenSupply', [mint, { commitment: 'confirmed' }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getSlot', [{ commitment: 'confirmed' }], timeoutMs),
      oldestMintSignature({ fetchImpl, rpcUrl: endpoint, mint, timeoutMs, maxSignaturePages })
    ]);

    const totalSupply = BigInt(text(supplyResult?.value?.amount, 'solana_token_risk_supply_required'));
    if (totalSupply <= 0n) throw new Error('solana_token_risk_supply_invalid');
    if (!Array.isArray(holdersResult?.value) || holdersResult.value.length < 1) throw new Error('solana_token_risk_holders_required');
    const top10 = holdersResult.value.slice(0, 10).reduce((sum, row) => {
      const amount = BigInt(text(row?.amount, 'solana_token_risk_holder_amount_required'));
      if (amount < 0n) throw new Error('solana_token_risk_holder_amount_invalid');
      return sum + amount;
    }, 0n);
    const top10HolderPct = Number((top10 * 1_000_000n) / totalSupply) / 10_000;
    if (!Number.isFinite(top10HolderPct) || top10HolderPct < 0 || top10HolderPct > 100) {
      throw new Error('solana_token_risk_holder_concentration_invalid');
    }

    const account = accountResult?.value;
    if (!account || String(account.owner || '') !== SPL_TOKEN_PROGRAM_ID) {
      throw new Error('solana_token_risk_non_classic_spl_fail_closed');
    }
    if (!Array.isArray(account.data) || account.data[1] !== 'base64') throw new Error('solana_token_risk_mint_data_invalid');
    const mintState = parseClassicMint(account.data[0]);
    if (mintState.initialized !== true) throw new Error('solana_token_risk_mint_uninitialized');

    const slot = Number(slotResult);
    if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('solana_token_risk_slot_invalid');
    const observedBlockTime = Number(await rpcCall(fetchImpl, endpoint, 'getBlockTime', [slot], timeoutMs));
    if (!Number.isFinite(observedBlockTime) || observedBlockTime <= 0) throw new Error('solana_token_risk_block_time_required');
    if (!oldest?.blockTime) throw new Error('solana_token_risk_token_birth_unverified');
    const currentMs = Number(now());
    if (!Number.isFinite(currentMs)) throw new Error('solana_token_risk_now_invalid');
    const tokenAgeHours = (currentMs - oldest.blockTime * 1000) / 3_600_000;
    if (!Number.isFinite(tokenAgeHours) || tokenAgeHours < 0) throw new Error('solana_token_risk_token_age_invalid');

    const riskFlags = [];
    if (mintState.mintAuthorityOption === 1) riskFlags.push('MINT_AUTHORITY_PRESENT');
    if (mintState.freezeAuthorityOption === 1) riskFlags.push('FREEZE_AUTHORITY_PRESENT');

    return Object.freeze({
      verified: true,
      source: 'SOLANA_CONFIRMED_RPC_TOKEN_RISK',
      source_reference: `SOLANA_RPC_SLOT_${slot}_MINT_${mint}`,
      observed_at: new Date(observedBlockTime * 1000).toISOString(),
      top10_holder_pct: top10HolderPct,
      token_age_hours: tokenAgeHours,
      transferable: true,
      risk_flags: Object.freeze(riskFlags),
      mint_authority_present: mintState.mintAuthorityOption === 1,
      freeze_authority_present: mintState.freezeAuthorityOption === 1,
      mint_decimals: mintState.decimals,
      token_birth_signature: oldest.signature || null,
      token_birth_block_time: oldest.blockTime,
      read_only: true,
      transaction_building_authorized: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  };
}

export const SOLANA_TOKEN_RISK_SOURCE = Object.freeze({
  source: 'SOLANA_CONFIRMED_RPC_TOKEN_RISK',
  classic_spl_only: true,
  holder_concentration_from_rpc: true,
  token_age_from_mint_signature_history: true,
  mint_and_freeze_authorities_flagged: true,
  read_only: true,
  live_execution_authorized: false
});
