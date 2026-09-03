import { createHash } from 'node:crypto';

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET=new Set(B58);
function fail(code){const e=new Error(code);e.code=code;throw e;}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function stable(v){if(Array.isArray(v))return`[${v.map(stable).join(',')}]`;if(plain(v))return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;return JSON.stringify(v);}
function hash(v){return createHash('sha256').update(stable(v)).digest('hex');}
function b58len(text){if(typeof text!=='string'||!text.length)return-1;let n=0n;for(const ch of text){if(!B58_SET.has(ch))return-1;n=n*58n+BigInt(B58.indexOf(ch));}let bytes=0,x=n;while(x>0n){bytes++;x>>=8n;}let leading=0;while(leading<text.length&&text[leading]==='1')leading++;return bytes+leading;}
function solId(v,bytes,code){if(b58len(v)!==bytes)fail(code);return v;}
function safeLamports(v,code){if(!Number.isSafeInteger(v)||v<0)fail(code);return v;}
function safeInt(v,code){if(!Number.isSafeInteger(v)||v<0)fail(code);return v;}
function endpoint(v){if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v))fail('invalid_rpc_endpoint_label');return v;}
function iso(v,code){if(typeof v!=='string')fail(code);const ms=Date.parse(v);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==v)fail(code);return ms;}
function txErr(v){if(v===null)return null;if(!plain(v))fail('invalid_transaction_err');return JSON.parse(stable(v));}
function keys(message){const raw=message?.accountKeys;if(!Array.isArray(raw)||raw.length===0)fail('missing_account_keys');const out=raw.map((v,i)=>solId(typeof v==='string'?v:v?.pubkey,32,`invalid_account_key_${i}`));if(new Set(out).size!==out.length)fail('duplicate_account_keys');return out;}
function balances(meta,keyCount){if(!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances))fail('missing_lamport_balances');if(meta.preBalances.length!==keyCount||meta.postBalances.length!==keyCount)fail('lamport_balance_cardinality_mismatch');return{pre:meta.preBalances.map((v,i)=>safeLamports(v,`invalid_pre_balance_${i}`)),post:meta.postBalances.map((v,i)=>safeLamports(v,`invalid_post_balance_${i}`))};}
function envelope(p){const ref=p.found?`solana_rpc:${p.requested_signature}@${p.slot}`:null;const provenance={...p,source_reference:ref};return{schema:'aether.solana.lamport_balance_evidence.v1',collection_status:'PENDING_DATA',metrics_available:false,trades_count:null,total_return_bps:null,win_rate_bps:null,drawdown_bps:null,reputation_score:null,verified:false,published:false,live_execution_authorized:false,reconciliation_required:true,source_reference:ref,trader_pre_lamports:p.trader_pre_lamports,trader_post_lamports:p.trader_post_lamports,trader_delta_lamports:p.trader_delta_lamports,provenance,source_hash:hash(provenance)};}

export async function collectSolanaLamportBalanceEvidence({rpc,signature,traderWallet,rpcEndpointLabel,commitment='confirmed',requestedAt,observedAt}){
  if(typeof rpc!=='function')fail('rpc_required');
  const requested_signature=solId(signature,64,'invalid_signature');const requested_wallet=solId(traderWallet,32,'invalid_trader_wallet');const rpc_endpoint_label=endpoint(rpcEndpointLabel);
  if(!['confirmed','finalized'].includes(commitment))fail('invalid_commitment');const req=iso(requestedAt,'invalid_requested_at'),obs=iso(observedAt,'invalid_observed_at');if(obs<req)fail('invalid_observation_chronology');
  const response=await rpc('getTransaction',[requested_signature,{encoding:'jsonParsed',commitment,maxSupportedTransactionVersion:0}]);
  if(!plain(response)||!Object.prototype.hasOwnProperty.call(response,'result'))fail('invalid_rpc_response');
  if(response.result===null)return envelope({rpc_method:'getTransaction',rpc_encoding:'jsonParsed',max_supported_transaction_version:0,rpc_commitment:commitment,rpc_endpoint_label,requested_signature,requested_wallet,requested_at:requestedAt,observed_at:observedAt,found:false,slot:null,block_time:null,transaction_err:null,account_keys:[],trader_account_index:null,trader_pre_lamports:null,trader_post_lamports:null,trader_delta_lamports:null});
  const tx=response.result;if(!plain(tx)||!plain(tx.transaction)||!plain(tx.transaction.message)||!plain(tx.meta))fail('invalid_transaction_shape');
  const returned=tx.transaction.signatures?.[0];solId(returned,64,'invalid_returned_signature');if(returned!==requested_signature)fail('returned_signature_mismatch');
  const slot=safeInt(tx.slot,'invalid_slot');const block_time=tx.blockTime===null?null:safeInt(tx.blockTime,'invalid_block_time');if(block_time!==null&&block_time*1000>obs)fail('future_block_time');if(!Object.prototype.hasOwnProperty.call(tx.meta,'err'))fail('missing_transaction_err');
  const account_keys=keys(tx.transaction.message);const trader_account_index=account_keys.indexOf(requested_wallet);if(trader_account_index<0)fail('trader_wallet_not_participant');const b=balances(tx.meta,account_keys.length);const trader_pre_lamports=b.pre[trader_account_index],trader_post_lamports=b.post[trader_account_index];const trader_delta_lamports=(BigInt(trader_post_lamports)-BigInt(trader_pre_lamports)).toString();
  return envelope({rpc_method:'getTransaction',rpc_encoding:'jsonParsed',max_supported_transaction_version:0,rpc_commitment:commitment,rpc_endpoint_label,requested_signature,requested_wallet,requested_at:requestedAt,observed_at:observedAt,found:true,slot,block_time,transaction_err:txErr(tx.meta.err),account_keys,trader_account_index,trader_pre_lamports,trader_post_lamports,trader_delta_lamports});
}

export function verifySolanaLamportBalanceEvidence(e){
  if(!plain(e)||e.schema!=='aether.solana.lamport_balance_evidence.v1')return false;
  try{if(e.collection_status!=='PENDING_DATA'||e.metrics_available!==false||e.verified!==false||e.published!==false||e.live_execution_authorized!==false||e.reconciliation_required!==true)return false;for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])if(e[k]!==null)return false;
    const p=e.provenance;if(!plain(p))return false;solId(p.requested_signature,64,'invalid_signature');solId(p.requested_wallet,32,'invalid_wallet');endpoint(p.rpc_endpoint_label);if(p.rpc_method!=='getTransaction'||p.rpc_encoding!=='jsonParsed'||p.max_supported_transaction_version!==0||!['confirmed','finalized'].includes(p.rpc_commitment))return false;const req=iso(p.requested_at,'bad_req'),obs=iso(p.observed_at,'bad_obs');if(obs<req)return false;
    let ref=null,pre=null,post=null,delta=null;if(p.found===false){if(p.slot!==null||p.block_time!==null||p.transaction_err!==null||p.trader_account_index!==null||p.trader_pre_lamports!==null||p.trader_post_lamports!==null||p.trader_delta_lamports!==null||stable(p.account_keys)!=='[]')return false;}
    else if(p.found===true){safeInt(p.slot,'bad_slot');if(p.block_time!==null&&safeInt(p.block_time,'bad_time')*1000>obs)return false;txErr(p.transaction_err);const ks=(p.account_keys??[]).map((v,i)=>solId(v,32,`bad_key_${i}`));if(new Set(ks).size!==ks.length)return false;const idx=ks.indexOf(p.requested_wallet);if(idx<0||p.trader_account_index!==idx)return false;pre=safeLamports(p.trader_pre_lamports,'bad_pre');post=safeLamports(p.trader_post_lamports,'bad_post');delta=(BigInt(post)-BigInt(pre)).toString();if(p.trader_delta_lamports!==delta)return false;ref=`solana_rpc:${p.requested_signature}@${p.slot}`;}else return false;
    if(p.source_reference!==ref||e.source_reference!==ref||e.trader_pre_lamports!==pre||e.trader_post_lamports!==post||e.trader_delta_lamports!==delta)return false;return e.source_hash===hash(p);
  }catch{return false;}
}
