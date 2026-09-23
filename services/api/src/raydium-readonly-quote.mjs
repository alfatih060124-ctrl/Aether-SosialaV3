const ORIGIN='https://transaction-v1.raydium.io';
export function createRaydiumReadonlyQuoteService({timeoutMs=300,cacheTtlMs=400}={}){
 const cache=new Map();
 async function quote({inputMint,outputMint,amount,slippageBps=50}){
  const key=`${inputMint}:${outputMint}:${amount}:${slippageBps}`, hit=cache.get(key);
  if(hit && Date.now()-hit.at<=cacheTtlMs)return {...hit.value,cache_hit:true,latency_ms:0};
  const u=new URL('/compute/swap-base-in',ORIGIN); for(const [k,v] of Object.entries({inputMint,outputMint,amount:String(amount),slippageBps:String(slippageBps),txVersion:'V0'}))u.searchParams.set(k,v);
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs),started=Date.now();
  try{const r=await fetch(u,{signal:c.signal,headers:{accept:'application/json'}}); if(r.status===429)throw new Error('raydium_quote_rate_limited'); if(!r.ok)throw new Error(`raydium_quote_http_${r.status}`); const b=await r.json(); if(b?.success!==true||!b?.data?.outputAmount)throw new Error('raydium_quote_unavailable'); const value={provider:'RAYDIUM',latency_ms:Date.now()-started,cache_hit:false,...b.data}; cache.set(key,{at:Date.now(),value}); return value;}finally{clearTimeout(timer)}
 }
 return {quote,safety:{read_only:true,transaction_submission:false,signer_requested:false,live_execution_authorized:false}};
}