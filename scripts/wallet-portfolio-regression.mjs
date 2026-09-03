import assert from 'node:assert/strict';
import { createWalletPortfolioService, WALLET_PORTFOLIO_CONSTANTS } from '../services/api/src/wallet-portfolio.mjs';

const wallet = '11111111111111111111111111111111';
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC_MINT, USDT_MINT } = WALLET_PORTFOLIO_CONSTANTS;

function tokenAccount(mint, amount, decimals = 6) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount: String(Math.round(amount * (10 ** decimals))),
              decimals,
              uiAmountString: String(amount),
            },
          },
        },
      },
    },
  };
}

const fakeFetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  let result;
  if (body.method === 'getBalance') {
    result = { value: 2_500_000_000 };
  } else if (body.method === 'getTokenAccountsByOwner') {
    const program = body.params?.[1]?.programId;
    if (program === TOKEN_PROGRAM_ID) {
      result = { value: [tokenAccount(USDC_MINT, 125.5), tokenAccount(USDT_MINT, 10), tokenAccount('So11111111111111111111111111111111111111112', 0, 9)] };
    } else if (program === TOKEN_2022_PROGRAM_ID) {
      result = { value: [tokenAccount('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnKdnX9KmpzTt', 42, 2)] };
    } else {
      throw new Error('unexpected_program');
    }
  } else {
    throw new Error('unexpected_rpc_method');
  }
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
};

const service = createWalletPortfolioService({
  rpcUrl: 'https://rpc.example.invalid',
  fetchImpl: fakeFetch,
  now: () => new Date('2026-09-03T13:00:00.000Z'),
  cacheTtlMs: 1,
});
const portfolio = await service.getPortfolio(wallet);
assert.equal(portfolio.wallet, wallet);
assert.equal(portfolio.network, 'SOLANA_MAINNET');
assert.equal(portfolio.source, 'SOLANA_RPC');
assert.equal(portfolio.base_currency, 'USDC');
assert.equal(portfolio.gas_currency, 'SOL');
assert.equal(portfolio.balances.sol.amount, 2.5);
assert.equal(portfolio.balances.usdc.amount, 125.5);
assert.equal(portfolio.balances.usdt.amount, 10);
assert.equal(portfolio.read_only, true);
assert.equal(portfolio.non_custodial, true);
assert.equal(portfolio.signer_required, false);
assert.equal(portfolio.transaction_created, false);
assert.equal(portfolio.funds_moved, false);
assert.equal(portfolio.live_execution_authorized, false);
assert.equal(portfolio.available_for_copy_usdc, null);
assert.equal(portfolio.available_for_copy_reason, 'MANDATE_RESERVATIONS_NOT_CALCULATED');
assert(portfolio.assets.some(asset => asset.role === 'PRIMARY_TRADING_CURRENCY'));
assert(portfolio.assets.some(asset => asset.token_program === 'TOKEN_2022'));
assert(!portfolio.assets.some(asset => asset.amount === 0));

const unconfigured = createWalletPortfolioService({ rpcUrl: '', fetchImpl: fakeFetch });
await assert.rejects(() => unconfigured.getPortfolio(wallet), /solana_rpc_unconfigured/);
await assert.rejects(() => service.getPortfolio('not-a-wallet'), /invalid_wallet_address/);

const rpcFailure = createWalletPortfolioService({
  rpcUrl: 'https://rpc.example.invalid',
  fetchImpl: async () => ({ ok: true, json: async () => ({ error: { code: -32000 } }) }),
});
await assert.rejects(() => rpcFailure.getPortfolio(wallet), /solana_rpc_error/);

console.log('wallet portfolio regression: PASS');
