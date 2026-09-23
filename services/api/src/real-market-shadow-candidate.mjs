import { rankCrossVenueReportPairs } from './cross-venue-net-edge.mjs';

function uniqueMints(parsed){return [...new Set(parsed?.token_mints||[])].filter(Boolean);}
export async function evaluateRealMarketShadowTransaction(parsed,{quoteService,usdcAmountRaw='100000000',minimumNetEdgeBps=0}={}){
 if(!parsed?.success)return {source:'REAL_SOLANA_TRANSACTION',candidates:[],reason:'CHAIN_TRANSACTION_NOT_SUCCESSFUL'};
 if(!quoteService?.getUsdcRoundTripEvidence)throw new Error('quote_service_required');
 const candidates=[];
 for(const mint of uniqueMints(parsed)){
  try{
   const evidence=await quoteService.getUsdcRoundTripEvidence(mint,{usdcAmountRaw});
   const pairs=rankCrossVenueReportPairs(evidence);
   const best=pairs[0]||null;
   const quoteEdge=Number(evidence.roundtrip_quote_edge_bps);
   const threshold=Number.isFinite(Number(minimumNetEdgeBps))?Number(minimumNetEdgeBps):0;
   candidates.push({mint,chain_signature:parsed.signature,chain_slot:parsed.slot,market_source:'SOLANA_RPC_REAL_TRANSACTION',quote_source:'JUPITER_QUOTE_API',cross_venue_pair:best,roundtrip_quote_edge_bps:Number.isFinite(quoteEdge)?quoteEdge:null,minimum_net_edge_bps:threshold,approval_state:'PENDING_COST_EVIDENCE',approved:false,reason:'FINAL_POST_COST_NET_EDGE_REQUIRED',mode:'SHADOW',execution_dispatched:false,live_execution_authorized:false});
  }catch(error){candidates.push({mint,chain_signature:parsed.signature,market_source:'SOLANA_RPC_REAL_TRANSACTION',approval_state:'REJECTED',approved:false,reason:String(error?.message||error),mode:'SHADOW',execution_dispatched:false,live_execution_authorized:false});}
 }
 return {source:'REAL_SOLANA_TRANSACTION',signature:parsed.signature,candidates,approval_key:'POST_COST_NET_EDGE',token_universe_policy:'ALL_MINTS_OBSERVED_IN_REAL_TRANSACTION'};
}