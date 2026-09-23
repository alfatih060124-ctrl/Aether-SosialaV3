const DEFAULT_ORIGIN='https://mainnet.block-engine.jito.wtf';
const DEFAULT_TIMEOUT_MS=5000;
const ALLOWED_METHODS=new Set(['getTipAccounts','getBundleStatuses','getInflightBundleStatuses']);

async function rpc(method,params=[],{origin=DEFAULT_ORIGIN,timeoutMs=DEFAULT_TIMEOUT_MS,fetchImpl=fetch}={}){
  if(!ALLOWED_METHODS.has(method))throw new Error('jito_readonly_method_blocked');
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(`${origin}/api/v1/bundles`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
    if(!response.ok)throw new Error(`jito_readonly_http_${response.status}`);
    const body=await response.json(); if(body?.error)throw new Error('jito_readonly_rpc_error'); return body?.result??null;
  }finally{clearTimeout(timer);}
}

export function createJitoReadonlyMarketSource(options={}){
  return {
    getTipAccounts:()=>rpc('getTipAccounts',[],options),
    getBundleStatuses:ids=>rpc('getBundleStatuses',[[...new Set(ids||[])].slice(0,5)],options),
    getInflightBundleStatuses:ids=>rpc('getInflightBundleStatuses',[[...new Set(ids||[])].slice(0,5)],options),
    safety:{read_only:true,send_transaction:false,send_bundle:false,signer_required:false,non_custodial:true,live_execution_authorized:false}
  };
}