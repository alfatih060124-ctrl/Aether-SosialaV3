import assert from 'node:assert/strict';
import { createMarketplaceRepository } from './repositories/marketplace.mjs';

const baseTrader = Object.freeze({
  trader_id: 'trader_001',
  mode: 'SHADOW',
  verified: true,
  verification_status: 'VERIFIED',
  published: true,
  evidence_recorded: true,
  onboarding_status: 'APPROVED',
  status: 'ACTIVE',
  verification_reference: 'source_reference_001',
  display_name: 'Trader One'
});

function poolReturning(rowsByCall) {
  let index = 0;
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      const next = rowsByCall[index++] ?? [];
      return { rows: next };
    }
  };
}

{
  const pool = poolReturning([[{ ...baseTrader, evidence_recorded: false }]]);
  const repo = createMarketplaceRepository(pool);
  assert.deepEqual(await repo.listTraders(), []);
  assert.match(pool.queries[0].sql, /trader_verification_evidence/);
}

{
  const pool = poolReturning([[{ ...baseTrader, evidence_recorded: false }]]);
  const repo = createMarketplaceRepository(pool);
  assert.equal(await repo.getTrader('trader_001'), null);
}

{
  const pool = poolReturning([[{ ...baseTrader }]]);
  const repo = createMarketplaceRepository(pool);
  const rows = await repo.listTraders();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trader_id, 'trader_001');
  assert.equal('evidence_recorded' in rows[0], false);
  assert.equal('verification_status' in rows[0], false);
  assert.equal('published' in rows[0], false);
}

{
  const pool = poolReturning([[{ ...baseTrader, mode: 'LIVE' }]]);
  const repo = createMarketplaceRepository(pool);
  await assert.rejects(() => repo.listTraders(), /shadow_mode_required/);
}

{
  const pool = poolReturning([[{ ...baseTrader, evidence_recorded: false }]]);
  const repo = createMarketplaceRepository(pool);
  await assert.rejects(
    () => repo.setTraderPublished('trader_001', { published: true }),
    /trader_publication_gate_failed/
  );
  assert.equal(pool.queries.length, 1, 'publication failure must not reach UPDATE');
}

{
  const updated = { ...baseTrader, published: true };
  const pool = poolReturning([[{ ...baseTrader }], [updated]]);
  const repo = createMarketplaceRepository(pool);
  const result = await repo.setTraderPublished('trader_001', { published: true });
  assert.equal(result.published, true);
  assert.equal(pool.queries.length, 2);
  assert.match(pool.queries[1].sql, /^UPDATE traders SET published=/);
}

console.log('marketplace publication repository regression: ok');
