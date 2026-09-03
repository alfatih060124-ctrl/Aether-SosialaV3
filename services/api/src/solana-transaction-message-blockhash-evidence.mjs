import crypto from 'node:crypto';

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP=new Map([...B58].map((c,i)=>[c,i]));
const ENDPOINT_LABEL=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NULL_METRICS=Object.freeze({trades_count:null,total_return_bps:null,win_rate_bps:null,drawdown_bps:null,reputation_score:null});
function fail(m){throw new Error(m)}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype}
function safeInt(v,n,min=0){if(!Number.isSafeInteger(v)||v<min)fail(`${n} must be a safe integer >= ${min}`);return v}
function iso(v,n){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))fail(`${n} must be canonical ISO-8601 UTC`);const ms=Date.parse(v);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==v)fail(`${n} must be canonical ISO-8601 UTC`);return ms}
function decode58(t){if(typeof t!=='string'||!t)fail('Base58 value required');let b=[0];for(const ch of t){const d=B58_MAP.get(ch);if(d===undefined)fail('invalid Base58 character');let carry=d;for(let i=0;i<b.length;i+=1){const x=b[i]*58+carry;b[i]=x&255;carry=x>>8}while(carry>0){b.push(carry&255);carry>>=8}}for(let i=0;i<t.length-1&&t[i]==='1';i+=1)b.push(0);return Uint8Array.from(b.reverse())}
function solId(t,bytes,n){if(typeof t!=='string'||t.length>128||decode58(t).length!==bytes)fail(`${n} must decode to ${bytes} bytes`);return t}
function endpoint(v){if(typeof v!=='string'||!ENDPOINT_LABEL.test(v))fail('rpc_endpoint_label must be opaque and credential-free');return v}
function keys(raw){if(!Array.isArray(raw)||raw.length===0)fail('transaction account keys required');const seen=new Set();return raw.map((r,i)=>{const k=solId(typeof r==='string'?r:r?.pubkey,32,`account_keys[${i}]`);if(seen.has(k))fail('duplicate transaction account key');seen.add(k);return k})}
function canonical(v){if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);if(typeof v==='number'){if(!Number.isFinite(v))fail('non-finite JSON number');return JSON.stringify(v)}if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(plain(v))return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;fail('unsupported JSON value')}
function hash(v){return crypto.createHash('sha256').update(v).digest('hex')}
function base(){return{schema:'aether.solana.transaction_message_blockhash_evidence.v1',collection_status:'PENDING_DATA',metrics_available:false,...NULL_METRICS,verified:false,published:false,live_execution_authorized:false,reconciliation_required:true}}
function finalize(p){return{...base(),source_reference:p.source_reference,recent_blockhash:p.recent_blockhash,provenance:p,source_hash:hash(canonical(p))}}

export async function collectSolanaTransactionMessageBlockhashEvidence({rpcRequest,signature,traderWallet,rpcEndpointLabel,commitment='confirmed',requestStartedAt,observedAt}){
 if(typeof rpcRequest!=='function')fail('rpcRequest function required');
 const sig=solId(signature,64,'signature'),wallet=solId(traderWallet,32,'traderWallet'),label=endpoint(rpcEndpointLabel);
 if(commitment!=='confirmed'&&commitment!=='finalized')fail('commitment must be confirmed or finalized');
 const start=iso(requestStartedAt,'requestStartedAt'),obs=iso(observedAt,'observedAt');if(obs<start)fail('observedAt must not precede requestStartedAt');
 const response=await rpcRequest('getTransaction',[sig,{encoding:'jsonParsed',commitment,maxSupportedTransactionVersion:0}]);
 if(!plain(response)||response.jsonrpc!=='2.0'||!Object.hasOwn(response,'result'))fail('malformed RPC response');
 if(response.result===null)return finalize({schema:'aether.solana.transaction_message_blockhash_provenance.v1',rpc_method:'getTransaction',encoding:'jsonParsed',commitment,rpc_endpoint_label:label,request_started_at:requestStartedAt,observed_at:observedAt,requested_signature:sig,requested_wallet:wallet,found:false,slot:null,block_time:null,transaction_err:null,account_keys:[],recent_blockhash:null,source_reference:null});
 const r=response.result;if(!plain(r)||!plain(r.transaction)||!plain(r.transaction.message)||!plain(r.meta))fail('malformed transaction result');
 if(!Object.hasOwn(r.meta,'err'))fail('meta.err is required');
 const slot=safeInt(r.slot,'slot'),bt=r.blockTime===null?null:safeInt(r.blockTime,'blockTime');if(bt!==null&&bt*1000>obs)fail('blockTime cannot be after observedAt');
 if(!Array.isArray(r.transaction.signatures)||r.transaction.signatures.length<1)fail('transaction signatures required');const returned=solId(r.transaction.signatures[0],64,'returned primary signature');if(returned!==sig)fail('returned primary signature does not match request');
 const accountKeys=keys(r.transaction.message.accountKeys);if(!accountKeys.includes(wallet))fail('requested trader wallet must participate in transaction');
 const txErr=r.meta.err;if(txErr!==null&&!plain(txErr))fail('transaction err must be object or null');
 const recentBlockhash=solId(r.transaction.message.recentBlockhash,32,'recentBlockhash');
 const ref=`solana_rpc:${sig}@${slot}`;
 return finalize({schema:'aether.solana.transaction_message_blockhash_provenance.v1',rpc_method:'getTransaction',encoding:'jsonParsed',commitment,rpc_endpoint_label:label,request_started_at:requestStartedAt,observed_at:observedAt,requested_signature:sig,requested_wallet:wallet,found:true,slot,block_time:bt,transaction_err:txErr,account_keys:accountKeys,recent_blockhash:recentBlockhash,source_reference:ref});
}

export function verifySolanaTransactionMessageBlockhashEvidence(e){
 if(!plain(e)||e.schema!=='aether.solana.transaction_message_blockhash_evidence.v1')fail('invalid evidence schema');
 if(e.collection_status!=='PENDING_DATA'||e.metrics_available!==false||e.verified!==false||e.published!==false||e.live_execution_authorized!==false||e.reconciliation_required!==true)fail('unsafe evidence state');
 for(const k of Object.keys(NULL_METRICS))if(e[k]!==null)fail(`${k} must remain null`);
 const p=e.provenance;if(!plain(p)||p.schema!=='aether.solana.transaction_message_blockhash_provenance.v1')fail('invalid provenance');
 const sig=solId(p.requested_signature,64,'provenance requested signature'),wallet=solId(p.requested_wallet,32,'provenance requested wallet');endpoint(p.rpc_endpoint_label);
 if(p.rpc_method!=='getTransaction'||p.encoding!=='jsonParsed'||(p.commitment!=='confirmed'&&p.commitment!=='finalized'))fail('invalid RPC provenance contract');
 const start=iso(p.request_started_at,'provenance request_started_at'),obs=iso(p.observed_at,'provenance observed_at');if(obs<start)fail('invalid provenance chronology');
 if(p.found===false){if(p.slot!==null||p.block_time!==null||p.transaction_err!==null||p.recent_blockhash!==null||p.source_reference!==null||!Array.isArray(p.account_keys)||p.account_keys.length!==0)fail('not-found evidence must remain empty')}
 else if(p.found===true){const slot=safeInt(p.slot,'provenance slot');if(p.block_time!==null&&safeInt(p.block_time,'provenance block_time')*1000>obs)fail('provenance block_time cannot be after observed_at');if(p.transaction_err!==null&&!plain(p.transaction_err))fail('provenance transaction_err must be object or null');const accountKeys=keys(p.account_keys);if(!accountKeys.includes(wallet))fail('requested wallet missing from provenance account keys');solId(p.recent_blockhash,32,'provenance recent_blockhash');if(p.source_reference!==`solana_rpc:${sig}@${slot}`)fail('source reference mismatch')}
 else fail('found must be boolean');
 if(e.source_reference!==p.source_reference||e.recent_blockhash!==p.recent_blockhash)fail('public evidence/provenance mismatch');
 if(e.source_hash!==hash(canonical(p)))fail('provenance hash mismatch');return true;
}
