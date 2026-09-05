import fs from 'node:fs';

const source = fs.readFileSync('services/api/src/member-autotrade-route.mjs', 'utf8');

const start = source.indexOf('if ([TREASURY_STATE_ROUTE,TREASURY_CHALLENGE_ROUTE,TREASURY_VERIFY_ROUTE].includes(route))');
const end = source.indexOf("if (route === RENTAL_STATE_ROUTE || route === RENTAL_CHECKOUT_ROUTE)", start);

if (start < 0 || end < 0) {
  throw new Error('treasury_route_block_not_found');
}

const block = source.slice(start, end);

if (!block.includes('sessionFor(req)')) {
  throw new Error('authenticated_session_boundary_missing');
}

const privilegedGuard = /(require\w*(Admin|Operator|Treasury)|(?:admin|operator|treasury).*(?:role|capabilit|authoriz)|(?:role|capabilit|authoriz).*(?:admin|operator|treasury))/i;
if (!privilegedGuard.test(block)) {
  throw new Error('treasury_mutation_requires_privileged_authorization');
}

for (const invariant of [
  'transaction_required:false',
  'funds_authorized:false',
  'live_execution_authorized:false'
]) {
  if (!block.includes(invariant)) {
    throw new Error(`missing_fail_closed_invariant:${invariant}`);
  }
}

if (/LIVE_ENABLED\s*=\s*true/i.test(source)) {
  throw new Error('live_enablement_forbidden');
}

console.log('rental treasury authorization boundary regression: PASS');
