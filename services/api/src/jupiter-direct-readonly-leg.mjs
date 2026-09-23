import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

const JUPITER_PRO_ORIGIN = 'https://api.jup.ag';
const JUPITER_PUBLIC_ORIGIN = 'https://lite-api.jup.ag';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_ACCOUNT_SIZE = 165;

function httpsUrl(value, label) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(label);
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error(label + '_https_required');
  return url.href;
}

function decodeInstruction(value, label) {
  if (!value || typeof value !== 'object') throw new Error(label + '_required');
  const programId = new PublicKey(String(value.programId || ''));
  const keys = (Array.isArray(value.accounts) ? value.accounts : []).map(account => ({
    pubkey: new PublicKey(String(account.pubkey || '')),
    isSigner: account.isSigner === true,
    isWritable: account.isWritable === true
  }));
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(String(value.data || ''), 'base64')
  });
}
async function requestSwapInstructions(fetchImpl, url, body, { apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (apiKey && url.origin === JUPITER_PRO_ORIGIN) headers['x-api-key'] = apiKey;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error'
    });
    if (response.status === 429) throw new Error('jupiter_swap_instructions_rate_limited');
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('jupiter_swap_instructions_http_' + response.status + ':' + detail.slice(0, 120));
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') throw new Error('jupiter_swap_instructions_invalid_payload');
    if (payload.error) throw new Error('jupiter_swap_instructions_build_failed');
    if (!payload.swapInstruction) throw new Error('jupiter_swap_instruction_missing');
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('jupiter_swap_instructions_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export function createJupiterDirectReadonlyLegService({
  fetchImpl = globalThis.fetch,
  apiKey = process.env.JUPITER_API_KEY || '',
  rpcUrl = process.env.SOLANA_RPC_URL || '',
  timeoutMs = 4000,
  preferPublic = String(process.env.AETHER_JUPITER_PREFER_PUBLIC || 'false').toLowerCase() === 'true'
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const safeRpcUrl = httpsUrl(rpcUrl, 'solana_rpc_url_required');
  const connection = new Connection(safeRpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true });
  const safeApiKey = String(apiKey || '').trim();
  const safeTimeoutMs = Math.max(500, Math.min(10_000, Number(timeoutMs) || 4000));
  let tokenAccountRentLamports = null;

  async function rentForTokenAccount() {
    if (tokenAccountRentLamports !== null) return tokenAccountRentLamports;
    const value = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, 'processed');
    tokenAccountRentLamports = Math.max(0, Number(value) || 0);
    return tokenAccountRentLamports;
  }

  async function prepareUnsignedLeg(quoteResult, {
    simulationPublicKey = process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || ''
  } = {}) {
    const quoteResponse = quoteResult?.provider_quote_response || quoteResult?.quote_response || quoteResult;
    if (!quoteResponse || typeof quoteResponse !== 'object') throw new Error('jupiter_provider_quote_required');
    const payer = new PublicKey(String(simulationPublicKey || ''));
    const origin = preferPublic || !safeApiKey ? JUPITER_PUBLIC_ORIGIN : JUPITER_PRO_ORIGIN;
    const url = new URL('/swap/v1/swap-instructions', origin);
    const payload = await requestSwapInstructions(fetchImpl, url, {
      quoteResponse,
      userPublicKey: payer.toBase58(),
      wrapAndUnwrapSol: false,
      useSharedAccounts: false,
      dynamicComputeUnitLimit: false,
      skipUserAccountsRpcCalls: false
    }, { apiKey: safeApiKey, timeoutMs: safeTimeoutMs });

    const setupRaw = Array.isArray(payload.setupInstructions) ? payload.setupInstructions : [];
    const setup = setupRaw.map((value, index) => ({
      raw: value,
      instruction: decodeInstruction(value, 'jupiter_setup_instruction_' + index)
    }));
    const missingAtaAddresses = [];
    const missingAtaInstructions = [];
    const additionalPreInstructions = [];

    const ataRows = setup.filter(row => row.instruction.programId.toBase58() === ATA_PROGRAM_ID);
    const ataAddresses = ataRows.map(row => row.instruction.keys[1]?.pubkey).filter(Boolean);
    const ataInfos = ataAddresses.length
      ? await connection.getMultipleAccountsInfo(ataAddresses, 'processed')
      : [];
    let rent = 0;
    for (const row of setup) {
      if (row.instruction.programId.toBase58() !== ATA_PROGRAM_ID) {
        additionalPreInstructions.push(row.instruction);
        continue;
      }
      const ata = row.instruction.keys[1]?.pubkey || null;
      if (!ata) throw new Error('jupiter_setup_ata_address_missing');
      const index = ataAddresses.findIndex(value => value.equals(ata));
      if (index >= 0 && ataInfos[index]) continue;
      missingAtaAddresses.push(ata.toBase58());
      missingAtaInstructions.push(row.instruction);
    }
    if (missingAtaAddresses.length) rent = await rentForTokenAccount();

    const otherInstructions = (Array.isArray(payload.otherInstructions) ? payload.otherInstructions : [])
      .map((value, index) => decodeInstruction(value, 'jupiter_other_instruction_' + index));
    const swapInstruction = decodeInstruction(payload.swapInstruction, 'jupiter_swap_instruction');
    const cleanupInstructions = payload.cleanupInstruction
      ? [decodeInstruction(payload.cleanupInstruction, 'jupiter_cleanup_instruction')]
      : [];
    const lookupTableAddresses = Array.isArray(payload.addressLookupTableAddresses)
      ? payload.addressLookupTableAddresses.map(String).filter(Boolean)
      : [];

    return Object.freeze({
      payer,
      missing_ata_addresses: missingAtaAddresses,
      missing_ata_rent_lamports: missingAtaAddresses.map(() => rent),
      token_account_rent_lamports: rent,
      pre_instructions: missingAtaInstructions,
      additional_pre_instructions: [...additionalPreInstructions, ...otherInstructions],
      swap_instruction: swapInstruction,
      swap_instructions: [swapInstruction],
      post_instructions: cleanupInstructions,
      address_lookup_table_addresses: lookupTableAddresses,
      native_build_context: Object.freeze({
        kind: 'JUPITER_DIRECT_SWAP_INSTRUCTIONS',
        input_mint: String(quoteResponse.inputMint || ''),
        output_mint: String(quoteResponse.outputMint || ''),
        in_amount: String(quoteResponse.inAmount || ''),
        out_amount: String(quoteResponse.outAmount || '')
      }),
      source: 'JUPITER_DIRECT_SWAP_INSTRUCTIONS',
      read_only: true,
      mode: 'SHADOW',
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  return Object.freeze({
    prepareUnsignedLeg,
    safety: Object.freeze({
      read_only: true,
      transaction_submission: false,
      signer_requested: false,
      live_execution_authorized: false
    })
  });
}