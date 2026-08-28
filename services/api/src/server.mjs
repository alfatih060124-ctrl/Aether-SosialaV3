import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createTradeEventRepository } from './repositories/trade-events.mjs';
import { createExecutionRequestRepository } from './repositories/execution-requests.mjs';
import { createCoreRepositories } from './repositories/core.mjs';
import { createAdminRepository } from './repositories/admin.mjs';
import { createMarketplaceRepository } from './repositories/marketplace.mjs';
import { runMigrations } from './migration-runner.mjs';
import { runShadowSimulation } from './shadow-simulator.mjs';
import { checkExecutionEngineRental } from './execution-rental-gate.mjs';

const PORT = Number(process.env.PORT || 8080);
const executionMode = process.env.EXECUTION_MODE || 'SHADOW';
const liveEnabled = process.env.LIVE_ENABLED === 'true' && executionMode === 'LIVE';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const repos = pool ? { tradeEvents:createTradeEventRepository(pool), executionRequests:createExecutionRequestRepository(pool), ...createCoreRepositories(pool), admin:createAdminRepository(pool), marketplace:createMarketplaceRepository(pool) } : null;
const VERSION = '2026.08.28-rental-billing';
const send=(res,status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(type.startsWith('text/')?body:JSON.stringify(body));};
const auth=req=>!process.env.API_TOKEN||req.headers.authorization===`Bearer ${process.env.API_TOKEN}`;
const jsonBody=async req=>{let raw='';for await(const chunk of req)raw+=chunk;return raw?JSON.parse(raw):{};};
const requestUrl=req=>new URL(req.url||'/','http://localhost');
const pathname=req=>requestUrl(req).pathname.replace(/\/+$/,'')||'/';
const parts=req=>pathname(req).split('/').filter(Boolean);
const rentalProjection=r=>r?({rental_id:r.rental_id,trader_id:r.trader_id,status:r.status,monthly_rate_bps:r.monthly_rate_bps,amount_due_usd:r.amount_due_usd,currency:r.currency,period_start:r.period_start,period_end:r.period_end,paid_at:r.paid_at,payment_status:r.payment_status,payment_reference:r.payment_reference,created_at:r.created_at,updated_at:r.updated_at}):null;

const server=http.createServer(async(req,res)=>{try{
 const route=pathname(req),p=parts(req);
 if(req.method==='GET'&&route==='/api/health')return send(res,200,{status:'ok',service:'aether-api',execution_mode:executionMode,live_enabled:liveEnabled,version:VERSION});
 if(req.method==='GET'&&route==='/api/readiness'){if(!pool)return send(res,503,{status:'not_ready',database:'unconfigured',version:VERSION});try{await pool.query('SELECT 1');return send(res,200,{status:'ready',database:'ok',version:VERSION});}catch{return send(res,503,{status:'not_ready',database:'unavailable',version:VERSION});}}
 if(req.method==='GET'&&route==='/api/version')return send(res,200,{version:VERSION,execution_mode:executionMode,live_enabled:liveEnabled});
 if(req.method==='GET'&&route==='/api/execution/status')return send(res,200,{mode:executionMode,live_enabled:liveEnabled,fail_closed:!liveEnabled,signer_exposed_to_api:false});
 if(req.method==='POST'&&route==='/api/shadow/simulate'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});if(liveEnabled||executionMode!=='SHADOW')return send(res,409,{error:'shadow_simulation_locked',reason:'execution_mode_not_shadow'});const result=await runShadowSimulation({repos,pool,body:await jsonBody(req)});return send(res,result.status,result.body);}
 if(!auth(req)&&route.startsWith('/api/'))return send(res,401,{error:'unauthorized'});if(!repos&&route.startsWith('/api/'))return send(res,503,{error:'database_unconfigured'});
 if(req.method==='GET'&&p[1]==='trades')return send(res,200,{items:await repos.tradeEvents.recent(requestUrl(req).searchParams.get('limit'))});
 if(req.method==='GET'&&p[1]==='traders'){if(p[2]){const t=await repos.marketplace.getTrader(p[2]);return t?send(res,200,t):send(res,404,{error:'trader_not_found'});}return send(res,200,{items:await repos.marketplace.listTraders(requestUrl(req).searchParams.get('limit'))});}
 if(req.method==='GET'&&route==='/api/marketplace/fees')return send(res,200,{config:await repos.marketplace.getFeeConfig()});
 if(req.method==='GET'&&route==='/api/execution/rental/status'){const traderId=requestUrl(req).searchParams.get('trader_id');if(!traderId)return send(res,400,{error:'trader_id_required'});return send(res,200,await checkExecutionEngineRental(pool,traderId));}
 if(req.method==='POST'&&route==='/api/execution/rental'){const body=await jsonBody(req);if(!body.trader_id)return send(res,400,{error:'trader_id_required'});const trader=await repos.marketplace.getTrader(body.trader_id);if(!trader)return send(res,404,{error:'trader_not_found'});const start=new Date(body.period_start||Date.now()),end=body.period_end?new Date(body.period_end):new Date(start.getTime()+30*24*60*60*1000);if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start)return send(res,400,{error:'invalid_rental_period'});const feeConfig=await repos.marketplace.getFeeConfig(),rate=Number(body.monthly_rate_bps??feeConfig?.execution_rental_fee_bps??300),amount=Number(body.amount_due_usd??0);if(!Number.isInteger(rate)||rate<0||rate>10000)return send(res,400,{error:'invalid_rental_rate'});if(!Number.isFinite(amount)||amount<0)return send(res,400,{error:'invalid_rental_amount'});const paid=body.payment_status==='PAID'||Boolean(body.paid_at);const q=await pool.query(`INSERT INTO execution_engine_rentals (trader_id,status,monthly_rate_bps,amount_due_usd,period_start,period_end,paid_at,payment_status,payment_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[body.trader_id,paid?'ACTIVE':'PAST_DUE',rate,amount,start,end,body.paid_at?new Date(body.paid_at):null,paid?'PAID':'PENDING',body.payment_reference||null]);const rental=q.rows[0];await pool.query(`INSERT INTO billing_ledger(trader_id,rental_id,fee_type,amount_usd,currency,status,period_start,period_end,reference_id) VALUES($1,$2,'EXECUTION_ENGINE_RENTAL',$3,$4,$5,$6,$7,$8)`,[rental.trader_id,rental.rental_id,rental.amount_due_usd,rental.currency,paid?'PAID':'PENDING',rental.period_start,rental.period_end,rental.payment_reference||String(rental.rental_id)]);return send(res,201,{rental:rentalProjection(rental)});}
 if(req.method==='PATCH'&&route==='/api/execution/rental/payment'){const body=await jsonBody(req);if(!body.rental_id)return send(res,400,{error:'rental_id_required'});if(!['PAID','FAILED','REFUNDED','VOID','PENDING'].includes(body.payment_status))return send(res,400,{error:'invalid_payment_status'});const paid=body.payment_status==='PAID';const q=await pool.query(`UPDATE execution_engine_rentals SET payment_status=$1,payment_reference=COALESCE($2,payment_reference),paid_at=CASE WHEN $3 THEN COALESCE(paid_at,now()) ELSE paid_at END,status=CASE WHEN $3 AND period_end>now() THEN 'ACTIVE' WHEN $4='PAID' AND period_end<=now() THEN 'EXPIRED' ELSE status END,updated_at=now() WHERE rental_id=$5 RETURNING *`,[body.payment_status,body.payment_reference||null,paid,body.payment_status,body.rental_id]);if(!q.rows[0])return send(res,404,{error:'rental_not_found'});const rental=q.rows[0];await pool.query(`UPDATE billing_ledger SET status=$1,reference_id=COALESCE($2,reference_id) WHERE rental_id=$3 AND fee_type='EXECUTION_ENGINE_RENTAL' AND status<>'VOID'`,[paid?'PAID':body.payment_status,body.payment_reference||null,rental.rental_id]);return send(res,200,{rental:rentalProjection(rental)});}
 if(req.method==='GET'&&route==='/api/execution/rentals'){const traderId=requestUrl(req).searchParams.get('trader_id'),q=await pool.query(`SELECT rental_id,trader_id,status,monthly_rate_bps,amount_due_usd,currency,period_start,period_end,paid_at,payment_status,payment_reference,created_at,updated_at FROM execution_engine_rentals ${traderId?'WHERE trader_id=$1':''} ORDER BY created_at DESC LIMIT 200`,traderId?[traderId]:[]);return send(res,200,{items:q.rows.map(rentalProjection)});}
 if(req.method==='POST'&&route==='/api/executions'){const body=await jsonBody(req),mode=body.mode||'SHADOW';if(mode==='LIVE')return send(res,423,{error:'live_execution_blocked'});const access=await checkExecutionEngineRental(pool,body.trader_id);if(!access.allowed)return send(res,403,{error:'execution_engine_rental_required',reason:access.reason,rental:access.rental??null});return send(res,201,await repos.executionRequests.create({...body,mode}));}
 if(req.method==='GET'&&route==='/api/executions')return send(res,200,{items:(await pool.query('SELECT * FROM execution_requests ORDER BY created_at DESC LIMIT 200')).rows});
 if(req.method==='GET'&&route==='/api/admin/risk')return send(res,200,{items:await repos.admin.recentRiskDecisions()});
 if(req.method==='GET'&&route==='/api/admin/audit')return send(res,200,{items:await repos.admin.recentAuditEvents()});
 if(req.method==='GET'&&route==='/api/admin/rentals')return send(res,200,{items:(await pool.query(`SELECT rental_id,trader_id,status,monthly_rate_bps,amount_due_usd,currency,period_start,period_end,paid_at,payment_status,payment_reference,created_at,updated_at FROM execution_engine_rentals ORDER BY created_at DESC LIMIT 200`)).rows.map(rentalProjection)});
 if(req.method==='GET'&&route==='/api/admin/billing/ledger')return send(res,200,{items:(await pool.query(`SELECT * FROM billing_ledger ORDER BY created_at DESC LIMIT 200`)).rows});
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='copy-policies'&&p[3]){const updated=await repos.admin.updateCopyPolicy(p[3],await jsonBody(req));return updated?send(res,200,updated):send(res,404,{error:'copy_policy_not_found'});}
 if(req.method==='PATCH'&&route==='/api/admin/fees'){const config=await repos.marketplace.updateFeeConfig(await jsonBody(req));await repos.auditEvents.append({event_type:'PLATFORM_FEE_CONFIG_UPDATED',actor:'admin',entity_type:'platform_fee_config',entity_id:String(config.config_id),payload:{performance_fee_bps:config.performance_fee_bps,execution_fee_bps:config.execution_fee_bps,execution_rental_fee_bps:config.execution_rental_fee_bps,enabled:config.enabled}});return send(res,200,{config});}
 if(req.method==='GET'&&(route==='/'||route==='/dashboard'))return send(res,200,fs.readFileSync(path.resolve(process.cwd(),'web/dashboard.html'),'utf8'),'text/html; charset=utf-8');
 if(req.method==='GET'&&route==='/admin')return send(res,200,fs.readFileSync(path.resolve(process.cwd(),'web/admin.html'),'utf8'),'text/html; charset=utf-8');
 return send(res,404,{error:'not_found',path:route,method:req.method});
 }catch(e){console.error(e);return send(res,e.message?.startsWith('invalid_')||e.message?.endsWith('_required')?400:500,{error:e.message});}});
async function start(){if(pool)await runMigrations(pool,path.resolve(process.cwd(),'migrations'));server.listen(PORT,'0.0.0.0',()=>console.log(`Aether API listening on ${PORT}`));}
start().catch(e=>{console.error('startup_failed',e);process.exit(1);});
