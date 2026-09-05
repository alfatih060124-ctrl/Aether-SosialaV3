import assert from 'node:assert/strict';
import { ORCA_RAYDIUM_SHADOW_RUNTIME } from '../services/api/src/orca-raydium-shadow-runtime.mjs';
import { ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME } from '../services/api/src/orca-raydium-shadow-qualification-runtime.mjs';

assert.equal(ORCA_RAYDIUM_SHADOW_RUNTIME.mode, 'SHADOW');
assert.equal(ORCA_RAYDIUM_SHADOW_RUNTIME.transaction_building_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_RUNTIME.network_submission_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_RUNTIME.live_execution_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.min_expected_net_edge_bps, 20);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.requires_verified_network_fee, true);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.requires_verified_risk_evidence, true);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.transaction_building_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.network_submission_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.live_execution_authorized, false);

console.log('ORCA Raydium SHADOW core wiring safety regression: PASS');
