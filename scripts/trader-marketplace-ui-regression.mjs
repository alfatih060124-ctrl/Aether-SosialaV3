import assert from 'node:assert/strict';
import fs from 'node:fs';

const page=fs.readFileSync('public/marketplace.html','utf8');
const vercel=JSON.parse(fs.readFileSync('vercel.json','utf8'));
const manifest=JSON.parse(fs.readFileSync('deploy/vercel-direct-deploy-manifest.json','utf8'));

assert.match(page,/AETHER Trader Marketplace/);
assert.match(page,/\/api\/traders\?limit=100/);
assert.match(page,/\/api\/marketplace\/fees/);
assert.match(page,/VERIFIED · SHADOW/);
assert.match(page,/fails closed/i);
assert.match(page,/does not submit transactions/i);
assert.doesNotMatch(page,/\bV3\b/i,'public brand must not expose internal version label');
assert.doesNotMatch(page,/LIVE_ENABLED|SolanaLiveDispatcher|private key|seed phrase/i,'marketplace must not expose LIVE or signer material');
assert.doesNotMatch(page,/method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i,'marketplace discovery must remain read-only');

const route=vercel.routes.find(r=>r.src==='/marketplace/?');
assert.deepEqual(route,{src:'/marketplace/?',dest:'/public/marketplace.html'});
const fallbackIndex=vercel.routes.findIndex(r=>r.src==='/(.*)');
const marketplaceIndex=vercel.routes.findIndex(r=>r.src==='/marketplace/?');
assert.ok(marketplaceIndex>=0&&marketplaceIndex<fallbackIndex,'marketplace route must precede SPA fallback');
assert.ok(manifest.files.includes('public/marketplace.html'),'direct deployment bundle must include marketplace asset');
assert.equal(manifest.safety.execution_mode,'SHADOW');
assert.equal(manifest.safety.live_enabled,false);
assert.equal(manifest.safety.signer_included,false);

console.log('trader marketplace UI regression: PASS');
