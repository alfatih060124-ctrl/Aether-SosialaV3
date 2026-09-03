const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnKdnX9KmpzTt';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const LAMPORTS_PER_SOL = 1_000_000_000;

function assertWalletAddress(value) {
  const wallet = String(value || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error('invalid_wallet_address');
  return wallet;
}

function uiAmount(tokenAmount = {}) {
  const fromRpc = Number(tokenAmount.uiAmountString ?? tokenAmount.uiAmount);
  if (Number.isFinite(fromRpc)) return fromRpc;
  const raw = Number(tokenAmount.amount);
  const decimals = Number(tokenAmount.decimals || 0);
  if (!Number.isFinite(raw) || !Number.isFinite(decimals)) return 0;
  return raw / (10 ** decimals);
}

function tokenRows(result, program) {
  const rows = Array.isArray(result?.value) ? result.value : [];
  return rows.map(row => {
    const info = row?.account?.data?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!info?.mint || !tokenAmount) return null;
    return {
      mint: String(info.mint),
      amount: uiAmount(tokenAmount),
      amount_raw: String(tokenAmount.amount ?? '0'),
      decimals: Number(tokenAmount.decimals || 0),
      token_program: program,
    };
  }).filter(Boolean);
}

function aggregateTokens(rows) {
  const byMint = new Map();
  for (const row of rows) {
    const current = byMint.get(row.mint) || { ...row, amount: 0, accounts: 0 };
    current.amount += Number(row.amount || 0);
    current.accounts += 1;
    byMint.set(row.mint, current);
  }
  return [...byMint.values()].filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount);
}

function labelAsset(row) {
  if (row.mint === USDC_MINT) return { ...row, symbol: 'USDC', role: 'PRIMARY_TRADING_CURRENCY' };
  if (row.mint === USDT_MINT) return { ...row, symbol: 'USDT', role: 'OPTIONAL_STABLE_ASSET' };
  return { ...row, symbol: null, role: 'SPL_ASSET' };
}

export function createWalletPortfolioService({ rpcUrl = process.env.SOLANA_RPC_URL, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 6500, cacheTtlMs = 15000 } = {}) {
  const cache = new Map();
  let rpcId = 0;

  async function rpc(method, params) {
    if (!rpcUrl) throw new Error('solana_rpc_unconfigured');
    if (typeof fetchImpl !== 'function') throw new Error('solana_rpc_unavailable');
    let endpoint;
    try { endpoint = new URL(rpcUrl); } catch { throw new Error('solana_rpc_unconfigured'); }
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('solana_rpc_unconfigured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('solana_rpc_http_error');
      const payload = await response.json();
      if (payload?.error) throw new Error('solana_rpc_error');
      return payload?.result;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
      if (['solana_rpc_http_error', 'solana_rpc_error'].includes(error?.message)) throw error;
      throw new Error('solana_rpc_error');
    } finally {
      clearTimeout(timer);
    }
  }

  async function getPortfolio(walletAddress, { force = false } = {}) {
    const wallet = assertWalletAddress(walletAddress);
    const cached = cache.get(wallet);
    if (!force && cached && Date.now() - cached.cachedAt < cacheTtlMs) return { ...cached.value, cached: true };

    const [balanceResult, classicResult, token2022Result] = await Promise.all([
      rpc('getBalance', [wallet, { commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    ]);

    const lamports = Number(balanceResult?.value);
    if (!Number.isFinite(lamports) || lamports < 0) throw new Error('solana_rpc_error');
    const assets = aggregateTokens([
      ...tokenRows(classicResult, 'SPL_TOKEN'),
      ...tokenRows(token2022Result, 'TOKEN_2022'),
    ]).map(labelAsset);
    const usdc = assets.find(asset => asset.mint === USDC_MINT);
    const usdt = assets.find(asset => asset.mint === USDT_MINT);

    const value = {
      wallet,
      network: 'SOLANA_MAINNET',
      source: 'SOLANA_RPC',
      observed_at: now().toISOString(),
      cached: false,
      read_only: true,
      non_custodial: true,
      signer_required: false,
      transaction_created: false,
      funds_moved: false,
      live_execution_authorized: false,
      base_currency: 'USDC',
      gas_currency: 'SOL',
      balances: {
        sol: { symbol: 'SOL', amount: lamports / LAMPORTS_PER_SOL, lamports: String(Math.trunc(lamports)), role: 'NETWORK_FEE_RESERVE' },
        usdc: { symbol: 'USDC', amount: Number(usdc?.amount || 0), mint: USDC_MINT, role: 'PRIMARY_TRADING_CURRENCY' },
        usdt: { symbol: 'USDT', amount: Number(usdt?.amount || 0), mint: USDT_MINT, role: 'OPTIONAL_STABLE_ASSET' },
      },
      assets,
      available_for_copy_usdc: null,
      available_for_copy_reason: 'MANDATE_RESERVATIONS_NOT_CALCULATED',
    };
    cache.set(wallet, { cachedAt: Date.now(), value });
    return value;
  }

  return { getPortfolio };
}

export const WALLET_PORTFOLIO_CONSTANTS = Object.freeze({ TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC_MINT, USDT_MINT });
