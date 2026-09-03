import { createHash } from 'node:crypto';

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET=new Set(B58);
const MAX_SAFE=Number.MAX_SAFE_INTEGER;

function fail(code){const e=new Error(code);e.code=code;throw e;}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function stable(v){if(Array.isArray(v))return`[${v.map(stable).join(',')}]`;if(plain(v))return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;return JSON.stringify(v);}
function hash(v){return createHash('sha256').update(stable(v)).digest('hex');}
function b58len(text){if(typeof text!=='string'||!text.length)return-1;let n=0n;for(const ch of text){if(!B58_SET.has(ch))return-1;n=n*58n+BigInt(B58.indexOf(ch));}let bytes=0,x=n;while(x>0n){bytes++;x>>=8n;}let leading=0;while(leading<text.length&&text[leading]==='1')leading++;return bytes+leading;}
function solId(v,bytes,code){if(b58len(v)!==bytes)fail(code);return v;}
function safeInt(v,code){if(!Number.isSafeInteger(v)||v<0||v>MAX_SAFE)fail(code);return v;}
function endpoint(v){if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v))fail('invalid_rpc_endpoint_label');return v;}
function iso(v,code){if(typeof v!=='string')fail(code);const ms=Date.parse(v);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==v)fail(code);return ms;}
function txErr(v){if(v===null)return null;if(!plain(v))fail('invalid_transaction_err');return JSON.parse(stable(v));}
function version(v){if(v==='legacy')return'legacy';if(v===0)return 0;fail('unsupported_transaction_version');}
function accountKeys(message){const raw=message?.accountKeys;if(!Array.isArray(raw)||raw.length===0)fail('missing_account_keys');const out=raw.map((v,i)=>solId(typeof v==='string'?v:v?.pubkey,32,`invalid_account_key_${i}`));if(new Set(out).size!==out.length)fail('duplicate_account_keys');return out;}
function envelope(p){const ref=p.found?`solana_rpc:${p.requested_signature}@${p.slot}`:null;const provenance={...p,source_reference:ref};return{schema:'aether.solana.transaction_version_evidence.v1',collection_status:'PENDING_DATA',metrics_available:false,trades_count:null,total_return_bps:null,win_rate_bps:null,drawdown_bps:null,reputation_score:null,verified:false,published:false,live_execution_authorized:false,reconciliation_required:true,source_reference:ref,transaction_version:p.transaction_version,provenance,source_hash:hash(provenance)};}

export async function collectSolanaTransactionVersionEvidence({rpc,signature,traderWallet,rpcEndpointLabel,commitment='confirmed',requestedAt,observedAt}){
  if(typeof rpc!=='function')fail('rpc_required');
  const requested_signature=solId(signature,64,'invalid_signature');
  const requested_wallet=solId(traderWallet,32,'invalid_trader_wallet');
  const rpc_endpoint_label=endpoint(rpcEndpointLabel);
  if(!['confirmed','finalized'].includes(commitment))fail('invalid_commitment');
  const req=iso(requestedAt,'invalid_requested_at'),obs=iso(observedAt,'invalid_observed_at');if(obs<req)fail('invalid_observation_chronology');
  const response=await rpc('getTransaction',[requested_signature,{encoding:'json',commitment,maxSupportedTransactionVersion:0}]);
  if(!plain(response)||!Object.prototype.hasOwnProperty.call(response,'result'))fail('invalid_rpc_response');
  if(response.result===null)return envelope({rpc_method:'getTransaction',rpc_encoding:'json',max_supported_transaction_version:0,rpc_commitment:commitment,rpc_endpoint_label,requested_signature,requested_wallet,requested_at:requestedAt,observed_at:observedAt,found:false,slot:null,block_time:null,transaction_err:null,account_keys:[],transaction_version:null});
  const tx=response.result;if(!plain(tx)||!plain(tx.transaction)||!plain(tx.transaction.message)||!plain(tx.meta))fail('invalid_transaction_shape');
  const returned=tx.transaction.signatures?.[0];solId(returned,64,'invalid_returned_signature');if(returned!==requested_signature)fail('returned_signature_mismatch');
  const slot=safeInt(tx.slot,'invalid_slot');const block_time=tx.blockTime===null?null:safeInt(tx.blockTime,'invalid_block_time');if(block_time!==null&&block_time*1000>obs)fail('future_block_time');
  if(!Object.prototype.hasOwnProperty.call(tx.meta,'err'))fail('missing_transaction_err');
  if(!Object.prototype.hasOwnProperty.call(tx,'version'))fail('missing_transaction_version');
  const transaction_err=txErr(tx.meta.err),keys=accountKeys(tx.transaction.message),transaction_version=version(tx.version);
  if(!keys.includes(requested_wallet))fail('trader_wallet_not_participant');
  return envelope({rpc_method:'getTransaction',rpc_encoding:'json',max_supported_transaction_version:0,rpc_commitment:commitment,rpc_endpoint_label,requested_signature,requested_wallet,requested_at:requestedAt,observed_at:observedAt,found:true,slot,block_time,transaction_err,account_keys:keys,transaction_version});
}

export function verifySolanaTransactionVersionEvidence(e){
  if(!plain(e)||e.schema!=='aether.solana.transaction_version_evidence.v1')return false;
  try{
    if(e.collection_status!=='PENDING_DATA'||e.metrics_available!==false||e.verified!==false||e.published!==false||e.live_execution_authorized!==false||e.reconciliation_required!==true)return false;
    for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])if(e[k]!==null)return false;
    const p=e.provenance;if(!plain(p))return false;solId(p.requested_signature,64,'invalid_signature');solId(p.requested_wallet,32,'invalid_wallet');endpoint(p.rpc_endpoint_label);
    if(p.rpc_method!=='getTransaction'||p.rpc_encoding!=='json'||p.max_supported_transaction_version!==0||!['confirmed','finalized'].includes(p.rpc_commitment))return false;
    const req=iso(p.requested_at,'invalid_requested_at'),obs=iso(p.observed_at,'invalid_observed_at');if(obs<req)return false;
    let ref=null,ver=null;
    if(p.found===false){if(p.slot!==null||p.block_time!==null||p.transaction_err!==null||p.transaction_version!==null||stable(p.account_keys)!=='[]')return false;}
    else if(p.found===true){safeInt(p.slot,'invalid_slot');if(p.block_time!==null&&safeInt(p.block_time,'invalid_block_time')*1000>obs)return false;txErr(p.transaction_err);ver=version(p.transaction_version);const keys=(p.account_keys??[]).map((v,i)=>solId(v,32,`invalid_key_${i}`));if(new Set(keys).size!==keys.length||!keys.includes(p.requested_wallet))return false;ref=`solana_rpc:${p.requested_signature}@${p.slot}`;}
    else return false;
    if(p.source_reference!==ref||e.source_reference!==ref||e.transaction_version!==ver)return false;
    return e.source_hash===hash(p);
  }catch{return false;}
}
