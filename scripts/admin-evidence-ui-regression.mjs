import fs from 'node:fs';

const html = fs.readFileSync('web/admin.html','utf8');
function assert(condition,message){if(!condition)throw new Error(message)}

for(const required of [
  'Automatic Solana Evidence',
  'Collect Solana Evidence',
  '/evidence/collect',
  '/evidence/collections',
  'metrics_available=',
  'verified=false',
  'published=false',
  'LIVE authorized=false',
  'Manual evidence — advanced audited-source fallback',
  'Jangan masukkan angka dummy, estimasi, atau placeholder',
  'reconciled_metrics_required',
]) assert(html.includes(required),`missing automatic evidence UI invariant: ${required}`);

assert(/evidence\/collect'\s*,\s*\{method:'POST',body:JSON\.stringify\(\{limit:100,max_pages:3\}\)\}/.test(html),'collector request must contain only bounded collection controls');
assert(/const trades=input\('Trades count','number',''\)/.test(html),'manual trades input must not ship with fake default');
assert(/const ret=input\('Total return \(bps\)','number',''\)/.test(html),'manual return must not ship with fake default');
assert(/const win=input\('Win rate \(bps\)','number',''\)/.test(html),'manual win rate must not ship with fake default');
assert(/const dd=input\('Drawdown \(bps\)','number',''\)/.test(html),'manual drawdown must not ship with fake default');
assert(/const rep=input\('Reputation 0-100','number',''\)/.test(html),'manual reputation must not ship with fake default');
assert(html.includes("window.confirm('Konfirmasi: semua metrik berasal dari sumber yang dapat diaudit dan bukan data dummy/estimasi?')"),'manual evidence must require explicit audited-source confirmation');
assert(!/collectSolanaEvidence[\s\S]{0,1000}reviewEvidence\(/.test(html),'automatic collection must not call VERIFY');
assert(!/collectSolanaEvidence[\s\S]{0,1000}setPublication\(/.test(html),'automatic collection must not publish');

console.log('admin automatic evidence UI regression: PASS');
