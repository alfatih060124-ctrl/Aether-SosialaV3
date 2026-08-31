import fs from 'node:fs';

const migration = fs.readFileSync('migrations/015_product_audit_separation_gates.sql', 'utf8');
function assert(condition, message) { if (!condition) throw new Error(message); }

for (const required of [
  'trader_insert_must_start_unverified_unpublished',
  'trader_publication_requires_prior_verification',
  'trader_publication_gate_failed',
  "NEW.mode IS DISTINCT FROM 'SHADOW'",
  'copy_mandate_live_execution_forbidden',
  'TRADER_VERIFICATION_CHANGED',
  'TRADER_PUBLICATION_CHANGED',
  'COPY_MANDATE_CREATED',
  'COPY_MANDATE_CHANGED',
  'PLATFORM_FEE_CONFIG_CREATED',
  'PLATFORM_FEE_CONFIG_CHANGED',
  "'live_execution_authorized', false",
]) assert(migration.includes(required), `missing audit/separation invariant: ${required}`);

assert(!/SET\s+LIVE_ENABLED\s*=\s*true/i.test(migration), 'migration must not enable LIVE');
assert(!/FIXTURE_GATE_PASSED\s*=\s*true/i.test(migration), 'migration must not pass fixture gate');
assert(!/OPERATOR_APPROVED\s*=\s*true/i.test(migration), 'migration must not approve operator gate');
assert(!/private[_ -]?key|seed phrase|secret key/i.test(migration), 'migration must not contain signing material');
assert(/CREATE TRIGGER trg_aether_guard_trader_control_plane\s+BEFORE INSERT OR UPDATE ON traders/i.test(migration), 'trader guard must cover INSERT and UPDATE');
assert(/TG_OP\s*=\s*'INSERT'/i.test(migration), 'trader creation requires explicit fail-closed INSERT path');
assert(/NEW\.verification_status IS DISTINCT FROM 'PENDING_DATA'/i.test(migration), 'new trader must start PENDING_DATA');
assert(/NEW\.verified IS DISTINCT FROM false/i.test(migration), 'new trader must start unverified');
assert(/NEW\.published IS DISTINCT FROM false/i.test(migration), 'new trader must start unpublished');
assert(/CREATE TRIGGER trg_aether_guard_fee_config\s+BEFORE INSERT OR UPDATE ON platform_fee_config/i.test(migration), 'fee guard must cover INSERT and UPDATE');
assert(/CREATE TRIGGER trg_aether_audit_fee_config\s+AFTER INSERT OR UPDATE ON platform_fee_config/i.test(migration), 'fee audit must cover INSERT and UPDATE');

console.log('Product audit + separation regression: PASS');
console.log('new trader fail-closed -> prior verification -> explicit publication; SHADOW copy mandate; fee inserts/updates bounded and audited; LIVE remains unauthorized');
