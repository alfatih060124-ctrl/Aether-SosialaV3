import { createHash } from 'node:crypto';

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET=new Set(B58);
function fail(code){const e=new Error(code);e.code=code;throw e;}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function stable(v){if(Array.isArray(v))return`[${v.map(stable).join(',')}]`;if(plain(v))return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;return JSON.stringify(v);}
function hash(v){return createHash('sha256').update(stable(v)).digest('hex');}
function b58len(text){if(typeof text!=='string'||!text.length)return-1;let n=0n;for(const ch of text){if(!B58_SET.has(ch))return-1;n=n*58n+BigInt(B58.indexOf(ch));}let bytes=0,x=n;while(x>0n){bytes++;x>>=8n;}let leading=0;while(leading<text.length&&text[leading]==='1')leading++;return bytes+leading;}
function solId(v,bytes,code){if(b58len(v)!==bytes)fail(code);return v;}
function safeInt(v,code){if(!Number.isSafeInteger(v)||v<0)fail(code);return v;}
function endpoint(v){if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v))fail('invalid_rpc_endpoint_label');return v;}
function iso(v,code){if(typeof v!=='string')fail(code);const ms=Date.parse(v);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==v)fail(code);return ms;}
function txErr(v){if(v===null)return null;if(!plain(v))fail('invalid_transaction_err');return JSON.parse(stable(v));}
function memo(v){if(v===null)return null;if(typeof v!=='string'||v.length>512)fail('invalid_memo');return v;}
function confirmation(v){if(v===null)return null;if(!['processed','confirmed','finalized'].includes(v))fail('invalid_confirmation_status');return v;}
function normalizeRows(rows,observedMs){if(!Array.isArray(rows))fail('invalid_signature_rows');const seen=new Set();let previousSlot=null;return rows.map((row,i)=>{if(!plain(row))fail(`invalid_signature_row_${i}`);const signature=solId(row.signature,64,`invalid_signature_${i}`);if(seen.has(signature))fail('duplicate_signature');seen.add(signature);const slot=safeInt(row.slot,`invalid_slot_${i}`);if(previousSlot!==null&&slot>previousSlot)fail('signature_rows_not_descending');previousSlot=slot;const block_time=row.blockTime===null?null:safeInt(row.blockTime,`invalid_block_time_${i}`);if(block_time!==null&&block_time*1000>observedMs)fail('future_block_time');const transaction_err=txErr(row.err);const normalized={signature,slot,block_time,transaction_err,memo:memo(row.memo??null),confirmation_status:confirmation(row.confirmationStatus??null),source_reference:`solana_rpc:${signature}@${slot}`};return normalized;});}
function envelope(p){const provenance={...p};return{schema:'aether.solana.wallet_signature_discovery.v1',collection_status:'PENDING_DATA',metrics_available:false,trades_count:null,total_return_bps:null,win_rate_bps:null,drawdown_bps:null,reputation_score:null,verified:false,published:false,live_execution_authorized:false,reconciliation_required:true,source_reference:null,discovered_signature_count:p.rows.length,rows:p.rows,provenance,source_hash:hash(provenance)};}

export async function collectSolanaWalletSignatureDiscovery({rpc,traderWallet,rpcEndpointLabel,commitment='confirmed',limit=25,before=null,requestedAt,observedAt}){
  if(typeof rpc!=='function')fail('rpc_required');const requested_wallet=solId(traderWallet,32,'invalid_trader_wallet');const rpc_endpoint_label=endpoint(rpcEndpointLabel);
  if(!['confirmed','finalized'].includes(commitment))fail('invalid_commitment');if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('invalid_limit');const before_signature=before===null?null:solId(before,64,'invalid_before_signature');const req=iso(requestedAt,'invalid_requested_at'),obs=iso(observedAt,'invalid_observed_at');if(obs<req)fail('invalid_observation_chronology');
  const options={commitment,limit};if(before_signature!==null)options.before=before_signature;const response=await rpc('getSignaturesForAddress',[requested_wallet,options]);if(!plain(response)||!Object.prototype.hasOwnProperty.call(response,'result'))fail('invalid_rpc_response');const rows=normalizeRows(response.result,obs);
  return envelope({rpc_method:'getSignaturesForAddress',rpc_commitment:commitment,rpc_endpoint_label,requested_wallet,limit,before_signature,requested_at:requestedAt,observed_at:observedAt,rows});
}

export function verifySolanaWalletSignatureDiscovery(e){
  if(!plain(e)||e.schema!=='aether.solana.wallet_signature_discovery.v1')return false;
  try{if(e.collection_status!=='PENDING_DATA'||e.metrics_available!==false||e.verified!==false||e.published!==false||e.live_execution_authorized!==false||e.reconciliation_required!==true||e.source_reference!==null)return false;for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])if(e[k]!==null)return false;
    const p=e.provenance;if(!plain(p)||p.rpc_method!=='getSignaturesForAddress')return false;solId(p.requested_wallet,32,'bad_wallet');endpoint(p.rpc_endpoint_label);if(!['confirmed','finalized'].includes(p.rpc_commitment)||!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>100)return false;if(p.before_signature!==null)solId(p.before_signature,64,'bad_before');const req=iso(p.requested_at,'bad_req'),obs=iso(p.observed_at,'bad_obs');if(obs<req)return false;const rows=normalizeRows(p.rows.map(row=>({signature:row.signature,slot:row.slot,blockTime:row.block_time,err:row.transaction_err,memo:row.memo,confirmationStatus:row.confirmation_status})),obs);if(rows.length>p.limit||stable(rows)!==stable(p.rows))return false;if(e.discovered_signature_count!==rows.length||stable(e.rows)!==stable(rows))return false;return e.source_hash===hash(p);
  }catch{return false;}
}
