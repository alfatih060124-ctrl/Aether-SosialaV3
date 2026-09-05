export async function loadRaydiumRuntimeSdkModule() {
  const [sdk, bnModule, web3] = await Promise.all([
    import('@raydium-io/raydium-sdk-v2'),
    import('bn.js'),
    import('@solana/web3.js')
  ]);

  const BN = bnModule.default || bnModule.BN || bnModule;
  const PublicKey = web3.PublicKey;
  if (typeof BN !== 'function') throw new Error('raydium_sdk_bn_required');
  if (typeof PublicKey !== 'function') throw new Error('raydium_sdk_public_key_required');

  return Object.freeze({ ...sdk, BN, PublicKey });
}

export const RAYDIUM_RUNTIME_SDK_MODULE = Object.freeze({
  read_only: true,
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
