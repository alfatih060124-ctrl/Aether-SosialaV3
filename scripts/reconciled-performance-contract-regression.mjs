import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync('services/api/src/server.mjs','utf8');
const service = fs.readFileSync('services/api/src/reconciled-performance-service.mjs','utf8');
const migration = fs.readFileSync('migrations/017_reconciled_performance_evidence.sql','utf8');
const admin = fs.readFileSync('web/admin.html','utf8');

// Internal accounting ingestion must be authenticated and remain SHADOW-only.
assert.match(server, /p\[1\]==='internal'.*p\[4\]==='reconciled-trades'/s);
assert.match(server, /if\(!auth\(req\)\)return send\(res,401,\{error:'unauthorized'\}\)/);
assert.match(server, /reconciliation_shadow_only/);
assert.match(server, /TRADER_RECONCILED_TRADES_RECORDED/);
assert.match(server, /verification_authorized:false/);
assert.match(server, /publication_authorized:false/);
assert.match(server, /live_execution_authorized:false/);

// Automatic performance evidence must only be created from the reconciliation service.
assert.match(server, /p\[5\]==='reconcile'/);
assert.match(server, /buildPerformanceEvidence\(p\[3\]\)/);
assert.match(server, /TRADER_RECONCILED_PERFORMANCE_EVIDENCE_BUILT/);
assert.doesNotMatch(service, /UPDATE\s+traders/i);
assert.doesNotMatch(service, /verification_status\s*=\s*'VERIFIED'/i);
assert.doesNotMatch(service, /published\s*=\s*true/i);
assert.doesNotMatch(service, /live_execution_authorized\s*=\s*true/i);
assert.match(service, /'AUTOMATIC_RECONCILIATION'/);
assert.match(service, /'RECORDED'/);
assert.match(service, /MIN_REPUTATION_TRADES = 20/);
assert.match(service, /synthetic_trade_event_blocked/);
assert.match(service, /reconciliation_event_confidence_too_low/);

// DB schema binds reconciled rows to decoded trade events and hard-caps Evidence V1.
assert.match(migration, /trade_event_id text NOT NULL REFERENCES trade_events\(event_id\)/);
assert.match(migration, /UNIQUE \(trader_id, trade_event_id\)/);
assert.match(migration, /AUTOMATIC_RECONCILIATION/);
assert.match(migration, /aether_guard_reconciled_trade_limit/);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /existing_count >= 5000/);
assert.match(migration, /reconciliation_evidence_row_limit/);

// Admin UX exposes build/review as separate actions and states the minimum sample.
assert.match(admin, /Build Performance Evidence/);
assert.match(admin, /Minimum 20 reconciled trades|Minimum 20|minimum 20/i);
assert.match(admin, /evidence\/reconcile/);
assert.match(admin, /Admin VERIFY tetap aksi terpisah/);
assert.match(admin, /tidak ada langkah yang otomatis VERIFY, Publish, atau mengaktifkan LIVE/i);

console.log('reconciled performance contract regression: PASS');
