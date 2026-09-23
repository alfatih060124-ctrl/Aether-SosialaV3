const TIMEOUT_MS=6000;
async function rpc(method,params,{rpcUrl=process.env.SOLANA_RPC_URL,fetchImpl=fetch,timeoutMs=TIMEOUT_MS}={}){
  if(!['getSignaturesForAddress','getTransaction'].includes(method))throw new Error('solana_readonly_method_blocked');
  if(!rpcUrl)throw new Error('solana_rpc_unconfigured');
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
    if(!r.ok)throw new Error(`solana_readonly_http_${r.status}`);
    const b=await r.json(); if(b?.error)throw new Error('solana_readonly_rpc_error'); return b?.result??null;
  }finally{clearTimeout(timer);}
}
export function createSolanaReadonlyTransactionSource(options={}){
  return {
    getSignaturesForAddress:(address,limit=20)=>rpc('getSignaturesForAddress',[address,{commitment:'confirmed',limit:Math.max(1,Math.min(1000,Number(limit)||20))}],options),
    getTransaction:signature=>rpc('getTransaction',[signature,{commitment:'confirmed',encoding:'jsonParsed',maxSupportedTransactionVersion:0}],options),
    safety:{read_only:true,signer_required:false,send_transaction:false,network_submission_authorized:false,non_custodial:true,live_execution_authorized:false}
  };
}