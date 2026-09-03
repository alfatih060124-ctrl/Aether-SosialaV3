import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../migrations/020_fee_control_approval_ledger.sql', import.meta.url), 'utf8');

// The database trigger is the final authority for fee changes. A caller that can set
// transaction-local settings must not be able to bypass the repository's canonicalActor()
// check by supplying only a distinct actor id. The DB guard must independently bind the
// transaction to the FEE_CONFIG_APPLIER role.
assert.ok(
  migration.includes("current_setting('aether.actor_role', true)"),
  'fee config DB guard must read an explicit transaction-local actor role',
);
assert.ok(
  migration.includes("FEE_CONFIG_APPLIER"),
  'fee config DB guard must require the FEE_CONFIG_APPLIER role before applying an approved change',
);

console.log('fee-control DB applier-role regression passed');
