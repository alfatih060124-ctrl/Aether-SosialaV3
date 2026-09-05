import fs from 'node:fs';

const source = fs.readFileSync(new URL('./vm-cross-venue-stage-diagnostic.mjs', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(source.includes("probe: 'AETHER_CROSS_VENUE_STAGE_DIAGNOSTIC_SHADOW'"), 'expected SHADOW stage diagnostic');
assert(source.includes("mode: 'SHADOW'"), 'SHADOW mode invariant missing');
assert(source.includes('execution_dispatched: false'), 'execution must remain undispatched');
assert(source.includes('transaction_signed: false'), 'transaction signing must remain disabled');
assert(source.includes('signer_requested: false'), 'signer must remain unrequested');
assert(source.includes('network_submission_authorized: false'), 'network submission must remain unauthorized');
assert(source.includes('live_execution_authorized: false'), 'LIVE execution must remain unauthorized');

const quoteCall = 'await quotes.getUsdcRoundTripEvidence';
const quoteCallIndex = source.indexOf(quoteCall);
assert(quoteCallIndex >= 0, 'round-trip quote call missing');

const delayRef = 'quotes.inter_quote_delay_ms';
const delayRefIndex = source.indexOf(delayRef);
assert(delayRefIndex >= 0, 'stage diagnostic must use quote-service inter-round-trip delay');

const beforeQuote = source.slice(Math.max(0, quoteCallIndex - 900), quoteCallIndex);
const throttlingPattern = /(setTimeout|delay|sleep|wait)[\s\S]{0,250}quotes\.inter_quote_delay_ms|quotes\.inter_quote_delay_ms[\s\S]{0,250}(setTimeout|delay|sleep|wait)/;
assert(throttlingPattern.test(beforeQuote), 'subsequent broad round-trip quote attempts must be throttled before the next quote call');

const attemptsIncrement = source.indexOf('counters.broad_quote_attempted += 1');
assert(attemptsIncrement >= 0 && attemptsIncrement < quoteCallIndex, 'broad quote attempt telemetry ordering changed unexpectedly');

console.log('cross-venue stage quote throttle regression: PASS');
