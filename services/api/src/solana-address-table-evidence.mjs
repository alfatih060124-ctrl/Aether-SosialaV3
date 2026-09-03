import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET = new Set(B58);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function fail(code){ const e = new Error(code); e.code = code; throw e; }
function isPlainObject(v){ return v !== null && typeof v === 'object' && !Array.isArray(v); }
function stable(v){
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function sha256(v){ return createHash('sha256').update(typeof v === 'string' ? v : stable(v)).digest('hex'); }
function base58ByteLength(text){
  if (typeof text !== 'string' || text.length === 0) return -1;
  let n = 0n;
  for (const ch of text){
    if (!B58_SET.has(ch)) return -1;
    n = n * 58n + BigInt(B58.indexOf(ch));
  }
  let bytes = 0;
  let x = n;
  while (x > 0n){ bytes++; x >>= 8n; }
  let leading = 0;
  while (leading < text.length && text[leading] === '1') leading++;
  return bytes + leading;
}
function requireSolanaId(value, bytes, code){
  if (base58ByteLength(value) !== bytes) fail(code);
  return value;
}
function requireSafeInt(value, code, {min=0,max=MAX_SAFE}={}){
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function requireEndpointLabel(value){
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) fail('invalid_rpc_endpoint_label');
  return value;
}
function requireIso(value, code){
  if (typeof value !== 'string') fail(code);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(code);
  return ms;
}
function normalizeErr(err){
  if (err === null) return null;
  if (!isPlainObject(err)) fail('invalid_transaction_err');
  return JSON.parse(stable(err));
}
function normalizeAccountKeys(message){
  const raw = message?.accountKeys;
  if (!Array.isArray(raw) || raw.length === 0) fail('missing_account_keys');
  const keys = raw.map((v,i)=>{
    const key = typeof v === 'string' ? v : v?.pubkey;
    return requireSolanaId(key, 32, `invalid_account_key_${i}`);
  });
  if (new Set(keys).size !== keys.length) fail('duplicate_account_keys');
  return keys;
}
function normalizeIndexArray(value, label){
  if (!Array.isArray(value)) fail(`invalid_${label}`);
  const out = value.map((v,i)=>requireSafeInt(v, `invalid_${label}_${i}`, {max:255}));
  if (new Set(out).size !== out.length) fail(`duplicate_${label}`);
  return out;
}
function normalizeLookups(message){
  if (!Object.prototype.hasOwnProperty.call(message ?? {}, 'addressTableLookups')) fail('missing_address_table_lookups');
  const raw = message.addressTableLookups;
  if (raw === null) return [];
  if (!Array.isArray(raw)) fail('invalid_address_table_lookups');
  const rows = raw.map((row,i)=>{
    if (!isPlainObject(row)) fail(`invalid_lookup_${i}`);
    const account_key = requireSolanaId(row.accountKey,32,`invalid_lookup_account_key_${i}`);
    const writable_indexes = normalizeIndexArray(row.writableIndexes,`lookup_${i}_writable_indexes`);
    const readonly_indexes = normalizeIndexArray(row.readonlyIndexes,`lookup_${i}_readonly_indexes`);
    if (new Set([...writable_indexes,...readonly_indexes]).size !== writable_indexes.length + readonly_indexes.length) fail(`overlapping_lookup_indexes_${i}`);
    return {lookup_index:i,account_key,writable_indexes,readonly_indexes};
  });
  const tableKeys = rows.map(r=>r.account_key);
  if (new Set(tableKeys).size !== tableKeys.length) fail('duplicate_lookup_account_key');
  return rows;
}
function normalizeLoaded(meta){
  if (!Object.prototype.hasOwnProperty.call(meta ?? {}, 'loadedAddresses')) fail('missing_loaded_addresses');
  const loaded = meta.loadedAddresses;
  if (!isPlainObject(loaded)) fail('invalid_loaded_addresses');
  const writable = Array.isArray(loaded.writable) ? loaded.writable.map((v,i)=>requireSolanaId(v,32,`invalid_loaded_writable_${i}`)) : fail('invalid_loaded_writable');
  const readonly = Array.isArray(loaded.readonly) ? loaded.readonly.map((v,i)=>requireSolanaId(v,32,`invalid_loaded_readonly_${i}`)) : fail('invalid_loaded_readonly');
  if (new Set([...writable,...readonly]).size !== writable.length + readonly.length) fail('duplicate_loaded_address');
  return {writable,readonly};
}
function enforceLookupLoadedCardinality(lookups,loaded){
  const writableExpected = lookups.reduce((n,r)=>n+r.writable_indexes.length,0);
  const readonlyExpected = lookups.reduce((n,r)=>n+r.readonly_indexes.length,0);
  if (loaded.writable.length !== writableExpected || loaded.readonly.length !== readonlyExpected) fail('loaded_address_count_mismatch');
  return {writable_expected:writableExpected,readonly_expected:readonlyExpected};
}
function safeEnvelope(provenance, {found,lookupCount}){
  const source_reference = found && lookupCount > 0 ? `solana_rpc:${provenance.requested_signature}@${provenance.slot}` : null;
  const full = {...provenance,source_reference};
  return {
    schema:'aether.solana.address_table_evidence.v1',
    collection_status:'PENDING_DATA',
    metrics_available:false,
    trades_count:null,total_return_bps:null,win_rate_bps:null,drawdown_bps:null,reputation_score:null,
    verified:false,published:false,live_execution_authorized:false,reconciliation_required:true,
    source_reference,
    lookup_count:lookupCount,
    loaded_writable_count:provenance.loaded_addresses.writable.length,
    loaded_readonly_count:provenance.loaded_addresses.readonly.length,
    provenance:full,
    source_hash:sha256(full),
  };
}

export async function collectSolanaAddressTableEvidence({rpc, signature, traderWallet, rpcEndpointLabel, commitment='confirmed', requestedAt, observedAt}){
  if (typeof rpc !== 'function') fail('rpc_required');
  const requested_signature = requireSolanaId(signature,64,'invalid_signature');
  const requested_wallet = requireSolanaId(traderWallet,32,'invalid_trader_wallet');
  const rpc_endpoint_label = requireEndpointLabel(rpcEndpointLabel);
  if (!['confirmed','finalized'].includes(commitment)) fail('invalid_commitment');
  const reqMs = requireIso(requestedAt,'invalid_requested_at');
  const obsMs = requireIso(observedAt,'invalid_observed_at');
  if (obsMs < reqMs) fail('invalid_observation_chronology');

  const response = await rpc('getTransaction',[requested_signature,{encoding:'jsonParsed',commitment,maxSupportedTransactionVersion:0}]);
  if (!isPlainObject(response) || !Object.prototype.hasOwnProperty.call(response,'result')) fail('invalid_rpc_response');
  if (response.result === null){
    const provenance = {
      rpc_method:'getTransaction',rpc_commitment:commitment,rpc_endpoint_label,requested_signature,requested_wallet,
      requested_at:requestedAt,observed_at:observedAt,found:false,slot:null,block_time:null,transaction_err:null,
      account_keys:[],address_table_lookups:[],loaded_addresses:{writable:[],readonly:[]},loaded_cardinality:{writable_expected:0,readonly_expected:0}
    };
    return safeEnvelope(provenance,{found:false,lookupCount:0});
  }

  const tx = response.result;
  if (!isPlainObject(tx) || !isPlainObject(tx.transaction) || !isPlainObject(tx.transaction.message) || !isPlainObject(tx.meta)) fail('invalid_transaction_shape');
  const returned = tx.transaction.signatures?.[0];
  requireSolanaId(returned,64,'invalid_returned_signature');
  if (returned !== requested_signature) fail('returned_signature_mismatch');
  const slot = requireSafeInt(tx.slot,'invalid_slot');
  const block_time = tx.blockTime === null ? null : requireSafeInt(tx.blockTime,'invalid_block_time');
  if (block_time !== null && block_time * 1000 > obsMs) fail('future_block_time');
  if (!Object.prototype.hasOwnProperty.call(tx.meta,'err')) fail('missing_transaction_err');
  const transaction_err = normalizeErr(tx.meta.err);
  const account_keys = normalizeAccountKeys(tx.transaction.message);
  if (!account_keys.includes(requested_wallet)) fail('trader_wallet_not_participant');
  const address_table_lookups = normalizeLookups(tx.transaction.message);
  const loaded_addresses = normalizeLoaded(tx.meta);
  const loaded_cardinality = enforceLookupLoadedCardinality(address_table_lookups,loaded_addresses);

  const provenance = {
    rpc_method:'getTransaction',rpc_commitment:commitment,rpc_endpoint_label,requested_signature,requested_wallet,
    requested_at:requestedAt,observed_at:observedAt,found:true,slot,block_time,transaction_err,account_keys,
    address_table_lookups,loaded_addresses,loaded_cardinality
  };
  return safeEnvelope(provenance,{found:true,lookupCount:address_table_lookups.length});
}

export function verifySolanaAddressTableEvidence(evidence){
  if (!isPlainObject(evidence) || evidence.schema !== 'aether.solana.address_table_evidence.v1') return false;
  try {
    if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false || evidence.reconciliation_required !== true) return false;
    for (const k of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score']) if (evidence[k] !== null) return false;
    const p = evidence.provenance;
    if (!isPlainObject(p)) return false;
    requireSolanaId(p.requested_signature,64,'invalid_signature'); requireSolanaId(p.requested_wallet,32,'invalid_trader_wallet'); requireEndpointLabel(p.rpc_endpoint_label);
    if (p.rpc_method !== 'getTransaction' || !['confirmed','finalized'].includes(p.rpc_commitment)) return false;
    const reqMs=requireIso(p.requested_at,'invalid_requested_at'), obsMs=requireIso(p.observed_at,'invalid_observed_at'); if(obsMs<reqMs) return false;
    let expectedRef=null, lookupCount=0;
    if (p.found === false){
      if (p.slot!==null || p.block_time!==null || p.transaction_err!==null) return false;
      if (stable(p.account_keys)!=='[]' || stable(p.address_table_lookups)!=='[]' || stable(p.loaded_addresses)!==stable({writable:[],readonly:[]})) return false;
      if (stable(p.loaded_cardinality)!==stable({writable_expected:0,readonly_expected:0})) return false;
    } else if (p.found === true){
      requireSafeInt(p.slot,'invalid_slot'); if(p.block_time!==null && requireSafeInt(p.block_time,'invalid_block_time')*1000>obsMs) return false; normalizeErr(p.transaction_err);
      const account_keys=(p.account_keys??[]).map((v,i)=>requireSolanaId(v,32,`invalid_account_key_${i}`)); if(new Set(account_keys).size!==account_keys.length || !account_keys.includes(p.requested_wallet)) return false;
      const lookups=normalizeLookups({addressTableLookups:p.address_table_lookups.map(r=>({accountKey:r.account_key,writableIndexes:r.writable_indexes,readonlyIndexes:r.readonly_indexes}))});
      if (!p.address_table_lookups.every((r,i)=>r.lookup_index===i)) return false;
      const loaded=normalizeLoaded({loadedAddresses:p.loaded_addresses}); const card=enforceLookupLoadedCardinality(lookups,loaded);
      if (stable(card)!==stable(p.loaded_cardinality)) return false;
      lookupCount=lookups.length; if(lookupCount>0) expectedRef=`solana_rpc:${p.requested_signature}@${p.slot}`;
    } else return false;
    if (p.source_reference !== expectedRef || evidence.source_reference !== expectedRef) return false;
    if (evidence.lookup_count!==lookupCount || evidence.loaded_writable_count!==p.loaded_addresses.writable.length || evidence.loaded_readonly_count!==p.loaded_addresses.readonly.length) return false;
    const withoutRef={...p}; delete withoutRef.source_reference; const canonical={...withoutRef,source_reference:expectedRef};
    return evidence.source_hash===sha256(canonical);
  } catch { return false; }
}
