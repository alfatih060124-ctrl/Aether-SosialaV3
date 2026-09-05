import assert from 'node:assert/strict';
import { createSolanaTokenRiskSource, SOLANA_TOKEN_RISK_SOURCE } from '../services/api/src/solana-token-risk-source.mjs';

const mint = 'TokenMint111111111111111111111111111111111';
const nowMs = Date.parse('2026-09-06T00:00:00.000Z');

function mintData({ mintAuthority = false, freezeAuthority = false } = {}) {
  const buffer = Buffer.alloc(82);
  buffer.writeUInt32LE(mintAuthority ? 1 : 0, 0);
  buffer[44] = 6;
  buffer[45] = 1;
  buffer.writeUInt32LE(freezeAuthority ? 1 : 0, 46);
  return buffer.toString('base64');
}

function createRpcFetch({ authorities = {}, fullSignaturePage = false } = {}) {
  return async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    let result;
    if (method === 'getTokenSupply') result = { value: { amount: '100000000', decimals: 6 } };
    else if (method === 'getTokenLargestAccounts') result = { value: [
      { amount: '8000000' }, { amount: '5000000' }, { amount: '3000000' }, { amount: '2000000' }, { amount: '2000000' }
    ] };
    else if (method === 'getAccountInfo') result = { value: {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: [mintData(authorities), 'base64']
    } };
    else if (method === 'getSlot') result = 500;
    else if (method === 'getBlockTime') result = Math.floor(nowMs / 1000) - 1;
    else if (method === 'getSignaturesForAddress') {
      result = fullSignaturePage
        ? Array.from({ length: 1000 }, (_, index) => ({ signature: `sig-${index}`, blockTime: Math.floor(nowMs / 1000) - 90_000 - index }))
        : [
            { signature: 'newer', blockTime: Math.floor(nowMs / 1000) - 3_600 },
            { signature: 'birth', blockTime: Math.floor(nowMs / 1000) - 90_000 }
          ];
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
assert.equal(evidence.top10_holder_pct, 20);
assert.equal(Math.round(evidence.token_age_hours), 25);
assert.equal(evidence.transferable, true);
assert.deepEqual(evidence.risk_flags, []);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(SOLANA_TOKEN_RISK_SOURCE.classic_spl_only, true);

const authoritySource = createSolanaTokenRiskSource({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: createRpcFetch({ authorities: { mintAuthority: true, freezeAuthority: true } }),
  now: () => nowMs
});
const authorityEvidence = await authoritySource({ token_mint: mint });
assert.deepEqual(authorityEvidence.risk_flags, ['MINT_AUTHORITY_PRESENT', 'FREEZE_AUTHORITY_PRESENT']);

const incomplete = createSolanaTokenRiskSource({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: createRpcFetch({ fullSignaturePage: true }),
  now: () => nowMs,
  maxSignaturePages: 1
});
await assert.rejects(() => incomplete({ token_mint: mint }), /solana_token_risk_signature_history_incomplete/);

console.log('solana token risk source regression: PASS');
