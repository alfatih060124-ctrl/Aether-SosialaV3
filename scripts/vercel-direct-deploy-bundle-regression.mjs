import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(fs.readFileSync('deploy/vercel-direct-deploy-manifest.json', 'utf8'));
const files = Array.isArray(manifest.files) ? manifest.files : [];
const fileSet = new Set(files);
const fail = (message) => { throw new Error(message); };

if (manifest.schema_version !== 1) fail('invalid_manifest_schema');
if (manifest.project_name !== 'aether-sosiala-v3') fail('invalid_vercel_project_name');
if (manifest.target !== 'production') fail('invalid_vercel_target');
if (manifest.source_ref !== 'main') fail('invalid_source_ref');
if (manifest.deployment_role !== 'PUBLIC_EDGE') fail('invalid_deployment_role');
if (manifest?.safety?.execution_mode !== 'SHADOW') fail('execution_mode_not_shadow');
if (manifest?.safety?.live_enabled !== false) fail('live_must_remain_disabled');
if (manifest?.safety?.signer_included !== false) fail('signer_must_not_be_included');
if (manifest?.safety?.secrets_included !== false) fail('secrets_must_not_be_included');

for (const required of [
  'vercel.json',
  'api/index.mjs',
  'services/api/src/market-intelligence.mjs',
  'public/index.html',
  'public/aether-mark.svg',
  'public/favicon.svg',
  'public/og-aether.svg'
]) {
  if (!fileSet.has(required)) fail(`missing_required_bundle_file:${required}`);
}

for (const filename of fs.readdirSync('public')) {
  const full = path.join('public', filename);
  if (fs.statSync(full).isFile() && !fileSet.has(full)) fail(`public_file_missing_from_bundle:${full}`);
}

for (const file of files) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`bundle_file_missing:${file}`);
  const lower = file.toLowerCase();
  if (lower.includes('.env') || lower.includes('secret') || lower.includes('private-key') || lower.includes('seed')) {
    fail(`forbidden_sensitive_bundle_path:${file}`);
  }
}

const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
for (const [src, dest] of [
  ['/aether-mark.svg', '/public/aether-mark.svg'],
  ['/favicon.svg', '/public/favicon.svg'],
  ['/og-aether.svg', '/public/og-aether.svg']
]) {
  if (!routes.some(route => route?.src === src && route?.dest === dest)) fail(`brand_asset_route_missing:${src}`);
  if (!fileSet.has(dest.replace(/^\//, ''))) fail(`brand_asset_not_in_bundle:${dest}`);
}

const gateway = fs.readFileSync('api/index.mjs', 'utf8');
if (!gateway.includes("../services/api/src/market-intelligence.mjs")) fail('market_dependency_contract_changed');
if (!fileSet.has('services/api/src/market-intelligence.mjs')) fail('market_dependency_missing');
if (gateway.includes('PRIVATE_KEY') || gateway.includes('SEED_PHRASE')) fail('forbidden_signing_material_reference');

console.log(`Vercel direct deploy bundle regression: PASS (${files.length} files)`);
