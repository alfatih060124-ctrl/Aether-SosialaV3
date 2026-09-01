const base = (process.env.AETHER_PUBLIC_ORIGIN || 'https://aether.boats').replace(/\/$/, '');

async function fetchChecked(path) {
  const response = await fetch(`${base}${path}`, {
    redirect: 'follow',
    headers: { 'user-agent': 'AETHER-production-logo-smoke/1.0' },
  });
  const body = await response.text();
  return { response, body };
}

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, check: 'AETHER_PRODUCTION_LOGO_V1', message, ...details }, null, 2));
  process.exit(2);
}

const home = await fetchChecked('/');
if (!home.response.ok) fail('landing_not_ok', { status: home.response.status });
if (!home.body.includes('AETHER')) fail('landing_missing_brand');
if (!home.body.includes('/aether-mark.svg')) fail('landing_missing_logo_reference');

const logo = await fetchChecked('/aether-mark.svg');
if (!logo.response.ok) fail('logo_not_ok', { status: logo.response.status });
const contentType = (logo.response.headers.get('content-type') || '').toLowerCase();
if (!contentType.includes('image/svg+xml')) {
  fail('logo_wrong_content_type', { status: logo.response.status, content_type: contentType });
}
if (!/^\s*<svg\b/i.test(logo.body)) fail('logo_body_not_svg');
if (!logo.body.includes('AETHER official mark')) fail('logo_not_canonical_aether_mark');
if (/<!doctype html|<html\b/i.test(logo.body)) fail('logo_resolved_to_html_fallback');

console.log(JSON.stringify({
  ok: true,
  check: 'AETHER_PRODUCTION_LOGO_V1',
  origin: base,
  landing_status: home.response.status,
  logo_status: logo.response.status,
  logo_content_type: contentType,
}, null, 2));
