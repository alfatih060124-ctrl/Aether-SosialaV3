import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../services/api/package.json', import.meta.url));
const { Connection, PublicKey } = require('@solana/web3.js');
import { createOrcaReadonlyQuoteService } from '../services/api/src/orca-readonly-quote.mjs';
import { createRaydiumNativeReadonlyQuoteService } from '../services/api/src/raydium-native-readonly-quote.mjs';
import {
  createNativeRoundtripSimulationService,
  resolveReadonlySimulationPublicKey
} from '../services/api/src/native-roundtrip-simulation.mjs';
import { computeExecutableRoundTripEdgeBps, finalizeExpectedNetEdge } from '../services/api/src/cross-venue-net-edge.mjs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const RAYDIUM_SOL_USDC_AMM = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const ORCA_SOL_USDC_WHIRLPOOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const NOTIONAL_RAW = 1_000_000n;

const rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim();
if (!rpcUrl) throw new Error('solana_rpc_url_required');
const connection = new Connection(rpcUrl, 'processed');

function ata(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID
  )[0];
}

async function canonicalUsdcBalance(owner) {
  try {
    const result = await connection.getTokenAccountBalance(ata(owner, new PublicKey(USDC)), 'processed');
    return BigInt(result.value.amount);
  } catch {
    return 0n;
  }
}

async function eligibleOwner(owner) {
  try {
    const [balance, usdc] = await Promise.all([
      connection.getBalance(owner, 'processed'),
      canonicalUsdcBalance(owner)
    ]);
    return balance >= 5_000_000 && usdc >= NOTIONAL_RAW;
  } catch {
    return false;
  }
}

async function findReadonlySimulationOwner() {
  const configured = String(process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '').trim();
  if (configured) {
    try {
      const owner = new PublicKey(configured);
      if (await eligibleOwner(owner)) return { owner, source: 'CONFIGURED_PUBLIC_KEY' };
    } catch {}
  }

  const signatures = await connection.getSignaturesForAddress(new PublicKey(USDC), { limit: 8 }, 'confirmed');
  const owners = [];
  for (const signature of signatures) {
    let tx = null;
    try {
      tx = await connection.getParsedTransaction(signature.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
    } catch {}
    for (const row of tx?.meta?.preTokenBalances || []) {
      if (String(row?.mint || '') !== USDC) continue;
      const amount = BigInt(String(row?.uiTokenAmount?.amount || '0'));
      const ownerString = String(row?.owner || '').trim();
      if (amount < NOTIONAL_RAW || !ownerString) continue;
      try {
        const owner = new PublicKey(ownerString);
        if (!owners.some(item => item.equals(owner))) owners.push(owner);
      } catch {}
    }
    if (owners.length >= 4) break;
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  for (const owner of owners) {
    if (await eligibleOwner(owner)) return { owner, source: 'PUBLIC_CHAIN_RECENT_USDC_OWNER' };
  }
  throw new Error('readonly_simulation_owner_unavailable');
}

function expectedOutput(quote) {
  // The sell leg must use the executable quote's expected output. Slippage
  // protection is encoded in the unsigned transaction threshold; treating the
  // minimum-output guard as the expected fill fabricates a loss before the
  // exact simulation/cost ledger is even evaluated.
  const raw = quote?.outputAmount ?? quote?.outAmount;
  const amount = BigInt(String(raw || '0'));
  if (amount <= 0n) throw new Error('expected_output_unavailable');
  return amount.toString();
}

function routeGross(initialRaw, sellQuote) {
  return computeExecutableRoundTripEdgeBps(initialRaw, sellQuote.outputAmount);
}

const resolvedSimulationOwner = await resolveReadonlySimulationPublicKey({
  rpcUrl,
  preferredPublicKey: String(process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '').trim(),
  inputMint: USDC,
  minimumInputAmount: NOTIONAL_RAW.toString()
});
const simulationOwner = {
  owner: new PublicKey(resolvedSimulationOwner.public_key),
  source: resolvedSimulationOwner.source
};
const owner = simulationOwner.owner.toBase58();
const orca = createOrcaReadonlyQuoteService({
  rpcUrl,
  timeoutMs: 1600,
  poolCacheTtlMs: 10 * 60_000,
  snapshotCacheTtlMs: 2850
});
const raydium = createRaydiumNativeReadonlyQuoteService({ rpcUrl, timeoutMs: 1800, poolSnapshotTtlMs: 200 });
const atomic = createNativeRoundtripSimulationService({ rpcUrl, timeoutMs: 4000 });

const orcaWarm = await orca.warmPair({
  inputMint: USDC,
  outputMint: WSOL,
  poolAddress: ORCA_SOL_USDC_WHIRLPOOL,
  timeoutMs: 10_000
});
// Mirror the production hot path: pool identity alone is not enough. Prime the
// Whirlpool state/tick arrays before the <=300 ms executable-quote decision window.
await orca.warmSnapshot({
  inputMint: USDC,
  outputMint: WSOL,
  poolAddress: orcaWarm.pool_address,
  timeoutMs: 10_000
});
await raydium.warm();
await raydium.warmPool({ poolAddress: RAYDIUM_SOL_USDC_AMM });

async function orcaToRaydium() {
  // Atomic two-leg arbitrage cannot safely sell an estimated first-leg output:
  // the actual first-leg fill can be a few units lower and the second leg then
  // fails with "insufficient funds". Seed the target from an exact-input quote,
  // then rebuild BUY as exact-output. This guarantees a fixed intermediate WSOL
  // amount that the SELL leg can consume without relying on pre-existing WSOL.
  const seed = await orca.quote({
    inputMint: USDC,
    outputMint: WSOL,
    amount: NOTIONAL_RAW.toString(),
    slippageBps: 50,
    poolAddress: orcaWarm.pool_address
  });
  const targetWsol = String(seed.minimumOutputAmount);
  const buy = await orca.quoteExactOutput({
    inputMint: USDC,
    outputMint: WSOL,
    outputAmount: targetWsol,
    slippageBps: 50,
    poolAddress: orcaWarm.pool_address
  });
  const sell = await raydium.quote({
    inputMint: WSOL,
    outputMint: USDC,
    amount: targetWsol,
    slippageBps: 50,
    poolAddress: RAYDIUM_SOL_USDC_AMM
  });
  return {
    name: 'ORCA_EXACT_OUT->RAYDIUM_EXACT_IN',
    buyService: orca,
    sellService: raydium,
    buy,
    sell,
    gross: routeGross(buy.inputAmount, sell)
  };
}

const selected = await orcaToRaydium();
const [buyPrepared, sellPrepared] = await Promise.all([
  selected.buyService.prepareUnsignedLeg(selected.buy, { simulationPublicKey: owner }),
  selected.sellService.prepareUnsignedLeg(selected.sell, { simulationPublicKey: owner })
]);
const observed = await atomic.observePreparedRoundTrip({ buyPrepared, sellPrepared });

assert.equal(observed.transaction_built, true);
assert.equal(observed.atomic_two_leg_transaction, true);
assert.equal(observed.exact_transaction_fee_ready, true);
assert.ok(Number.isSafeInteger(observed.exact_roundtrip_fee_lamports));
assert.ok(Number.isSafeInteger(observed.exact_account_setup_lamports));
assert.equal(observed.simulation_attempted, true);
assert.equal(
  observed.simulation_ok,
  true,
  'atomic simulation rejected: ' + JSON.stringify({
    error: observed.simulation_error,
    log_tail: observed.simulation_error_log_tail
  })
);

const buySolRaw = BigInt(String(selected.buy.outputAmount));
const buyInputUsdc = Number(selected.buy.inputAmount) / 1_000_000;
const solUsd = buyInputUsdc / (Number(buySolRaw) / 1_000_000_000);
const net = finalizeExpectedNetEdge({
  grossExecutableSpreadBps: selected.gross,
  exactRoundtripFeeLamports: observed.exact_roundtrip_fee_lamports,
  exactAccountSetupLamports: observed.exact_account_setup_lamports,
  solUsd,
  notionalUsdc: buyInputUsdc,
  minimumNetEdgeBps: 0.5
});

assert.equal(net.net_edge_costs_included, true);

console.log(JSON.stringify({
  ok: true,
  route: selected.name,
  simulation_owner_source: simulationOwner.source,
  simulation_owner_address_exposed: false,
  buy_quote_latency_ms: selected.buy.latency_ms,
  sell_quote_latency_ms: selected.sell.latency_ms,
  gross_executable_spread_bps: selected.gross,
  transaction_built: observed.transaction_built,
  atomic_two_leg_transaction: observed.atomic_two_leg_transaction,
  instruction_count: observed.instruction_count,
  setup_instruction_count: observed.setup_instruction_count,
  exact_roundtrip_fee_lamports: observed.exact_roundtrip_fee_lamports,
  exact_account_setup_lamports: observed.exact_account_setup_lamports,
  exact_transaction_fee_ready: observed.exact_transaction_fee_ready,
  simulation_ok: observed.simulation_ok,
  units_consumed: observed.units_consumed,
  expected_net_edge_bps: net.expected_net_edge_bps,
  net_edge_gate_passed: net.net_edge_gate_passed,
  costs_verified: net.net_edge_costs_included,
  safety: atomic.safety
}, null, 2));