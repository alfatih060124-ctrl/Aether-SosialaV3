const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finite = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
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

function parseClassicTokenAccount(base64) {
  const buffer = Buffer.from(text(base64, 'solana_token_risk_token_account_data_required'), 'base64');
  if (buffer.length !== 165) throw new Error('solana_token_risk_token_account_layout_invalid');
  return {
    ownerKey: buffer.subarray(32, 64).toString('hex'),
    amount: buffer.readBigUInt64LE(64)
  };
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

async function completeMintSignatureHistory({ fetchImpl, rpcUrl, mint, timeoutMs, maxSignaturePages }) {
  const limit = 1000;
  let before;
  const history = [];
  for (let page = 0; page < maxSignaturePages; page += 1) {
    const options = { limit, commitment: 'confirmed' };
    if (before) options.before = before;
    const rows = await rpcCall(fetchImpl, rpcUrl, 'getSignaturesForAddress', [mint, options], timeoutMs);
    if (!Array.isArray(rows)) throw new Error('solana_token_risk_signature_history_invalid');
    for (const row of rows) {
      const signature = String(row?.signature || '').trim();
      const blockTime = finite(row?.blockTime);
      if (signature && row?.err == null && blockTime !== null && blockTime > 0) history.push({ signature, blockTime });
    }
    if (rows.length < limit) return history;
    before = String(rows.at(-1)?.signature || '');
    if (!before) throw new Error('solana_token_risk_signature_cursor_invalid');
  }
  throw new Error('solana_token_risk_signature_history_incomplete');
}

function provesMintInitialization(transaction, mint) {
  if (!transaction || transaction?.meta?.err != null) return false;
  const instructions = transaction?.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return false;
  let created = false;
  let initialized = false;
  for (const instruction of instructions) {
    const parsed = instruction?.parsed;
    const info = parsed?.info || {};
    const type = String(parsed?.type || '');
    const programId = String(instruction?.programId || instruction?.programId?.toString?.() || '');
    const program = String(instruction?.program || '');
    if (
      (program === 'system' || programId === SYSTEM_PROGRAM_ID) &&
      ['createAccount', 'createAccountWithSeed'].includes(type) &&
      String(info.newAccount || '') === mint
    ) created = true;
    if (
      (program === 'spl-token' || programId === SPL_TOKEN_PROGRAM_ID) &&
      ['initializeMint', 'initializeMint2'].includes(type) &&
      String(info.mint || '') === mint
    ) initialized = true;
  }
  return created && initialized;
}

async function verifiedMintBirth({ fetchImpl, rpcUrl, mint, timeoutMs, history, maxInitializationTransactions }) {
  const ordered = [...history].sort((a, b) => a.blockTime - b.blockTime);
  const candidates = ordered.slice(0, maxInitializationTransactions);
  for (const row of candidates) {
    const transaction = await rpcCall(fetchImpl, rpcUrl, 'getTransaction', [row.signature, {
      commitment: 'confirmed',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0
    }], timeoutMs);
    if (provesMintInitialization(transaction, mint)) {
      const blockTime = finite(transaction?.blockTime ?? row.blockTime);
      if (blockTime === null || blockTime <= 0) throw new Error('solana_token_risk_birth_block_time_invalid');
      return { signature: row.signature, blockTime };
    }
  }
  throw new Error('solana_token_risk_token_birth_unverified');
}

function ownerConcentration(programAccounts, totalSupply) {
  if (!Array.isArray(programAccounts) || programAccounts.length < 1) throw new Error('solana_token_risk_token_accounts_required');
  const balances = new Map();
  for (const row of programAccounts) {
    const account = row?.account;
    if (!account || String(account.owner || '') !== SPL_TOKEN_PROGRAM_ID) throw new Error('solana_token_risk_token_account_owner_invalid');
    if (!Array.isArray(account.data) || account.data[1] !== 'base64') throw new Error('solana_token_risk_token_account_data_invalid');
    const parsed = parseClassicTokenAccount(account.data[0]);
    balances.set(parsed.ownerKey, (balances.get(parsed.ownerKey) || 0n) + parsed.amount);
  }
  const top10 = [...balances.values()].sort((a, b) => a === b ? 0 : a > b ? -1 : 1).slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const pct = Number((top10 * 1_000_000n) / totalSupply) / 10_000;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('solana_token_risk_holder_concentration_invalid');
  return pct;
}

export function createSolanaTokenRiskSource({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 4_000,
  maxSignaturePages = 8,
  maxInitializationTransactions = 200
} = {}) {
  const endpoint = text(rpcUrl, 'solana_token_risk_rpc_url_required');
  if (typeof fetchImpl !== 'function') throw new Error('solana_token_risk_fetch_required');
  if (!Number.isInteger(maxSignaturePages) || maxSignaturePages < 1 || maxSignaturePages > 50) {
    throw new Error('solana_token_risk_signature_pages_invalid');
  }
  if (!Number.isInteger(maxInitializationTransactions) || maxInitializationTransactions < 1 || maxInitializationTransactions > 500) {
    throw new Error('solana_token_risk_initialization_scan_invalid');
  }

  return async function loadTokenRiskSource({ token_mint } = {}) {
    const mint = text(token_mint, 'solana_token_risk_mint_required');
    const [supplyResult, programAccounts, accountResult, slotResult, history] = await Promise.all([
      rpcCall(fetchImpl, endpoint, 'getTokenSupply', [mint, { commitment: 'confirmed' }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getProgramAccounts', [SPL_TOKEN_PROGRAM_ID, {
        commitment: 'confirmed',
        encoding: 'base64',
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]
      }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getSlot', [{ commitment: 'confirmed' }], timeoutMs),
      completeMintSignatureHistory({ fetchImpl, rpcUrl: endpoint, mint, timeoutMs, maxSignaturePages })
    ]);

    const totalSupply = BigInt(text(supplyResult?.value?.amount, 'solana_token_risk_supply_required'));
    if (totalSupply <= 0n) throw new Error('solana_token_risk_supply_invalid');
    const top10HolderPct = ownerConcentration(programAccounts, totalSupply);

    const account = accountResult?.value;
    if (!account || String(account.owner || '') !== SPL_TOKEN_PROGRAM_ID) {
      throw new Error('solana_token_risk_non_classic_spl_fail_closed');
    }
    if (!Array.isArray(account.data) || account.data[1] !== 'base64') throw new Error('solana_token_risk_mint_data_invalid');
    const mintState = parseClassicMint(account.data[0]);
    if (mintState.initialized !== true) throw new Error('solana_token_risk_mint_uninitialized');

    const birth = await verifiedMintBirth({
      fetchImpl,
      rpcUrl: endpoint,
      mint,
      timeoutMs,
      history,
      maxInitializationTransactions
    });
    const slot = Number(slotResult);
    if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('solana_token_risk_slot_invalid');
    const observedBlockTime = Number(await rpcCall(fetchImpl, endpoint, 'getBlockTime', [slot], timeoutMs));
    if (!Number.isFinite(observedBlockTime) || observedBlockTime <= 0) throw new Error('solana_token_risk_block_time_required');
    const currentMs = Number(now());
    if (!Number.isFinite(currentMs)) throw new Error('solana_token_risk_now_invalid');
    const tokenAgeHours = (currentMs - birth.blockTime * 1000) / 3_600_000;
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
      token_birth_signature: birth.signature,
      token_birth_block_time: birth.blockTime,
      holder_aggregation_basis: 'ALL_CLASSIC_SPL_TOKEN_ACCOUNTS_BY_OWNER',
      token_birth_proof: 'SUCCESSFUL_CREATE_AND_INITIALIZE_MINT_TRANSACTION',
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
  holder_concentration_from_all_token_accounts_grouped_by_owner: true,
  token_age_from_verified_mint_initialization_transaction: true,
  mint_and_freeze_authorities_flagged: true,
  read_only: true,
  live_execution_authorized: false
});
