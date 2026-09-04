import { evaluateAdminLiveControl } from '../services/api/src/admin-live-control.mjs';

function json(res,status,body){res.status(status);res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.send(JSON.stringify(body));}
function adminAuthenticated(req){const token=String(process.env.ADMIN_API_TOKEN||'');return Boolean(token)&&String(req.headers.authorization||'')===`Bearer ${token}`;}
function bodyOf(req){if(!req.body)return {};if(typeof req.body==='object')return req.body;try{return JSON.parse(String(req.body));}catch{return {};}}

export default async function handler(req,res){
  try{
    if(req.method==='GET'){
      return json(res,200,evaluateAdminLiveControl({action:'STATUS',adminAuthenticated:false,env:process.env}));
    }
    if(req.method!=='POST')return json(res,405,{error:'method_not_allowed',fail_closed:true});
    if(!adminAuthenticated(req))return json(res,401,{error:'admin_auth_required',fail_closed:true});
    const body=bodyOf(req);
    const result=evaluateAdminLiveControl({action:body.action||'STATUS',adminAuthenticated:true,env:process.env});
    const status=result.accepted?200:409;
    return json(res,status,result);
  }catch(error){
    const code=String(error?.message||'live_control_failed');
    const status=code==='admin_auth_required'?401:code==='invalid_live_control_action'?400:500;
    return json(res,status,{error:code,fail_closed:true,live_execution_authorized:false});
  }
}
