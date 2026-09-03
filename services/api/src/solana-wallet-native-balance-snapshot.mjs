import { createHash } from 'node:crypto';

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET=new Set(B58);
const U64_MAX=(1n<<64n)-1n;
function fail(code){const e=new Error(code);e.code=code;throw e;}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function stable(v){if(Array.isArray(v))return`[${v.map(stable).join(',')}]`;if(plain(v))return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;return JSON.stringify(v);}
function hash(v){return createHash('sha256').update(stable(v)).digest('hex');}
function b58len(text){if(typeof text!=='string'||!text.length)return-1;let n=0n;for(const ch of text){if(!B58_SET.has(ch))return-1;n=n*58n+BigInt(B58.indexOf(ch));}let bytes=0,x=n;while(x>0n){bytes++;x>>=8n;}let leading=0;while(leading<text.length&&text[leading]==='1')leading++;return bytes+leading;}
function solId(v,bytes,code){if(b58len(v)!==bytes)fail(code);return v;}
function safeInt(v,code){if(!Number.isSafeInteger(v)||v<0)fail(code);return v;}
function iso(v,code){if(typeof v!=='string')fail(code);const ms=Date.parse(v);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==v)fail(code);return ms;}
function label(v){if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v))fail('invalid_rpc_endpoint_label');return v;}
function lamports(v,code){if(!Number.isSafeInteger(v)||v<0)fail(code);const n=BigInt(v);if(n>U64_MAX)fail(code);return n.toString();}
function solDecimal(raw){const n=BigInt(raw);const whole=n/1000000000n;const frac=(n%1000000000n).toString().padStart(9,'0');return `${whole}.${frac}`;}
function envelope(p){return{schema:'aether.solana.wallet_native_balance_snapshot.v1',collection_status:'PENDING_DATA',metrics_available:false,trades_count:null,total_return_bps:null,win_rate_bps:null,drawdown_bps:null,reputation_score:null,verified:false,published:false,live_execution_authorized:false,reconciliation_required:true,source_reference:null,lamports:p.lamports,sol_decimal:p.sol_decimal,provenance:p,source_hash:hash(p)};}

export async function collectSolanaWalletNativeBalanceSnapshot({rpc,traderWallet,commitment='confirmed',endpointLabel='solana_rpc',requestedAt,observedAt,minContextSlot=null}){
  if(typeof rpc!=='function')fail('rpc_required');const requested_wallet=solId(traderWallet,32,'invalid_trader_wallet');if(!['confirmed','finalized'].includes(commitment))fail('invalid_commitment');const endpoint_label=label(endpointLabel);const req=iso(requestedAt,'invalid_requested_at'),obs=iso(observedAt,'invalid_observed_at');if(obs<req)fail('invalid_observation_chronology');let min_context_slot=null;if(minContextSlot!==null)min_context_slot=safeInt(minContextSlot,'invalid_min_context_slot');
  const cfg={commitment};if(min_context_slot!==null)cfg.minContextSlot=min_context_slot;const request={method:'getBalance',params:[requested_wallet,cfg]};const response=await rpc(request);if(!plain(response)||!plain(response.result)||!plain(response.result.context))fail('invalid_rpc_response');const context_slot=safeInt(response.result.context.slot,'invalid_context_slot');if(min_context_slot!==null&&context_slot<min_context_slot)fail('context_slot_below_minimum');const raw_lamports=lamports(response.result.value,'invalid_lamports');const sol_decimal=solDecimal(raw_lamports);
  return envelope({source_type:'SOLANA_RPC',rpc_method:'getBalance',endpoint_label,requested_wallet,commitment,min_context_slot,requested_at:requestedAt,observed_at:observedAt,context_slot,lamports:raw_lamports,sol_decimal,source_reference_policy:'NONE_NON_TRANSACTION_SNAPSHOT'});
}

export function verifySolanaWalletNativeBalanceSnapshot(e){
  if(!plain(e)||e.schema!=='aether.solana.wallet_native_balance_snapshot.v1')return false;
  try{if(e.collection_status!=='PENDING_DATA'||e.metrics_available!==false||e.verified!==false||e.published!==false||e.live_execution_authorized!==false||e.reconciliation_required!==true||e.source_reference!==null)return false;for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])if(e[k]!==null)return false;const p=e.provenance;if(!plain(p)||p.source_type!=='SOLANA_RPC'||p.rpc_method!=='getBalance'||p.source_reference_policy!=='NONE_NON_TRANSACTION_SNAPSHOT')return false;solId(p.requested_wallet,32,'bad_wallet');if(!['confirmed','finalized'].includes(p.commitment))return false;label(p.endpoint_label);const req=iso(p.requested_at,'bad_requested_at'),obs=iso(p.observed_at,'bad_observed_at');if(obs<req)return false;safeInt(p.context_slot,'bad_context_slot');if(p.min_context_slot!==null){safeInt(p.min_context_slot,'bad_min_context_slot');if(p.context_slot<p.min_context_slot)return false;}const raw=lamports(Number(p.lamports),'bad_lamports');if(raw!==p.lamports)return false;const decimal=solDecimal(raw);if(decimal!==p.sol_decimal||e.lamports!==raw||e.sol_decimal!==decimal)return false;return e.source_hash===hash(p);}catch{return false;}
}
