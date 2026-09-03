import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/account-wallet-portfolio.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderPositions(data)');
const end = source.indexOf('\n  async function loadPortfolio()', start);
assert.notEqual(start, -1, 'renderPositions must exist');
assert.notEqual(end, -1, 'renderPositions boundary must remain discoverable');

const renderPositions = source.slice(start, end);

// Position rows contain ledger/provider-derived identifiers and status fields. They must
// never be interpolated into an HTML sink; otherwise a poisoned persisted row can become
// stored DOM XSS in an authenticated member session. Rendering must use textContent or
// equivalent escaping-safe DOM construction.
assert.doesNotMatch(
  renderPositions,
  /\.innerHTML\s*=/,
  'renderPositions must not use innerHTML for ledger-derived position data'
);

// Keep the explicit SHADOW/LIVE invariant in the member presentation path.
assert.match(renderPositions, /LIVE authorized=false/, 'member positions UI must retain explicit LIVE-disabled state');

console.log('member positions DOM XSS regression: PASS');
