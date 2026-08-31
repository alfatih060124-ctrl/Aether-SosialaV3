import fs from 'node:fs';
import assert from 'node:assert/strict';

const repo = fs.readFileSync('services/api/src/repositories/admin.mjs', 'utf8');
const admin = fs.readFileSync('web/admin.html', 'utf8');

assert.match(repo, /current\.status === 'CANCELLED'[\s\S]*copy_mandate_cancelled/, 'Cancelled copy mandates must be terminal in the repository layer');
assert.match(repo, /mode='SHADOW',live_execution_authorized=false/, 'Admin copy-policy updates must remain SHADOW and never authorize LIVE execution');
assert.doesNotMatch(repo, /live_execution_authorized\s*=\s*true/, 'Admin repository must never authorize LIVE execution');

assert.match(admin, /item\.status==='CANCELLED'[\s\S]*Terminal — cannot resume/, 'Admin UI must visibly mark cancelled mandates as terminal');
assert.match(admin, /LIVE authorized=false/, 'Admin UI must expose fail-closed LIVE authorization state');
assert.match(admin, /Mandate CANCELLED bersifat terminal/, 'Admin UI must explain terminal cancellation behavior');

console.log('Admin safety regression: PASS');
