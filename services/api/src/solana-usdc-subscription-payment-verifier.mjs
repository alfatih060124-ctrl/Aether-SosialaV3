function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function httpsUrl(value) {
  const url = new URL(text(value, 'subscription_rpc_url_required'));
  if (url.protocol !== 'https:') throw new Error('subscription_rpc_https_required');
  return url.href;
}

function amount(value, code) {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function balanceMap(rows, mint) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.mint || '') !== mint) continue;
    const owner = String(row?.owner || '').trim();
    if (!owner) continue;
    const value = amount(row?.uiTokenAmount?.amount ?? '0', 'subscription_token_balance_invalid');
    map.set(owner, (map.get(owner) || 0n) + value);
  }
  return map;
}

export function createSolanaUsdcSubscriptionPaymentVerifier({
  rpcUrl = process.env.SOLANA_RPC_URL,
  fetchImpl = globalThis.fetch,
  configuredUsdcMint,
  configuredTreasuryWallet,
  timeoutMs = 8000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('subscription_rpc_fetch_required');
  const endpoint = httpsUrl(rpcUrl);
  const usdcMint = text(configuredUsdcMint, 'subscription_usdc_mint_required');
  const treasuryWallet = text(configuredTreasuryWallet, 'subscription_treasury_wallet_required');

  async function rpc(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(15000, Number(timeoutMs) || 8000)));
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
        redirect: 'error'
      });
      if (!response.ok) throw new Error(`subscription_rpc_http_${response.status}`);
      const body = await response.json();
      if (body?.error) throw new Error(`subscription_rpc_${method}_error`);
      return body?.result ?? null;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('subscription_rpc_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async verify({ signature, member_wallet, expected_amount_usdc_atomic } = {}) {
      const txSignature = text(signature, 'subscription_payment_signature_required');
      const memberWallet = text(member_wallet, 'subscription_member_wallet_required');
      const expected = amount(expected_amount_usdc_atomic, 'subscription_expected_amount_invalid');
      if (expected <= 0n) throw new Error('subscription_expected_amount_invalid');

      const statuses = await rpc('getSignatureStatuses', [[txSignature], { searchTransactionHistory: true }]);
      const status = statuses?.value?.[0];
      if (!status) throw new Error('subscription_payment_signature_not_found');
      if (status.err !== null && status.err !== undefined) throw new Error('subscription_payment_transaction_failed');
      if (status.confirmationStatus !== 'finalized') throw new Error('subscription_payment_not_finalized');

      const tx = await rpc('getTransaction', [txSignature, {
        commitment: 'finalized',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0
      }]);
      if (!tx || typeof tx !== 'object') throw new Error('subscription_payment_transaction_missing');
      if (tx.meta?.err !== null && tx.meta?.err !== undefined) throw new Error('subscription_payment_transaction_failed');
      const signatures = Array.isArray(tx.transaction?.signatures) ? tx.transaction.signatures.map(String) : [];
      if (!signatures.includes(txSignature)) throw new Error('subscription_payment_signature_mismatch');

      const pre = balanceMap(tx.meta?.preTokenBalances, usdcMint);
      const post = balanceMap(tx.meta?.postTokenBalances, usdcMint);
      const senderBefore = pre.get(memberWallet) || 0n;
      const senderAfter = post.get(memberWallet) || 0n;
      const treasuryBefore = pre.get(treasuryWallet) || 0n;
      const treasuryAfter = post.get(treasuryWallet) || 0n;
      const senderDelta = senderAfter - senderBefore;
      const treasuryDelta = treasuryAfter - treasuryBefore;

      if (senderDelta !== -expected) throw new Error('subscription_payment_sender_amount_mismatch');
      if (treasuryDelta !== expected) throw new Error('subscription_payment_treasury_amount_mismatch');
      if (!Number.isSafeInteger(Number(tx.slot)) || Number(tx.slot) < 1) throw new Error('subscription_payment_slot_invalid');
      if (!Number.isFinite(Number(tx.blockTime)) || Number(tx.blockTime) <= 0) throw new Error('subscription_payment_block_time_invalid');

      return Object.freeze({
        verified: true,
        finalized: true,
        success: true,
        signature: txSignature,
        sender_wallet: memberWallet,
        recipient_wallet: treasuryWallet,
        mint: usdcMint,
        amount_usdc_atomic: expected.toString(),
        slot: Number(tx.slot),
        block_time: Number(tx.blockTime),
        source: 'SOLANA_FINALIZED_RPC',
        source_reference: `SOLANA_TX:${txSignature}:${tx.slot}`,
        transaction_submission_authorized: false,
        signing_authorized: false,
        funds_movement_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}

export const SOLANA_USDC_SUBSCRIPTION_PAYMENT_VERIFIER = Object.freeze({
  rpc_methods: Object.freeze(['getSignatureStatuses', 'getTransaction']),
  finalized_required: true,
  exact_amount_required: true,
  member_sender_required: true,
  treasury_recipient_required: true,
  configured_usdc_mint_required: true,
  replay_protection_requires_unique_persistence: true,
  transaction_submission_authorized: false,
  signing_authorized: false,
  live_execution_authorized: false
});
