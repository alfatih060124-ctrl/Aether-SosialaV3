import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
for (const needle of [
  'Engine Control','Subscription & Payments','Fee Configuration',
  'Members & LIVE Access','Treasury & Payment Monitoring','ORCA ↔ Raydium',
  '0.20%','Emergency Kill','30 days','90 days','180 days','360 days',
  'SERVER-AUTHORITATIVE','Finalized Solana evidence required','Database-enforced'
]) if (!html.includes(needle)) throw new Error(`step21_admin_missing:${needle}`);
for (const stale of ['35 USDC','89.25 USDC','157.50 USDC','273.00 USDC'])
  if (html.includes(stale)) throw new Error(`step21_admin_stale_fixed_price:${stale}`);
if (html.includes('Copy Trading & Mandates')) throw new Error('step21_admin_copy_trade_surface_reintroduced');
console.log('step21 admin control panel regression: PASS');
