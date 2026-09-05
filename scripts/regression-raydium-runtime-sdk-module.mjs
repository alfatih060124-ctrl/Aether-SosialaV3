import assert from 'node:assert/strict';
import {
  loadRaydiumRuntimeSdkModule,
  RAYDIUM_RUNTIME_SDK_MODULE
} from '../services/api/src/raydium-runtime-sdk-module.mjs';

const sdk = await loadRaydiumRuntimeSdkModule();

assert.equal(typeof sdk.BN, 'function', 'Raydium runtime SDK must expose BN');
assert.equal(typeof sdk.PublicKey, 'function', 'Raydium runtime SDK must expose PublicKey');
assert.equal(RAYDIUM_RUNTIME_SDK_MODULE.read_only, true);
assert.equal(RAYDIUM_RUNTIME_SDK_MODULE.transaction_building_authorized, false);
assert.equal(RAYDIUM_RUNTIME_SDK_MODULE.network_submission_authorized, false);
assert.equal(RAYDIUM_RUNTIME_SDK_MODULE.live_execution_authorized, false);

console.log('Raydium runtime SDK module regression: PASS');
