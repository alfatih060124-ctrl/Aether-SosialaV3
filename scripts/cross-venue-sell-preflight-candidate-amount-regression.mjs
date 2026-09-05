import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./vm-cross-venue-net-edge-probe.mjs', import.meta.url), 'utf8');

assert.match(source, /mode:\s*'SHADOW'/, 'probe must remain SHADOW');
assert.match(source, /live_execution_authorized:\s*false/, 'LIVE authorization must remain false');
assert.match(source, /network_submission_authorized:\s*false/, 'network submission must remain unauthorized');
assert.match(source, /signer_requested:\s*false/, 'signer must remain unrequested');

const broadSellReference = /const\s+sellReferenceAmount\s*=\s*String\(broad\?\.sell\?\.in_amount\s*\|\|\s*broad\?\.buy\?\.out_amount/.test(source);
const broadAmountIsHardFilter = /rawDexPairs\.filter\(candidate\s*=>\s*buyPreflight\.has\(candidate\.buy_dex\)\s*&&\s*sellPreflight\.has\(candidate\.sell_dex\)\)/.test(source);

assert.equal(
  broadSellReference && broadAmountIsHardFilter,
  false,
  'SELL routability must not fail closed solely on a broad-route reference amount before candidateBuy.outAmount is known; use the candidate restricted BUY output for the decisive SELL check or make broad preflight non-disqualifying'
);

assert.match(
  source,
  /amount:\s*String\(candidateBuy\.outAmount\)/,
  'final restricted SELL quote must use candidateBuy.outAmount'
);

console.log('cross-venue sell preflight candidate amount regression: ok');
