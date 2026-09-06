(()=>{
  const ACCOUNT_ID='account';
  const API_BASE='/api/account/delegated-authority';
  const AUTOTRADE_BASE='/api/account/autotrade';
  const enc=new TextEncoder();

  const byId=id=>document.getElementById(id);
  const el=(tag,attrs={},text='')=>{const node=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(k==='class')node.className=v;else if(k==='type')node.type=v;else node.setAttribute(k,v)}if(text)node.textContent=text;return node};

  function atomicUsdcFromInput(value,{allowZero=false}={}){
    const raw=String(value??'').trim();
    if(!/^\d+(?:\.\d{1,6})?$/.test(raw))throw new Error('Enter a valid USDC amount with up to 6 decimals.');
    const [whole,frac='']=raw.split('.');
    const atomic=BigInt(whole)*1000000n+BigInt((frac+'000000').slice(0,6));
    if(allowZero?atomic<0n:atomic<=0n)throw new Error(allowZero?'Amount must be zero or greater.':'Amount must be greater than zero.');
    return atomic.toString();
  }

  function formatAtomic(value){
    try{const n=BigInt(String(value));const whole=n/1000000n;const frac=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return `${whole}${frac?'.'+frac:''} USDC`}catch{return'—'}
  }

  async function request(path,options={}){
    const r=await fetch(path,{cache:'no-store',headers:{accept:'application/json',...(options.headers||{})},...options});
    const d=await r.json().catch(()=>({error:'invalid_response'}));
    if(r.status===401){location.replace('/onboarding');throw new Error('session_required')}
    if(!r.ok)throw new Error(d.error||'request_failed');
    return d;
  }

  function provider(){
    const candidates=[window.phantom?.solana,window.solflare,window.solana,window.tokenpocket?.solana];
    return candidates.find(p=>p&&typeof p.signMessage==='function')||null;
  }

  function signatureBase64(value){
    const bytes=value?.signature instanceof Uint8Array?value.signature:value instanceof Uint8Array?value:null;
    if(!bytes)throw new Error('Wallet did not return a supported message signature.');
    let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary);
  }

  function mount(){
    const section=byId(ACCOUNT_ID);if(!section||byId('authorityCard'))return;
    const card=el('div',{id:'authorityCard',class:'card'});
    card.append(el('div',{class:'eyebrow'},'Delegated Auto Trade Authority'));
    card.append(el('h2',{id:'authorityStatus'},'Loading…'));
    card.append(el('p',{id:'authoritySummary',class:'lead'},'Bounded consent for TWO_LEG_ARBITRAGE · ORCA ↔ Raydium. This does not enable LIVE execution by itself.'));

    const rows=el('div',{class:'rows'});
    const notionalRow=el('div',{class:'row'});notionalRow.append(el('b',{},'Max notional per cycle'));const notional=el('input',{id:'authorityMaxNotional',class:'field',type:'text',inputmode:'decimal',placeholder:'USDC, e.g. 20'});notionalRow.append(notional);rows.append(notionalRow);
    const lossRow=el('div',{class:'row'});lossRow.append(el('b',{},'Max realized daily loss'));const loss=el('input',{id:'authorityDailyLoss',class:'field',type:'text',inputmode:'decimal',placeholder:'USDC, zero = zero tolerance'});lossRow.append(loss);rows.append(lossRow);
    const ttlRow=el('div',{class:'row'});ttlRow.append(el('b',{},'Authority duration'));const ttl=el('input',{id:'authorityTtl',class:'field',type:'number',min:'1',max:'30',step:'1',value:'30'});ttlRow.append(ttl);rows.append(ttlRow);
    card.append(rows);

    const actions=el('div',{class:'actions'});
    actions.append(el('button',{id:'authorityCreate',class:'btn',type:'button'},'Create & Sign Consent'));
    actions.append(el('button',{id:'authorityRevoke',class:'btn secondary',type:'button'},'Revoke Authority'));
    card.append(actions);
    card.append(el('p',{id:'authorityMessage',class:'lead'},'The wallet signs the exact consent message only. AETHER never asks for a seed phrase or private key.'));
    section.append(card);

    byId('authorityCreate').addEventListener('click',createAndSign);
    byId('authorityRevoke').addEventListener('click',revoke);
    load();
    mountAutoTradeControls();
  }

  function render(authority){
    const status=byId('authorityStatus'),summary=byId('authoritySummary'),revokeBtn=byId('authorityRevoke'),createBtn=byId('authorityCreate');
    if(!status)return;
    if(!authority){status.textContent='NONE';summary.textContent='No delegated authority exists. LIVE remains OFF.';revokeBtn.disabled=true;createBtn.disabled=false;return}
    status.textContent=authority.status||'UNKNOWN';
    summary.textContent=`${authority.allowed_strategy||'TWO_LEG_ARBITRAGE'} · ${authority.allowed_dex_pair||'ORCA_RAYDIUM'} · max ${formatAtomic(authority.max_notional_usdc_atomic)} · daily loss ${formatAtomic(authority.max_daily_loss_usdc_atomic)} · expires ${authority.expires_at||'—'} · LIVE authorized=false`;
    revokeBtn.disabled=!['ACTIVE','PENDING_CONSENT'].includes(authority.status);
    createBtn.disabled=authority.status==='ACTIVE';
    revokeBtn.dataset.authorityId=authority.authority_id||'';
  }

  async function load(){
    try{const d=await request(API_BASE);render(d.authority);byId('authorityMessage').textContent='Authority status loaded from the authenticated wallet session.'}
    catch(e){byId('authorityStatus').textContent='UNAVAILABLE';byId('authorityMessage').textContent=`Authority unavailable · ${e.message}`}
  }

  async function createAndSign(){
    const button=byId('authorityCreate');button.disabled=true;
    try{
      const maxNotional=atomicUsdcFromInput(byId('authorityMaxNotional').value);
      const maxDailyLoss=atomicUsdcFromInput(byId('authorityDailyLoss').value,{allowZero:true});
      const ttlDays=Number(byId('authorityTtl').value);
      if(!Number.isInteger(ttlDays)||ttlDays<1||ttlDays>30)throw new Error('Authority duration must be 1–30 days.');
      const wallet=provider();if(!wallet)throw new Error('A Solana wallet with signMessage is required.');
      if(typeof wallet.connect==='function'&&!wallet.publicKey)await wallet.connect();
      const challenge=await request(`${API_BASE}/challenge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({max_notional_usdc_atomic:maxNotional,max_daily_loss_usdc_atomic:maxDailyLoss,ttl_days:ttlDays})});
      const c=challenge.challenge;
      byId('authorityMessage').textContent='Review the exact bounded consent in your wallet and sign it to continue.';
      const signed=await wallet.signMessage(enc.encode(c.message),'utf8');
      const result=await request(`${API_BASE}/verify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authority_id:c.authority_id,signature:signatureBase64(signed),signature_encoding:'base64'})});
      render(result.authority);byId('authorityMessage').textContent='Delegated authority ACTIVE. LIVE execution is still OFF until all separate production gates pass.';
    }catch(e){byId('authorityMessage').textContent=`Authority not activated · ${e.message}`;await load().catch(()=>{})}
    finally{if(byId('authorityStatus')?.textContent!=='ACTIVE')button.disabled=false}
  }

  async function revoke(){
    const button=byId('authorityRevoke'),authorityId=button.dataset.authorityId;if(!authorityId)return;button.disabled=true;
    try{const result=await request(`${API_BASE}/revoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authority_id:authorityId})});render(result.authority);byId('authorityMessage').textContent='Delegated authority revoked. Logout is separate from revocation.'}
    catch(e){byId('authorityMessage').textContent=`Revoke failed · ${e.message}`;button.disabled=false}
  }

  function autoButtons(){
    const section=byId('autotrade');
    return {start:byId('start'),stop:section?.querySelector('.actions .btn.secondary')||null};
  }

  function renderAutoTradeState(snapshot){
    if(!snapshot)return;
    const {start,stop}=autoButtons();
    const state=String(snapshot.state||'STOPPED');
    const engine=byId('engineState');if(engine)engine.textContent=state;
    const status=byId('autoState');
    if(status){status.className='status';status.textContent=`${state}${snapshot.stop_requested?' · stop requested':''} · SHADOW control state only · LIVE OFF`;}
    if(start)start.disabled=!['STOPPED','PAUSED'].includes(state);
    if(stop)stop.disabled=state==='STOPPED';
  }

  async function loadAutoTradeState(){
    try{const d=await request(`${AUTOTRADE_BASE}/state`);renderAutoTradeState(d.state)}
    catch(e){const status=byId('autoState');if(status){status.className='status warn';status.textContent=`Auto Trade control unavailable · ${e.message}`};const {start,stop}=autoButtons();if(start)start.disabled=true;if(stop)stop.disabled=true}
  }

  async function commandAutoTrade(action){
    const {start,stop}=autoButtons();if(start)start.disabled=true;if(stop)stop.disabled=true;
    try{const d=await request(`${AUTOTRADE_BASE}/${action}`,{method:'POST'});renderAutoTradeState(d.state)}
    catch(e){const status=byId('autoState');if(status){status.className='status warn';status.textContent=`Auto Trade ${action} rejected · ${e.message}`};await loadAutoTradeState().catch(()=>{})}
  }

  function mountAutoTradeControls(){
    const {start,stop}=autoButtons();if(!start||!stop||start.dataset.stateBound==='true')return;
    start.dataset.stateBound='true';stop.dataset.stateBound='true';
    start.addEventListener('click',()=>commandAutoTrade('start'));
    stop.addEventListener('click',()=>commandAutoTrade('stop'));
    loadAutoTradeState();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
