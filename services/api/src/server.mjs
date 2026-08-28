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
const publicHtml=()=>fs.readFileSync(path.resolve(process.cwd(),'web/dashboard.html'),'utf8');
const adminHtml=()=>fs.readFileSync(path.resolve(process.cwd(),'web/admin.html'),'utf8');
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
 if(req.method==='GET'&&req.url==='/api/executions')return send(res,200,{items:(await pool.query('SELECT * FROM execution_requests ORDER BY created_at DESC LIMIT 200')).rows});
 if(req.method==='GET'&&req.url==='/api/admin/risk')return send(res,200,{items:await repos.admin.recentRiskDecisions()});
 if(req.method==='GET'&&req.url==='/api/admin/audit')return send(res,200,{items:await repos.admin.recentAuditEvents()});
 if(req.method==='PATCH'&&p[1]==='admin'&&p[2]==='copy-policies'&&p[3]){const updated=await repos.admin.updateCopyPolicy(p[3],await jsonBody(req));return updated?send(res,200,updated):send(res,404,{error:'copy_policy_not_found'});}
 if(req.method==='PATCH'&&req.url==='/api/admin/fees'){const config=await repos.marketplace.updateFeeConfig(await jsonBody(req));await repos.auditEvents.append({event_type:'PLATFORM_FEE_CONFIG_UPDATED',actor:'admin',entity_type:'platform_fee_config',entity_id:String(config.config_id),payload:{performance_fee_bps:config.performance_fee_bps,execution_fee_bps:config.execution_fee_bps,execution_rental_fee_bps:config.execution_rental_fee_bps,enabled:config.enabled}});return send(res,200,{config});}
 if(req.method==='GET'&&(req.url==='/'||req.url==='/dashboard'))return send(res,200,publicHtml(),'text/html; charset=utf-8');
 if(req.method==='GET'&&req.url==='/admin')return send(res,200,adminHtml(),'text/html; charset=utf-8');
 return send(res,404,{error:'not_found'});
}catch(e){console.error(e);return send(res,e.message?.startsWith('invalid_')?400:500,{error:e.message?.startsWith('invalid_')?'invalid_fee_config':'internal_error'});}});
async function start(){if(pool){const migrationsDir=path.resolve(process.cwd(),'migrations');await runMigrations(pool,migrationsDir);}server.listen(PORT,'0.0.0.0',()=>console.log(`Aether API listening on ${PORT}`));}
start().catch(e=>{console.error('startup_failed',e);process.exit(1);});
