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

const PORT = Number(process.env.PORT || 8080);
const executionMode = process.env.EXECUTION_MODE || 'SHADOW';
const liveEnabled = process.env.LIVE_ENABLED === 'true' && executionMode === 'LIVE';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const repos = pool ? { tradeEvents:createTradeEventRepository(pool), executionRequests:createExecutionRequestRepository(pool), ...createCoreRepositories(pool), admin:createAdminRepository(pool), marketplace:createMarketplaceRepository(pool) } : null;
const send=(res,status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(type.startsWith('text/')?body:JSON.stringify(body));};
const auth=req=>!process.env.API_TOKEN||req.headers.authorization===`Bearer ${process.env.API_TOKEN}`;
const jsonBody=async req=>{let raw='';for await(const chunk of req)raw+=chunk;return raw?JSON.parse(raw):{};};
const parts=url=>new URL(url,'http://localhost').pathname.split('/').filter(Boolean);
const server=http.createServer(async(req,res)=>{try{
 if(req.method==='GET'&&req.url==='/api/health')return send(res,200,{status:'ok',service:'aether-api',execution_mode:executionMode,live_enabled:liveEnabled});
 if(req.method==='GET'&&req.url==='/api/readiness'){if(!pool)return send(res,503,{status:'not_ready',database:'unconfigured'});try{await pool.query('SELECT 1');return send(res,200,{status:'ready',database:'ok'});}catch{return send(res,503,{status:'not_ready',database:'unavailable'});}}
 if(req.method==='GET'&&req.url==='/api/execution/status')return send(res,200,{mode:executionMode,live_enabled:liveEnabled,fail_closed:!liveEnabled,signer_exposed_to_api:false});
 if(req.method==='POST'&&req.url==='/api/shadow/simulate'){if(!auth(req))return send(res,401,{error:'unauthorized'});if(!repos)return send(res,503,{error:'database_unconfigured'});if(liveEnabled||executionMode!=='SHADOW')return send(res,409,{error:'shadow_simulation_locked',reason:'execution_mode_not_shadow'});const result=await runShadowSimulation({repos,pool,body:await jsonBody(req)});return send(res,result.status,result.body);}
 if(!auth(req)&&req.url.startsWith('/api/'))return send(res,401,{error:'unauthorized'});
 if(!repos&&req.url.startsWith('/api/'))return send(res,503,{error:'database_unconfigured'});
 const p=parts(req.url);
 if(req.method==='GET'&&p[1]==='trades')return send(res,200,{items:await repos.tradeEvents.recent(new URL(req.url,'http://localhost').searchParams.get('limit'))});
 if(req.method==='GET'&&p[1]==='traders'){if(p[2]){const t=await repos.marketplace.getTrader(p[2]);return t?send(res,200,t):send(res,404,{error:'trader_not_found'});}return send(res,200,{items:await repos.marketplace.listTraders(new URL(req.url,'http://localhost').searchParams.get('limit'))});}
 if(req.method==='GET'&&req.url==='/api/marketplace/fees')return send(res,200,{config:await repos.marketplace.getFeeConfig()});
 if(req.method==='GET'&&req.url==='/api/execution/rental/status'){const traderId=new URL(req.url,'http://localhost').searchParams.get('trader_id');if(!traderId)return send(res,400,{error:'trader_id_required'});const q=await pool.query(`SELECT rental_id,status,monthly_rate_bps,amount_due_usd,currency,period_start,period_end,paid_at FROM execution_engine_rentals WHERE trader_id=$1 ORDER BY created_at DESC LIMIT 1`,[traderId]);const rental=q.rows[0]??null;const active=Boolean(rental&&rental.status==='ACTIVE'&&new Date(rental.period_end)>new Date());return send(res,200,{active,rental});}
 if(req.method==='POST'&&req.url==='/api/execution/rental'){const body=await jsonBody(req);if(!body.trader_id)return send(res,400,{error:'trader_id_required'});const start=new Date(body.period_start||Date.now());const end=body.period_end?new Date(body.period_end):new Date(start.getTime()+30*24*60*60*1000);const rate=Number(body.monthly_rate_bps??300);const amount=Number(body.amount_due_usd??0);if(!Number.isInteger(rate)||rate<0||rate>10000)return send(res,400,{error:'invalid_rental_rate'});const q=await pool.query(`INSERT INTO execution_engine_rentals(trader_id,status,monthly_rate_bps,amount_due_usd,period_start,period_end,paid_at) VALUES($1,'ACTIVE',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,[body.trader_id,rate,amount,start,end,body.paid_at?new Date(body.paid_at):null]);return q.rows[0]?send(res,201,{rental:q.rows[0]}):send(res,409,{error:'active_rental_exists'});}
 if(req.method==='GET'&&req.url==='/api/executions')return send(res,200,{items:(await pool.query('SELECT * FROM execution_requests ORDER BY created_at DESC LIMIT 200')).rows});
 if(req.method==='GET'&&req.url==='/api/admin/risk')return send(res,200,{items:await repos.admin.recentRiskDecisions()});
 if(req.method==='GET'&&req.url==='/api/admin/audit')return send(res,200,{items:await repos.admin.recentAuditEvents()});
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='copy-policies'&&p[3]){const updated=await repos.admin.updateCopyPolicy(p[3],await jsonBody(req));return updated?send(res,200,updated):send(res,404,{error:'copy_policy_not_found'});}
 if(req.method==='PATCH'&&req.url==='/api/admin/fees'){const config=await repos.marketplace.updateFeeConfig(await jsonBody(req));await repos.auditEvents.append({event_type:'PLATFORM_FEE_CONFIG_UPDATED',actor:'admin',entity_type:'platform_fee_config',entity_id:String(config.config_id),payload:{performance_fee_bps:config.performance_fee_bps,execution_fee_bps:config.execution_fee_bps,execution_rental_fee_bps:config.execution_rental_fee_bps,enabled:config.enabled}});return send(res,200,{config});}
 if(req.method==='GET'&&(req.url==='/'||req.url==='/dashboard'))return send(res,200,fs.readFileSync(path.resolve(process.cwd(),'web/dashboard.html'),'utf8'),'text/html; charset=utf-8');
 if(req.method==='GET'&&req.url==='/admin')return send(res,200,fs.readFileSync(path.resolve(process.cwd(),'web/admin.html'),'utf8'),'text/html; charset=utf-8');
 return send(res,404,{error:'not_found'});
}catch(e){console.error(e);return send(res,e.message?.startsWith('invalid_')?400:500,{error:e.message?.startsWith('invalid_')?'invalid_request':'internal_error'});}});
async function start(){if(pool)await runMigrations(pool,path.resolve(process.cwd(),'migrations'));server.listen(PORT,'0.0.0.0',()=>console.log(`Aether API listening on ${PORT}`));}
start().catch(e=>{console.error('startup_failed',e);process.exit(1);});
