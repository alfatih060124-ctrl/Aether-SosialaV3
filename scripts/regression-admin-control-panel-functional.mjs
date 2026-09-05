import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
for (const needle of [
  'Engine Control',
  'Subscription & Payments',
  'Fee Configuration',
  'Members & LIVE Access',
  'Treasury & Payment Monitoring',
  'ORCA ↔ Raydium',
  '0.20%',
  'Emergency Kill',
  '30 days',
  '90 days',
  '180 days',
  '360 days',
  'DPwJ2m52bmFV5ghDT3dVeDTrv1aSQste5jTxPEsqGTJt'
]) {
  if (!html.includes(needle)) throw new Error(`admin_panel_missing:${needle}`);
}
console.log('admin control panel regression passed');
