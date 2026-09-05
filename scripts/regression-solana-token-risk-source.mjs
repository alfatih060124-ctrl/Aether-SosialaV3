import assert from 'node:assert/strict';
import { createSolanaTokenRiskSource, SOLANA_TOKEN_RISK_SOURCE } from '../services/api/src/solana-token-risk-source.mjs';

const mint = 'TokenMint111111111111111111111111111111111';
const nowMs = Date.parse('2026-09-06T00:00:00.000Z');
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function mintData({ mintAuthority = false, freezeAuthority = false } = {}) {
  const buffer = Buffer.alloc(82);
  buffer.writeUInt32LE(mintAuthority ? 1 : 0, 0);
  buffer[44] = 6;
  buffer[45] = 1;
  buffer.writeUInt32LE(freezeAuthority ? 1 : 0, 46);
  return buffer.toString('base64');
}

function tokenAccountData(ownerByte, amount) {
  const buffer = Buffer.alloc(165);
  Buffer.alloc(32, ownerByte).copy(buffer, 32);
  buffer.writeBigUInt64LE(BigInt(amount), 64);
  return buffer.toString('base64');
}

function mintBirthTransaction(blockTime) {
  return {
    blockTime,
    meta: { err: null },
    transaction: { message: { instructions: [
      { program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'createAccount', info: { newAccount: mint } } },
      { program: 'spl-token', programId: SPL, parsed: { type: 'initializeMint2', info: { mint } } }
    ] } }
  };
}

function unrelatedTransaction(blockTime) {
  return {
    blockTime,
    meta: { err: null },
    transaction: { message: { instructions: [
      { program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: {} } }
    ] } }
  };
}

function createRpcFetch({ authorities = {}, fullSignaturePage = false, birthProof = true } = {}) {
  return async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    let result;
    if (method === 'getTokenSupply') result = { value: { amount: '100000000', decimals: 6 } };
    else if (method === 'getProgramAccounts') result = [
      { pubkey: 'a1', account: { owner: SPL, data: [tokenAccountData(1, '8000000'), 'base64'] } },
      { pubkey: 'a2', account: { owner: SPL, data: [tokenAccountData(1, '7000000'), 'base64'] } },
      { pubkey: 'b1', account: { owner: SPL, data: [tokenAccountData(2, '5000000'), 'base64'] } },
      { pubkey: 'c1', account: { owner: SPL, data: [tokenAccountData(3, '3000000'), 'base64'] } }
    ];
    else if (method === 'getAccountInfo') result = { value: { owner: SPL, data: [mintData(authorities), 'base64'] } };
    else if (method === 'getSlot') result = 500;
    else if (method === 'getBlockTime') result = Math.floor(nowMs / 1000) - 1;
    else if (method === 'getSignaturesForAddress') {
      result = fullSignaturePage
        ? Array.from({ length: 1000 }, (_, index) => ({ signature: `sig-${index}`, blockTime: Math.floor(nowMs / 1000) - 90_000 - index, err: null }))
        : [
            { signature: 'newer', blockTime: Math.floor(nowMs / 1000) - 3_600, err: null },
            { signature: 'birth', blockTime: Math.floor(nowMs / 1000) - 90_000, err: null },
            { signature: 'old-unrelated', blockTime: Math.floor(nowMs / 1000) - 100_000, err: null },
            { signature: 'old-failed', blockTime: Math.floor(nowMs / 1000) - 200_000, err: { InstructionError: [0, 'Custom'] } }
          ];
    } else if (method === 'getTransaction') {
      const signature = params[0];
      result = signature === 'birth' && birthProof
        ? mintBirthTransaction(Math.floor(nowMs / 1000) - 90_000)
        : unrelatedTransaction(signature === 'old-unrelated' ? Math.floor(nowMs / 1000) - 100_000 : Math.floor(nowMs / 1000) - 3_600);
    } else throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

const source = createSolanaTokenRiskSource({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: createRpcFetch(),
  now: () => nowMs,
  maxSignaturePages: 2
});
const evidence = await source({ token_mint: mint });
assert.equal(evidence.verified, true);
assert.equal(evidence.top10_holder_pct, 23);
assert.equal(Math.round(evidence.token_age_hours), 25);
assert.equal(evidence.token_birth_signature, 'birth');
assert.equal(evidence.holder_aggregation_basis, 'ALL_CLASSIC_SPL_TOKEN_ACCOUNTS_BY_OWNER');
assert.equal(evidence.token_birth_proof, 'SUCCESSFUL_CREATE_AND_INITIALIZE_MINT_TRANSACTION');
assert.equal(evidence.transferable, true);
assert.deepEqual(evidence.risk_flags, []);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(SOLANA_TOKEN_RISK_SOURCE.holder_concentration_from_all_token_accounts_grouped_by_owner, true);
assert.equal(SOLANA_TOKEN_RISK_SOURCE.token_age_from_verified_mint_initialization_transaction, true);

const authoritySource = createSolanaTokenRiskSource({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: createRpcFetch({ authorities: { mintAuthority: true, freezeAuthority: true } }),
  now: () => nowMs
});
const authorityEvidence = await authoritySource({ token_mint: mint });
assert.deepEqual(authorityEvidence.risk_flags, ['MINT_AUTHORITY_PRESENT', 'FREEZE_AUTHORITY_PRESENT']);

const unprovenBirth = createSolanaTokenRiskSource({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: createRpcFetch({ birthProof: false }),
  now: () => nowMs
});
await assert.rejects(() => unprovenBirth({ token_mint: mint }), /solana_token_risk_token_birth_unverified/);

const incomplete = createSolanaTokenRiskSource({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: createRpcFetch({ fullSignaturePage: true }),
  now: () => nowMs,
  maxSignaturePages: 1
});
await assert.rejects(() => incomplete({ token_mint: mint }), /solana_token_risk_signature_history_incomplete/);

console.log('solana token risk source regression: PASS');
