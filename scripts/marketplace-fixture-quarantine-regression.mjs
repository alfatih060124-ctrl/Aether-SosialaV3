import fs from 'node:fs/promises';

const migration = await fs.readFile(new URL('../migrations/016_quarantine_demo_marketplace_fixtures.sql', import.meta.url), 'utf8');
const marketplace = await fs.readFile(new URL('../services/api/src/repositories/marketplace.mjs', import.meta.url), 'utf8');

const fixtures = [
  'DEMO_AETHER_ALPHA',
  'DEMO_AETHER_MOMENTUM',
  'DEMO_AETHER_STABLE'
];

for (const fixture of fixtures) {
  if (!migration.includes(fixture)) throw new Error(`missing_fixture_quarantine:${fixture}`);
}

for (const required of [
  'verified = false',
  'published = false',
  "verification_status = 'PENDING_DATA'",
  "status = 'PENDING_VERIFICATION'",
  'verification_reference = \'\'',
  'verified_at = NULL'
]) {
  if (!migration.includes(required)) throw new Error(`missing_quarantine_guard:${required}`);
}

for (const marketplaceGate of [
  "status='ACTIVE'",
  'verified=true',
  "onboarding_status='APPROVED'",
  "verification_status='VERIFIED'",
  'published=true'
]) {
  if (!marketplace.includes(marketplaceGate)) throw new Error(`marketplace_gate_missing:${marketplaceGate}`);
}

console.log('marketplace fixture quarantine regression: PASS');
