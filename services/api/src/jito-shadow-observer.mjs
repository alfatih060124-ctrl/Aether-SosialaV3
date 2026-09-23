import { createJitoReadonlyMarketSource } from './jito-readonly-market-source.mjs';
import { observeJitoStyleShadowEvent } from './jito-style-shadow-intelligence.mjs';

const POLL_MS=Math.max(1000,Number(process.env.AETHER_JITO_SHADOW_POLL_MS||5000));
let timer=null; let cycles=0; let lastError=null; let lastObservedAt=null;

export function startJitoShadowObserver({source=createJitoReadonlyMarketSource()}={}){
  if(timer)return status();
  const poll=async()=>{
    cycles+=1;
    try{
      const tips=await source.getTipAccounts();
      observeJitoStyleShadowEvent({event_id:`jito-tip-snapshot-${Date.now()}`,status:'OBSERVED',transaction_count:1,programs:[],dexes:[],source:'JITO_BLOCK_ENGINE_READONLY',observed_at:new Date().toISOString()});
      lastObservedAt=new Date().toISOString(); lastError=null;
      return Array.isArray(tips)?tips.length:0;
    }catch(error){lastError=String(error?.message||error);return 0;}
  };
  poll(); timer=setInterval(poll,POLL_MS); timer.unref?.(); return status();
}
export function stopJitoShadowObserver(){if(timer){clearInterval(timer);timer=null;}return status();}
export function getJitoShadowObserverStatus(){return status();}
function status(){return {enabled:Boolean(timer),poll_ms:POLL_MS,cycles,last_observed_at:lastObservedAt,last_error:lastError,source:'JITO_BLOCK_ENGINE_READONLY',mode:'SHADOW',non_custodial:true,network_submission_authorized:false,live_execution_authorized:false};}