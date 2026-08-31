import fs from 'node:fs';

const migration = fs.readFileSync('migrations/015_product_audit_separation_gates.sql', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const required of [
  'trader_publication_requires_prior_verification',
  'trader_publication_gate_failed',
  "NEW.mode IS DISTINCT FROM 'SHADOW'",
  'copy_mandate_live_execution_forbidden',
  'TRADER_VERIFICATION_CHANGED',
  'TRADER_PUBLICATION_CHANGED',
  'COPY_MANDATE_CREATED',
  'COPY_MANDATE_CHANGED',
  'PLATFORM_FEE_CONFIG_CHANGED',
  "'live_execution_authorized', false",
]) {
  assert(migration.includes(required), `missing audit/separation invariant: ${required}`);
}

assert(!/SET\s+LIVE_ENABLED\s*=\s*true/i.test(migration), 'migration must not enable LIVE');
assert(!/FIXTURE_GATE_PASSED\s*=\s*true/i.test(migration), 'migration must not pass fixture gate');
assert(!/OPERATOR_APPROVED\s*=\s*true/i.test(migration), 'migration must not approve operator gate');
assert(!/private[_ -]?key|seed phrase|secret key/i.test(migration), 'migration must not contain signing material');

const publicationGuard = migration.indexOf('aether_guard_trader_control_plane');
const traderAudit = migration.indexOf('aether_audit_trader_control_plane');
assert(publicationGuard >= 0 && traderAudit > publicationGuard, 'trader guard must exist before trader audit trigger');

const copyGuard = migration.indexOf('aether_guard_copy_mandate');
const copyAudit = migration.indexOf('aether_audit_copy_mandate');
assert(copyGuard >= 0 && copyAudit > copyGuard, 'copy mandate guard must exist before copy audit trigger');

console.log('Product audit + separation regression: PASS');
console.log('prior verification -> explicit publication; SHADOW copy mandate; fee/copy/trader changes audited; LIVE remains unauthorized');
