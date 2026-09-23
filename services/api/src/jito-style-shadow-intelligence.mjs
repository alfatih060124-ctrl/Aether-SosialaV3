const MAX_EVENTS = 1000;
const events = [];
const counters = { observed:0, bundle_candidates:0, arbitrage_candidates:0, landed:0, failed:0 };

function clone(value){ return JSON.parse(JSON.stringify(value)); }
function finite(value){ const n=Number(value); return Number.isFinite(n)?n:null; }
function text(value,max=128){ const s=String(value??'').trim(); return s?s.slice(0,max):null; }

export function observeJitoStyleShadowEvent(input={}) {
  const event = {
    event_id: text(input.event_id) || `shadow-${Date.now()}-${counters.observed+1}`,
    observed_at: text(input.observed_at) || new Date().toISOString(),
    signature: text(input.signature,128), bundle_id: text(input.bundle_id,160), slot: finite(input.slot),
    status: text(input.status,32) || 'OBSERVED', transaction_count: Math.max(1,Math.min(5,finite(input.transaction_count)||1)),
    programs: Array.isArray(input.programs)?input.programs.map(x=>text(x,64)).filter(Boolean).slice(0,32):[],
    dexes: Array.isArray(input.dexes)?[...new Set(input.dexes.map(x=>text(x,32)).filter(Boolean))].slice(0,12):[],
    gross_edge_bps: finite(input.gross_edge_bps), estimated_cost_bps: finite(input.estimated_cost_bps),
    expected_net_edge_bps: finite(input.expected_net_edge_bps), source: text(input.source,64)||'SOLANA_JITO_ACTIVITY',
    mode:'SHADOW', non_custodial:true, signer_required:false, signer_used:false,
    transaction_signed:false, execution_dispatched:false, network_submission_authorized:false, live_execution_authorized:false
  };
  event.bundle_candidate = Boolean(event.bundle_id || event.transaction_count>1);
  event.arbitrage_candidate = event.dexes.length>=2 && event.expected_net_edge_bps!==null;
  counters.observed += 1; if(event.bundle_candidate)counters.bundle_candidates += 1; if(event.arbitrage_candidate)counters.arbitrage_candidates += 1;
  if(event.status==='LANDED')counters.landed += 1; if(event.status==='FAILED')counters.failed += 1;
  events.unshift(event); if(events.length>MAX_EVENTS)events.length=MAX_EVENTS; return clone(event);
}
export function getJitoStyleShadowIntelligence({limit=100}={}) {
  const n=Math.max(1,Math.min(500,Number(limit)||100));
  return {
    model:'AETHER_JITO_STYLE_OBSERVABILITY_V1', source_scope:'SOLANA_JITO_ACTIVITY',
    counters:clone(counters), events:clone(events.slice(0,n)),
    opportunity_policy:'OBSERVE_CLASSIFY_SIMULATE_BEFORE_PAPER',
    bundle_transaction_limit:5,
    safety:{mode:'SHADOW',non_custodial:true,private_key_stored:false,seed_phrase_stored:false,signer_required:false,network_submission_authorized:false,live_execution_authorized:false}
  };
}

export function resetJitoStyleShadowIntelligenceForTest(){
  events.length=0;
  for(const key of Object.keys(counters))counters[key]=0;
}