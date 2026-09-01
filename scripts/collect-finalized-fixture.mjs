#!/usr/bin/env node
import fs from 'node:fs';
import { captureFinalizedFixture } from '../packages/decoder-fixtures/finalized-fixture-collector.mjs';

const ALLOWED_ARGS = new Set([
  'rpc-url',
  'signature',
  'dex',
  'version',
  'program-id',
  'expected',
  'rpc-label',
  'out',
]);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected_argument:${arg}`);
    const key = arg.slice(2);
    if (!ALLOWED_ARGS.has(key)) throw new Error(`unsupported_argument:${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate_argument:${key}`);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`missing_argument_value:${key}`);
    values[key] = next;
    index += 1;
  }
  return values;
}

function required(args, name) {
  const value = String(args[name] || '').trim();
  if (!value) throw new Error(`missing_argument:${name}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = String(args['rpc-url'] || process.env.SOLANA_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  let parsedRpcUrl;
  try { parsedRpcUrl = new URL(rpcUrl); } catch { throw new Error('invalid_solana_rpc_url'); }
  if (parsedRpcUrl.protocol !== 'https:' && parsedRpcUrl.hostname !== 'localhost' && parsedRpcUrl.hostname !== '127.0.0.1') {
    throw new Error('solana_rpc_https_required');
  }

  let nextId = 1;
  const rpcCall = async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('solana_rpc_http_error');
      const payload = await response.json();
      if (payload?.error) throw new Error('solana_rpc_error');
      return payload?.result;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
      if (String(error?.message || '').startsWith('solana_rpc_')) throw error;
      throw new Error('solana_rpc_unavailable');
    } finally {
      clearTimeout(timer);
    }
  };

  const fixture = await captureFinalizedFixture({
    rpcCall,
    signature: required(args, 'signature'),
    dex: required(args, 'dex'),
    version: required(args, 'version'),
    programId: required(args, 'program-id'),
    expected: args.expected || 'EVENT',
    endpointLabel: args['rpc-label'] || process.env.SOLANA_RPC_ENDPOINT_LABEL || 'solana-rpc',
  });

  const rendered = `${JSON.stringify(fixture, null, 2)}\n`;
  if (args.out) {
    fs.writeFileSync(args.out, rendered, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(JSON.stringify({
      ok: true,
      notice: 'RAW_CAPTURE_ONLY_NOT_LIVE_EVIDENCE',
      output_file: args.out,
      evidence_sha256: fixture.evidence_sha256,
      fixture_class: fixture.fixture_class,
      review_state: fixture.review_state,
      countable_for_live_manifest: fixture.countable_for_live_manifest,
      live_execution_authorized: false,
    }) + '\n');
    return;
  }
  process.stdout.write(rendered);
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: String(error?.message || 'fixture_capture_failed'),
    live_execution_authorized: false,
  }) + '\n');
  process.exitCode = 2;
});
