import assert from 'node:assert/strict';
import { createWalletPortfolioService } from '../services/api/src/wallet-portfolio.mjs';

let fetchCalls = 0;
const service = createWalletPortfolioService({
  rpcUrl: 'https://rpc.invalid',
  fetchImpl: async () => {
    fetchCalls += 1;
    throw new Error('unexpected_rpc_call');
  },
});

const nonCanonical33ByteBase58 = 'z'.repeat(44);

await assert.rejects(
  () => service.getPortfolio(nonCanonical33ByteBase58),
  error => error?.message === 'invalid_wallet_address',
  'wallet portfolio must reject Base58 strings that do not decode to exactly 32 bytes',
);

assert.equal(fetchCalls, 0, 'invalid wallet must fail before any Solana RPC request');

console.log('Wallet portfolio address validation regression: PASS');
