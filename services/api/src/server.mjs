import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createTradeEventRepository } from './repositories/trade-events.mjs';
import { createExecutionRequestRepository } from './repositories/execution-requests.mjs';
import { createCoreRepositories } from './repositories/core.mjs';
import { createAdminRepository } from './repositories/admin.mjs';
import { createMarketplaceRepository } from './repositories/marketplace.mjs';
import { createSignalIntelligenceRepository } from './repositories/signal-intelligence.mjs';
import { createWalletInfrastructureRepository } from './repositories/wallet-infrastructure.mjs';
import { runMigrations } from './migration-runner.mjs';
import { runShadowSimulation } from './shadow-simulator.mjs';
import { checkExecutionEngineRental } from './execution-rental-gate.mjs';
import { evaluateSignalQuality, getSignalQualityConfig } from './signal-intelligence.mjs';
import { evaluateAutoTrade } from './auto-trade-engine.mjs';
import { createWalletAuthService } from './wallet-auth.mjs';
import { createAutomaticEvidenceService } from './automatic-evidence-service.mjs';
import { createReconciledPerformanceService } from './reconciled-performance-service.mjs';

const PORT = Number(process.env.PORT || 8080);
const executionMode = process.env.EXECUTION_MODE || 'SHADOW';
const liveEnabled = process.env.LIVE_ENABLED === 'true' && executionMode === 'LIVE';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const repos = pool ? { tradeEvents:createTradeEventRepository(pool), executionRequests:createExecutionRequestRepository(pool), ...createCoreRepositories(pool), admin:createAdminRepository(pool), marketplace:createMarketplaceRepository(pool), signalIntelligence:createSignalIntelligenceRepository(pool), walletInfrastructure:createWalletInfrastructureRepository(pool) } : null;
const walletAuth = pool ? createWalletAuthService(pool) : null;
const automaticEvidence = pool ? createAutomaticEvidenceService(pool,{rpcUrl:process.env.SOLANA_RPC_URL,endpointLabel:process.env.SOLANA_RPC_ENDPOINT_LABEL||'solana-rpc'}) : null;
const reconciledPerformance = pool ? createReconciledPerformanceService(pool) : null;
const VERSION = '2026.09.01-reconciled-performance-shadow';
const send=(res,status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(type.startsWith('text/')?body:JSON.stringify(body));};
const auth=req=>Boolean(process.env.API_TOKEN)&&req.headers.authorization===`Bearer ${process.env.API_TOKEN}`;
const adminAuth=req=>Boolean(process.env.ADMIN_API_TOKEN)&&req.headers.authorization===`Bearer ${process.env.ADMIN_API_TOKEN}`;
const bearerToken=req=>{const value=String(req.headers.authorization||'');return value.startsWith('Bearer ')?value.slice(7).trim():'';};
const jsonBody=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw,'utf8')>32768)throw new Error('request_body_too_large');}return raw?JSON.parse(raw):{};};
const requestUrl=req=>new URL(req.url||'/','http://localhost');
const pathname=req=>requestUrl(req).pathname.replace(/\/+$/,'')||'/';
const parts=req=>pathname(req).split('/').filter(Boolean);
const rentalProjection=r=>r?({rental_id:r.rental_id,trader_id:r.trader_id,status:r.status,monthly_rate_bps:r.monthly_rate_bps,amount_due_usd:r.amount_due_usd,currency:r.currency,period_start:r.period_start,period_end:r.period_end,paid_at:r.paid_at,payment_status:r.payment_status,payment_reference:r.payment_reference,created_at:r.created_at,updated_at:r.updated_at}):null;
const assessmentProjection=r=>r?({source_type:r.source_type,token_mint:r.token_mint,quote_mint:r.quote_mint,quality_score:Number(r.quality_score),verdict:r.verdict,hard_rejects:r.hard_rejects||[],components:r.components||{},snapshot:r.snapshot||{},observed_at:r.observed_at,live_execution_authorized:false,quality_first:true}):null;
const sessionFor=async req=>{if(!walletAuth)return null;const token=bearerToken(req);if(!token)return null;return walletAuth.getSession(token);};
const errorStatus=e=>{const code=String(e?.message||'');if(code==='request_body_too_large')return 413;if(code==='auth_rate_limited')return 429;if(code==='solana_rpc_unconfigured')return 503;if(['solana_rpc_http_error','solana_rpc_error','solana_rpc_timeout'].includes(code))return 502;if(['auth_challenge_used','trader_application_exists','copy_mandate_exists','copy_mandate_cancelled','trader_verification_invalid_state','trader_evidence_invalid_state','trader_publication_gate_failed','reconciliation_conflict'].includes(code))return 409;if(['required_consents_missing','account_not_active','trader_not_copyable','trader_not_shadow','self_copy_not_allowed','synthetic_trade_event_blocked'].includes(code))return 403;if(['trader_application_not_found','copy_mandate_not_found','trader_evidence_not_found','trade_event_not_found'].includes(code))return 404;if(['auth_challenge_not_found','auth_challenge_expired','invalid_wallet_signature','wallet_mismatch','session_invalid'].includes(code))return 401;if(code.startsWith('invalid_')||code.startsWith('reconciliation_')||code.endsWith('_required')||code==='signature_required'||code==='trader_review_invalid_state')return 400;return 500;};

const server=http.createServer(async(req,res)=>{try{
 const route=pathname(req),p=parts(req);
 if(req.method==='GET'&&route==='/api/health')return send(res,200,{status:'ok',service:'aether-api',execution_mode:executionMode,live_enabled:liveEnabled,auth_mode:'WALLET_SIGNATURE',version:VERSION});
 if(req.method==='GET'&&route==='/api/readiness'){if(!pool)return send(res,503,{status:'not_ready',database:'unconfigured',version:VERSION});try{await pool.query('SELECT 1');return send(res,200,{status:'ready',database:'ok',version:VERSION});}catch{return send(res,503,{status:'not_ready',database:'unavailable',version:VERSION});}}
 if(req.method==='GET'&&route==='/api/version')return send(res,200,{version:VERSION,execution_mode:executionMode,live_enabled:liveEnabled});
 if(req.method==='GET'&&route==='/api/execution/status')return send(res,200,{mode:executionMode,live_enabled:liveEnabled,fail_closed:!liveEnabled,signer_exposed_to_api:false});
 if(req.method==='GET'&&route==='/api/signals/config')return send(res,200,{source_type:'MACHINE_INTELLIGENCE',quality_first:true,live_execution_authorized:false,config:getSignalQualityConfig()});
 if(req.method==='GET'&&route==='/api/autotrade/status')return send(res,200,{source_type:'ALGORITHMIC_STRATEGY',mode:'SHADOW',quality_first:true,live_execution_authorized:false,execution_dispatched:false,fail_closed:true});
 if(req.method==='POST'&&route==='/api/auth/challenge'){if(!walletAuth)return send(res,503,{error:'database_unconfigured'});const body=await jsonBody(req);const challenge=await walletAuth.issueChallenge({walletAddress:body.wallet_address,purpose:body.purpose||'LOGIN'});return send(res,201,{challenge});}
 if(req.method==='POST'&&route==='/api/auth/verify'){if(!walletAuth)return send(res,503,{error:'database_unconfigured'});const body=await jsonBody(req);const result=await walletAuth.verifyLogin({challengeId:body.challenge_id,walletAddress:body.wallet_address,signature:body.signature,signatureEncoding:body.signature_encoding||'base64',consents:body.consents||[]});return send(res,200,result);}
 if(req.method==='GET'&&route==='/api/auth/session'){if(!walletAuth)return send(res,503,{error:'database_unconfigured'});const token=bearerToken(req);if(!token)return send(res,401,{error:'session_required'});const session=await walletAuth.getSession(token);if(!session)return send(res,401,{error:'session_invalid'});return send(res,200,{authenticated:true,user:{user_id:session.user_id,username:session.username,display_name:session.display_name,status:session.status,primary_wallet:session.primary_wallet},session:{session_id:session.session_id,expires_at:session.expires_at}});}
 if(req.method==='POST'&&route==='/api/auth/logout'){if(!walletAuth)return send(res,503,{error:'database_unconfigured'});const token=bearerToken(req);if(!token)return send(res,401,{error:'session_required'});const revoked=await walletAuth.revokeSession(token);if(!revoked)return send(res,401,{error:'session_invalid'});return send(res,200,{revoked:true});}

 if(req.method==='GET'&&route==='/api/account/trader'){
   if(!repos||!walletAuth)return send(res,503,{error:'database_unconfigured'});
   const session=await sessionFor(req);if(!session)return send(res,401,{error:'session_required'});
   const trader=await repos.marketplace.getOwnedTrader(session.user_id);
   return send(res,200,{trader,mode:'SHADOW',live_execution_authorized:false,publication_requires_verification:true});
 }
 if(req.method==='POST'&&route==='/api/account/trader/challenge'){
   if(!walletAuth)return send(res,503,{error:'database_unconfigured'});
   const session=await sessionFor(req);if(!session)return send(res,401,{error:'session_required'});
   const challenge=await walletAuth.issueChallenge({walletAddress:session.primary_wallet,purpose:'BECOME_TRADER'});
   return send(res,201,{challenge,live_execution_authorized:false});
 }
 if(req.method==='POST'&&route==='/api/account/trader/apply'){
   if(!repos||!walletAuth)return send(res,503,{error:'database_unconfigured'});
   const session=await sessionFor(req);if(!session)return send(res,401,{error:'session_required'});
   const body=await jsonBody(req);
   if(body.wallet_address!==session.primary_wallet)return send(res,401,{error:'wallet_mismatch'});
   const proof=await walletAuth.verifyOwnership({challengeId:body.challenge_id,walletAddress:body.wallet_address,purpose:'BECOME_TRADER',signature:body.signature,signatureEncoding:body.signature_encoding||'base64'});
   const trader=await repos.marketplace.createTraderApplication({userId:session.user_id,walletAddress:session.primary_wallet,displayName:body.display_name,bio:body.bio||'',strategySummary:body.strategy_summary||''});
   await repos.auditEvents.append({event_type:'TRADER_APPLICATION_SUBMITTED',actor:session.primary_wallet,entity_type:'trader',entity_id:String(trader.trader_id),payload:{user_id:session.user_id,wallet_address:session.primary_wallet,ownership_verified:proof.verified,onboarding_status:trader.onboarding_status,verification_status:trader.verification_status,published:false,mode:'SHADOW',live_execution_authorized:false}});
   return send(res,201,{trader,ownership_proof:{verified:true,purpose:'BECOME_TRADER',transaction_authorized:false,funds_authorized:false},live_execution_authorized:false});
 }

 if(req.method==='GET'&&route==='/api/account/copy-mandates'){
   if(!repos||!walletAuth)return send(res,503,{error:'database_unconfigured'});
   const session=await sessionFor(req);if(!session)return send(res,401,{error:'session_required'});
   return send(res,200,{items:await repos.copyPolicies.listForFollower(session.user_id),mode:'SHADOW',live_execution_authorized:false});
 }
 if(req.method==='POST'&&route==='/api/account/copy-mandates'){
   if(!repos||!walletAuth)return send(res,503,{error:'database_unconfigured'});
   const session=await sessionFor(req);if(!session)return send(res,401,{error:'session_required'});
   const mandate=await repos.copyPolicies.createForFollower(session.user_id,await jsonBody(req));
   await repos.auditEvents.append({event_type:'COPY_MANDATE_CREATED',actor:session.primary_wallet,entity_type:'copy_policy',entity_id:String(mandate.policy_id),payload:{trader_id:mandate.trader_id,mode:'SHADOW',allocation_bps:mandate.allocation_bps,max_copy_amount_usd:mandate.max_copy_amount_usd,max_position_amount_usd:mandate.max_position_amount_usd,max_slippage_bps:mandate.max_slippage_bps,max_daily_loss_bps:mandate.max_daily_loss_bps,stop_drawdown_bps:mandate.stop_drawdown_bps,live_execution_authorized:false}});
   return send(res,201,{mandate,mode:'SHADOW',live_execution_authorized:false});
 }
 if(req.method==='PATCH'&&p[1]==='account'&&p[2]==='copy-mandates'&&p[3]){
   if(!repos||!walletAuth)return send(res,503,{error:'database_unconfigured'});
   const session=await sessionFor(req);if(!session)return send(res,401,{error:'session_required'});
   const body=await jsonBody(req);const mandate=await repos.copyPolicies.updateForFollower(session.user_id,p[3],body);
   await repos.auditEvents.append({event_type:'COPY_MANDATE_UPDATED',actor:session.primary_wallet,entity_type:'copy_policy',entity_id:String(mandate.policy_id),payload:{action:String(body.action||'UPDATE').toUpperCase(),status:mandate.status,enabled:mandate.enabled,mode:'SHADOW',live_execution_authorized:false}});
   return send(res,200,{mandate,mode:'SHADOW',live_execution_authorized:false});
 }

 if(req.method==='POST'&&route==='/api/signals/evaluate'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});const assessment=evaluateSignalQuality(await jsonBody(req));const stored=await repos.signalIntelligence.recordAssessment(assessment);await repos.auditEvents.append({event_type:'MACHINE_SIGNAL_ASSESSED',actor:'signal-intelligence',entity_type:'signal_assessment',entity_id:String(stored.assessment_id),payload:{token_mint:assessment.token_mint,quality_score:assessment.quality_score,verdict:assessment.verdict,hard_rejects:assessment.hard_rejects,live_execution_authorized:false}});return send(res,200,{assessment_id:stored.assessment_id,assessment});}
 if(req.method==='GET'&&route==='/api/signals/recent'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});return send(res,200,{items:await repos.signalIntelligence.recentAssessments(requestUrl(req).searchParams.get('limit'))});}
 if(req.method==='POST'&&route==='/api/autotrade/evaluate'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});if(liveEnabled||executionMode!=='SHADOW')return send(res,423,{error:'autotrade_live_blocked',reason:'shadow_only_foundation'});const body=await jsonBody(req);let assessment,assessmentId=null;if(body.assessment_id){const row=await repos.signalIntelligence.getAssessment(body.assessment_id);if(!row)return send(res,404,{error:'signal_assessment_not_found'});assessment=assessmentProjection(row);assessmentId=row.assessment_id;}else{if(!body.snapshot)return send(res,400,{error:'signal_snapshot_required'});assessment=evaluateSignalQuality(body.snapshot);const row=await repos.signalIntelligence.recordAssessment(assessment);assessmentId=row.assessment_id;}const decision=evaluateAutoTrade({assessment,mandate:body.mandate||{},position:body.position||{},runtime:{liveEnabled}});const storedDecision=await repos.signalIntelligence.recordDecision({assessmentId,decision,mandate:body.mandate||{},position:body.position||{}});await repos.auditEvents.append({event_type:'AUTOTRADE_SHADOW_DECISION',actor:'auto-trade-engine',entity_type:'auto_trade_decision',entity_id:String(storedDecision.decision_id),payload:{assessment_id:assessmentId,token_mint:decision.token_mint,action:decision.action,reason_codes:decision.reason_codes,requested_amount_usd:decision.requested_amount_usd,live_execution_authorized:false}});return send(res,200,{assessment_id:assessmentId,decision_id:storedDecision.decision_id,assessment,decision,execution_dispatched:false});}
 if(req.method==='GET'&&route==='/api/autotrade/decisions'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});return send(res,200,{items:await repos.signalIntelligence.recentDecisions(requestUrl(req).searchParams.get('limit'))});}
 if(req.method==='POST'&&route==='/api/shadow/simulate'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});if(liveEnabled||executionMode!=='SHADOW')return send(res,409,{error:'shadow_simulation_locked',reason:'execution_mode_not_shadow'});const result=await runShadowSimulation({repos,pool,body:await jsonBody(req)});return send(res,result.status,result.body);}
 if(req.method==='GET'&&p[1]==='trades')return send(res,200,{items:await repos.tradeEvents.recent(requestUrl(req).searchParams.get('limit'))});
 if(req.method==='GET'&&p[1]==='traders'){if(p[2]){const t=await repos.marketplace.getTrader(p[2]);return t?send(res,200,t):send(res,404,{error:'trader_not_found'});}return send(res,200,{items:await repos.marketplace.listTraders(requestUrl(req).searchParams.get('limit'))});}
 if(req.method==='GET'&&route==='/api/marketplace/fees')return send(res,200,{config:await repos.marketplace.getFeeConfig()});
 if(req.method==='GET'&&route==='/api/execution/rental/status'){if(!auth(req))return send(res,401,{error:'unauthorized'});const traderId=requestUrl(req).searchParams.get('trader_id');if(!traderId)return send(res,400,{error:'trader_id_required'});return send(res,200,await checkExecutionEngineRental(pool,traderId));}
 if(req.method==='POST'&&route==='/api/execution/rental'){if(!auth(req))return send(res,401,{error:'unauthorized'});const body=await jsonBody(req);if(!body.trader_id)return send(res,400,{error:'trader_id_required'});const trader=await repos.marketplace.getTrader(body.trader_id);if(!trader)return send(res,404,{error:'trader_not_found'});const start=new Date(body.period_start||Date.now()),end=body.period_end?new Date(body.period_end):new Date(start.getTime()+30*24*60*60*1000);if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start)return send(res,400,{error:'invalid_rental_period'});const feeConfig=await repos.marketplace.getFeeConfig(),rate=Number(body.monthly_rate_bps??feeConfig?.execution_rental_fee_bps??300),amount=Number(body.amount_due_usd??0);if(!Number.isInteger(rate)||rate<0||rate>10000)return send(res,400,{error:'invalid_rental_rate'});if(!Number.isFinite(amount)||amount<0)return send(res,400,{error:'invalid_rental_amount'});const paid=body.payment_status==='PAID'||Boolean(body.paid_at);const q=await pool.query(`INSERT INTO execution_engine_rentals (trader_id,status,monthly_rate_bps,amount_due_usd,period_start,period_end,paid_at,payment_status,payment_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[body.trader_id,paid?'ACTIVE':'PAST_DUE',rate,amount,start,end,body.paid_at?new Date(body.paid_at):null,paid?'PAID':'PENDING',body.payment_reference||null]);const rental=q.rows[0];await pool.query(`INSERT INTO billing_ledger(trader_id,rental_id,fee_type,amount_usd,currency,status,period_start,period_end,reference_id) VALUES($1,$2,'EXECUTION_ENGINE_RENTAL',$3,$4,$5,$6,$7,$8)`,[rental.trader_id,rental.rental_id,rental.amount_due_usd,rental.currency,paid?'PAID':'PENDING',rental.period_start,rental.period_end,rental.payment_reference||String(rental.rental_id)]);return send(res,201,{rental:rentalProjection(rental)});}
 if(req.method==='PATCH'&&route==='/api/execution/rental/payment'){if(!auth(req))return send(res,401,{error:'unauthorized'});const body=await jsonBody(req);if(!body.rental_id)return send(res,400,{error:'rental_id_required'});if(!['PAID','FAILED','REFUNDED','VOID','PENDING'].includes(body.payment_status))return send(res,400,{error:'invalid_payment_status'});const paid=body.payment_status==='PAID';const q=await pool.query(`UPDATE execution_engine_rentals SET payment_status=$1,payment_reference=COALESCE($2,payment_reference),paid_at=CASE WHEN $3 THEN COALESCE(paid_at,now()) ELSE paid_at END,status=CASE WHEN $3 AND period_end>now() THEN 'ACTIVE' WHEN $4='PAID' AND period_end<=now() THEN 'EXPIRED' ELSE status END,updated_at=now() WHERE rental_id=$5 RETURNING *`,[body.payment_status,body.payment_reference||null,paid,body.payment_status,body.rental_id]);if(!q.rows[0])return send(res,404,{error:'rental_not_found'});const rental=q.rows[0];await pool.query(`UPDATE billing_ledger SET status=$1,reference_id=COALESCE($2,reference_id) WHERE rental_id=$3 AND fee_type='EXECUTION_ENGINE_RENTAL' AND status<>'VOID'`,[paid?'PAID':body.payment_status,body.payment_reference||null,rental.rental_id]);return send(res,200,{rental:rentalProjection(rental)});}
 if(req.method==='GET'&&route==='/api/execution/rentals'){if(!auth(req))return send(res,401,{error:'unauthorized'});const traderId=requestUrl(req).searchParams.get('trader_id'),q=await pool.query(`SELECT rental_id,trader_id,status,monthly_rate_bps,amount_due_usd,currency,period_start,period_end,paid_at,payment_status,payment_reference,created_at,updated_at FROM execution_engine_rentals ${traderId?'WHERE trader_id=$1':''} ORDER BY created_at DESC LIMIT 200`,traderId?[traderId]:[]);return send(res,200,{items:q.rows.map(rentalProjection)});}
 if(req.method==='POST'&&route==='/api/executions'){if(!auth(req))return send(res,401,{error:'unauthorized'});const body=await jsonBody(req),mode=body.mode||'SHADOW';if(mode==='LIVE')return send(res,423,{error:'live_execution_blocked'});const access=await checkExecutionEngineRental(pool,body.trader_id);if(!access.allowed)return send(res,403,{error:'execution_engine_rental_required',reason:access.reason,rental:access.rental??null});return send(res,201,await repos.executionRequests.create({...body,mode}));}
 if(req.method==='GET'&&route==='/api/executions'){if(!auth(req))return send(res,401,{error:'unauthorized'});return send(res,200,{items:(await pool.query('SELECT * FROM execution_requests ORDER BY created_at DESC LIMIT 200')).rows});}

 if(req.method==='POST'&&p[1]==='internal'&&p[2]==='traders'&&p[3]&&p[4]==='reconciled-trades'){
   if(!auth(req))return send(res,401,{error:'unauthorized'});
   if(!reconciledPerformance||!repos)return send(res,503,{error:'database_unconfigured'});
   if(liveEnabled||executionMode!=='SHADOW')return send(res,423,{error:'reconciliation_shadow_only'});
   const rows=await reconciledPerformance.recordTrades(p[3],await jsonBody(req));
   await repos.auditEvents.append({event_type:'TRADER_RECONCILED_TRADES_RECORDED',actor:'reconciliation-service',entity_type:'trader',entity_id:String(p[3]),payload:{count:rows.length,trade_event_ids:rows.map(r=>r.trade_event_id),source_hashes:rows.map(r=>r.source_hash),mode:'SHADOW',verified:false,published:false,live_execution_authorized:false}});
   return send(res,201,{items:rows,mode:'SHADOW',verification_authorized:false,publication_authorized:false,live_execution_authorized:false});
 }
 if(req.method==='GET'&&p[1]==='internal'&&p[2]==='traders'&&p[3]&&p[4]==='reconciled-trades'){
   if(!auth(req))return send(res,401,{error:'unauthorized'});
   if(!reconciledPerformance)return send(res,503,{error:'database_unconfigured'});
   return send(res,200,{items:await reconciledPerformance.listTrades(p[3],requestUrl(req).searchParams.get('limit')),mode:'SHADOW',live_execution_authorized:false});
 }

 if(route.startsWith('/api/admin/')){if(!adminAuth(req))return send(res,401,{error:'admin_unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});}
 if(req.method==='GET'&&route==='/api/admin/wallets'){const [items,readiness]=await Promise.all([repos.walletInfrastructure.list(),repos.walletInfrastructure.readiness()]);return send(res,200,{items,readiness});}
 if(req.method==='GET'&&route==='/api/admin/wallets/readiness')return send(res,200,await repos.walletInfrastructure.readiness());
 if(req.method==='PUT'&&p[1]==='admin'&&p[2]==='wallets'&&p[3]){const wallet=await repos.walletInfrastructure.upsert(p[3],await jsonBody(req));await repos.auditEvents.append({event_type:'PLATFORM_WALLET_CONFIG_UPDATED',actor:'admin',entity_type:'platform_wallet',entity_id:wallet.role,payload:{role:wallet.role,network:wallet.network,public_address:wallet.public_address,custody_model:wallet.custody_model,enabled:wallet.enabled,verification_status:wallet.verification_status,private_key_stored:false}});return send(res,200,{wallet,readiness:await repos.walletInfrastructure.readiness()});}
 if(req.method==='GET'&&route==='/api/admin/risk')return send(res,200,{items:await repos.admin.recentRiskDecisions()});
 if(req.method==='GET'&&route==='/api/admin/audit')return send(res,200,{items:await repos.admin.recentAuditEvents()});
 if(req.method==='GET'&&route==='/api/admin/traders/applications')return send(res,200,{items:await repos.marketplace.listTraderApplications(requestUrl(req).searchParams.get('limit'))});
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='review'){const body=await jsonBody(req);const trader=await repos.marketplace.reviewTraderApplication(p[3],body);await repos.auditEvents.append({event_type:'TRADER_APPLICATION_REVIEWED',actor:'admin',entity_type:'trader',entity_id:String(trader.trader_id),payload:{decision:String(body.decision||'').toUpperCase(),onboarding_status:trader.onboarding_status,verification_status:trader.verification_status,published:trader.published,live_execution_authorized:false}});return send(res,200,{trader,publication_authorized:false,reason:'verifiable_data_required'});}
 if(req.method==='GET'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='evidence'&&p[5]==='collections')return send(res,200,{items:await automaticEvidence.listCollections(p[3],requestUrl(req).searchParams.get('limit')),mode:'SHADOW',live_execution_authorized:false});
 if(req.method==='POST'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='evidence'&&p[5]==='collect'){
   if(!automaticEvidence)return send(res,503,{error:'database_unconfigured'});
   const collection=await automaticEvidence.collectSolana(p[3],await jsonBody(req));
   await repos.auditEvents.append({event_type:'TRADER_SOLANA_EVIDENCE_COLLECTED',actor:'admin',entity_type:'trader_evidence_collection',entity_id:String(collection.collection_id),payload:{trader_id:collection.trader_id,source_type:collection.source_type,source_reference:collection.source_reference,collection_status:collection.collection_status,reason:collection.reason,source_hash:collection.provenance?.source_hash||null,metrics_available:false,verified:false,published:false,live_execution_authorized:false}});
   return send(res,201,{collection,evidence_recorded:false,verification_authorized:false,publication_authorized:false,live_execution_authorized:false});
 }
 if(req.method==='POST'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='evidence'&&p[5]==='reconcile'){
   if(!reconciledPerformance)return send(res,503,{error:'database_unconfigured'});
   if(liveEnabled||executionMode!=='SHADOW')return send(res,423,{error:'reconciliation_shadow_only'});
   const result=await reconciledPerformance.buildPerformanceEvidence(p[3]);
   await repos.auditEvents.append({event_type:'TRADER_RECONCILED_PERFORMANCE_EVIDENCE_BUILT',actor:'admin',entity_type:'trader_evidence_collection',entity_id:String(result.collection?.collection_id||''),payload:{trader_id:p[3],collection_status:result.collection?.collection_status,source_reference:result.collection?.source_reference,metrics_available:result.collection?.metrics_available===true,trades_count:result.collection?.trades_count,reputation_score:result.collection?.reputation_score,evidence_id:result.evidence?.evidence_id||null,reused:result.reused===true,verified:false,published:false,live_execution_authorized:false}});
   return send(res,result.reused?200:201,{...result,evidence_recorded:Boolean(result.evidence),verification_authorized:false,publication_authorized:false,live_execution_authorized:false});
 }
 if(req.method==='GET'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='evidence'&&!p[5])return send(res,200,{items:await repos.marketplace.listTraderVerificationEvidence(p[3],requestUrl(req).searchParams.get('limit'))});
 if(req.method==='POST'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='evidence'&&!p[5]){const evidence=await repos.marketplace.recordTraderVerificationEvidence(p[3],await jsonBody(req));await repos.auditEvents.append({event_type:'TRADER_VERIFICATION_EVIDENCE_RECORDED',actor:'admin',entity_type:'trader_verification_evidence',entity_id:String(evidence.evidence_id),payload:{trader_id:evidence.trader_id,source_type:evidence.source_type,source_reference:evidence.source_reference,observed_at:evidence.observed_at,evidence_status:evidence.evidence_status,live_execution_authorized:false}});return send(res,201,{evidence,publication_authorized:false});}
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='verification'){const body=await jsonBody(req);const trader=await repos.marketplace.reviewTraderVerification(p[3],body);await repos.auditEvents.append({event_type:'TRADER_DATA_VERIFICATION_REVIEWED',actor:'admin',entity_type:'trader',entity_id:String(trader.trader_id),payload:{decision:String(body.decision||'').toUpperCase(),evidence_id:body.evidence_id,verification_status:trader.verification_status,verified:trader.verified,published:trader.published,verification_source:trader.verification_source,live_execution_authorized:false}});return send(res,200,{trader,publication_authorized:false,publication_requires_explicit_action:true});}
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='traders'&&p[3]&&p[4]==='publication'){const body=await jsonBody(req);const trader=await repos.marketplace.setTraderPublished(p[3],body);await repos.auditEvents.append({event_type:trader.published?'TRADER_MARKETPLACE_PUBLISHED':'TRADER_MARKETPLACE_UNPUBLISHED',actor:'admin',entity_type:'trader',entity_id:String(trader.trader_id),payload:{published:trader.published,onboarding_status:trader.onboarding_status,verification_status:trader.verification_status,verified:trader.verified,mode:trader.mode,live_execution_authorized:false}});return send(res,200,{trader,live_execution_authorized:false});}
 if(req.method==='GET'&&route==='/api/admin/copy-policies')return send(res,200,{items:await repos.admin.listCopyPolicies(requestUrl(req).searchParams.get('limit')),mode:'SHADOW',live_execution_authorized:false});
 if(req.method==='GET'&&route==='/api/admin/rentals')return send(res,200,{items:(await pool.query(`SELECT rental_id,trader_id,status,monthly_rate_bps,amount_due_usd,currency,period_start,period_end,paid_at,payment_status,payment_reference,created_at,updated_at FROM execution_engine_rentals ORDER BY created_at DESC LIMIT 200`)).rows.map(rentalProjection)});
 if(req.method==='GET'&&route==='/api/admin/billing/ledger')return send(res,200,{items:(await pool.query(`SELECT * FROM billing_ledger ORDER BY created_at DESC LIMIT 200`)).rows});
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='copy-policies'&&p[3]){const body=await jsonBody(req);const updated=await repos.admin.updateCopyPolicy(p[3],body);if(!updated)return send(res,404,{error:'copy_policy_not_found'});await repos.auditEvents.append({event_type:'ADMIN_COPY_MANDATE_UPDATED',actor:'admin',entity_type:'copy_policy',entity_id:String(updated.policy_id),payload:{enabled:updated.enabled,status:updated.status,mode:'SHADOW',live_execution_authorized:false}});return send(res,200,{mandate:updated,mode:'SHADOW',live_execution_authorized:false});}
 if(req.method==='PATCH'&&route==='/api/admin/fees'){const config=await repos.marketplace.updateFeeConfig(await jsonBody(req));await repos.auditEvents.append({event_type:'PLATFORM_FEE_CONFIG_UPDATED',actor:'admin',entity_type:'platform_fee_config',entity_id:String(config.config_id),payload:{performance_fee_bps:config.performance_fee_bps,execution_fee_bps:config.execution_fee_bps,execution_rental_fee_bps:config.execution_rental_fee_bps,enabled:config.enabled}});return send(res,200,{config});}
 if(req.method==='GET'&&(route==='/'||route==='/dashboard'))return send(res,200,fs.readFileSync(path.resolve(process.cwd(),'web/dashboard.html'),'utf8'),'text/html; charset=utf-8');
 if(req.method==='GET'&&route==='/admin')return send(res,200,fs.readFileSync(path.resolve(process.cwd(),'web/admin.html'),'utf8'),'text/html; charset=utf-8');
 return send(res,404,{error:'not_found',path:route,method:req.method});
 }catch(e){console.error(e);return send(res,errorStatus(e),{error:e.message});}});
async function start(){if(pool)await runMigrations(pool,path.resolve(process.cwd(),'migrations'));server.listen(PORT,'0.0.0.0',()=>console.log(`Aether API listening on ${PORT}`));}
start().catch(e=>{console.error('startup_failed',e);process.exit(1);});
