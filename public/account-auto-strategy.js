(() => {
  const d = document;

  const corePositioning = 'Social Trading + On-chain Intelligence + Verified Performance + Automated Risk + Non-Custodial Execution.';
  d.title = 'My AETHER — Trade with proof.';
  const description = d.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', `Trade with proof. ${corePositioning} AETHER member workspace for SHADOW market discovery, verified traders, and non-custodial controls.`);
  const positioning = d.querySelector('.positioning');
  if (positioning) positioning.textContent = corePositioning;
  const lead = d.querySelector('.lead');
  if (lead) lead.textContent = 'Trade with proof. Discover Solana markets, evaluate verified traders, manage SHADOW copy mandates, apply to become a trader, review your wallet session, or check system status without granting execution authority.';

  const copySection = d.getElementById('copy-mandates');
  if (!copySection || d.getElementById('auto-strategy')) return;

  const style = d.createElement('style');
  style.textContent = `
    .autosim{border-color:rgba(141,230,207,.32)!important;background:linear-gradient(180deg,rgba(13,39,48,.92),rgba(9,21,35,.94))!important}
    .simcontrols{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}
    .simcontrols label{font-size:11px;color:#9fb0c8}.simcontrols input,.simcontrols select{width:100%;margin-top:6px;padding:11px 12px;border:1px solid #263c5b;border-radius:10px;background:#091523;color:#f4f7ff;font:inherit}
    .simactions{display:flex;gap:9px;flex-wrap:wrap}.simactions .btn{width:auto;min-width:150px}
    .simresult{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:13px}.simmetric{padding:11px;border:1px solid rgba(255,255,255,.07);border-radius:11px;background:#071421}.simmetric span{display:block;color:#8194b0;font-size:9px;text-transform:uppercase;letter-spacing:.1em}.simmetric b{display:block;margin-top:6px;font-size:16px;overflow-wrap:anywhere}
    .simreason{margin-top:10px;padding:11px 12px;border:1px solid rgba(141,230,207,.18);border-radius:11px;background:rgba(141,230,207,.035);color:#b8cbe0;font-size:12px;line-height:1.55}
    .simhistory{display:grid;gap:6px;margin-top:10px}.simhistory div{padding:9px 10px;border:1px solid rgba(255,255,255,.06);border-radius:9px;background:#091523;color:#91a6bf;font-size:11px}.simhistory b{color:#edf4ff}
    .trainingtag{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid rgba(247,211,122,.22);border-radius:999px;color:#ead99e;background:rgba(247,211,122,.05);font-size:9px;font-weight:850;letter-spacing:.08em}
    @media(min-width:901px){.quickgrid{grid-template-columns:repeat(4,1fr)!important}}
    @media(max-width:760px){.simcontrols{grid-template-columns:1fr 1fr}.simresult{grid-template-columns:1fr 1fr}.simactions .btn{width:100%}}
    @media(max-width:430px){.simcontrols{grid-template-columns:1fr}}
  `;
  d.head.appendChild(style);

  function setMenuLabel(selector, label) {
    const link = d.querySelector(selector);
    if (!link) return;
    const textNode = [...link.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (textNode) textNode.textContent = label;
    else if (!link.querySelector('span')) link.textContent = label;
  }

  setMenuLabel('.navlinks a[href="/marketplace"]', 'Trader Marketplace');
  setMenuLabel('.navlinks a[href="#become-trader"]', 'Become Trader');
  setMenuLabel('.bottomnav a[href="/marketplace"]', 'Marketplace');
  setMenuLabel('.bottomnav a[href="#become-trader"]', 'Become');
  const traderCenterItem = d.querySelector('.navmap a[href="#become-trader"] b');
  if (traderCenterItem) traderCenterItem.textContent = 'Become a Trader';

  const navLinks = d.querySelector('.navlinks');
  if (navLinks && !navLinks.querySelector('[href="#auto-strategy"]')) {
    const a = d.createElement('a');
    a.href = '#auto-strategy';
    a.textContent = 'Auto Strategy';
    const copyLink = [...navLinks.querySelectorAll('a')].find(x => x.getAttribute('href') === '#copy-mandates');
    navLinks.insertBefore(a, copyLink || null);
  }

  const navMap = d.querySelector('.navmap');
  if (navMap && !navMap.querySelector('[href="#auto-strategy"]')) {
    const a = d.createElement('a');
    a.className = 'navitem';
    a.href = '#auto-strategy';
    a.innerHTML = '<span class="navicon">⚙</span><span><b>Auto Strategy Simulator</b><small>Learn the AETHER engine with SHADOW decisions before copying a trader.</small></span>';
    const copyItem = navMap.querySelector('[href="#copy-mandates"]');
    navMap.insertBefore(a, copyItem || null);
  }

  const quickGrid = d.querySelector('.quickgrid');
  if (quickGrid && !quickGrid.querySelector('[href="#auto-strategy"]')) {
    const a = d.createElement('a');
    a.className = 'quick primary';
    a.href = '#auto-strategy';
    a.innerHTML = '<span class="qicon">⚙</span><span class="qtitle">Try AETHER Auto Strategy</span><span class="qcopy">Run the same SHADOW signal and auto-trade decision logic with clearly labeled training scenarios.</span>';
    quickGrid.prepend(a);
  }

  const section = d.createElement('section');
  section.id = 'auto-strategy';
  section.className = 'card full autosim';
  section.innerHTML = `
    <div class="eyebrow">Engine Simulator</div>
    <h2>AETHER Auto Strategy · SHADOW</h2>
    <p class="sectionintro">Learn how the engine decides BUY, HOLD, SELL or REJECT before you copy a trader or consider future LIVE usage. This simulator exercises the same signal-quality and auto-trade decision code with clearly labeled training fixtures.</p>
    <div class="status"><strong>Training only.</strong> No signer request · no transaction · no network submission · no funds moved · LIVE authorized=false.</div>
    <div style="margin-top:10px"><span class="trainingtag">TRAINING FIXTURE · SAME ENGINE LOGIC</span></div>
    <div class="simcontrols">
      <label>Simulation capital (USD)<input id="simCapital" type="number" min="10" max="100000" step="10" value="100"></label>
      <label>Max trade (USD)<input id="simMaxTrade" type="number" min="1" max="100000" step="1" value="10"></label>
      <label>Max allocation (%)<input id="simAllocation" type="number" min="1" max="100" step="1" value="10"></label>
      <label>Training scenario<select id="simScenario"><option value="qualified_entry">Qualified entry · BUY</option><option value="healthy_position">Healthy position · HOLD</option><option value="trailing_stop_exit">Trailing stop · SELL</option><option value="stop_loss_exit">Stop loss · SELL</option><option value="risk_reject">Unsafe market · REJECT</option></select></label>
    </div>
    <div class="simactions"><button id="simRun" class="btn" type="button">Run Engine Step</button><button id="simAuto" class="btn secondary" type="button">Start Auto Demo</button></div>
    <div id="simState" class="status warn" style="margin-top:10px" role="status" aria-live="polite">Ready. Choose a scenario or start the automatic training loop.</div>
    <div class="simresult">
      <div class="simmetric"><span>Engine action</span><b id="simAction">—</b></div>
      <div class="simmetric"><span>Signal score</span><b id="simScore">—</b></div>
      <div class="simmetric"><span>Simulated notional</span><b id="simNotional">—</b></div>
      <div class="simmetric"><span>Position PnL</span><b id="simPnl">—</b></div>
    </div>
    <div id="simReason" class="simreason">The engine reason codes will appear here so the user can see why an action was accepted or blocked.</div>
    <div class="label" style="margin-top:14px">Recent training decisions</div><div id="simHistory" class="simhistory"><div>No simulation steps yet.</div></div>
  `;
  copySection.parentNode.insertBefore(section, copySection);

  const $ = id => d.getElementById(id);
  const scenarios = ['qualified_entry', 'healthy_position', 'trailing_stop_exit', 'risk_reject', 'stop_loss_exit'];
  let autoTimer = null;
  let autoIndex = 0;
  let running = false;
  const history = [];

  const money = value => {
    const n = Number(value);
    return Number.isFinite(n) ? '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  };
  const pctBps = value => {
    const n = Number(value);
    return Number.isFinite(n) ? (n / 100).toFixed(2).replace(/\.00$/, '') + '%' : '—';
  };

  function renderHistory() {
    $('simHistory').innerHTML = history.length ? history.map(row => `<div><b>${row.action}</b> · ${row.scenario} · score ${row.score} · ${row.time}</div>`).join('') : '<div>No simulation steps yet.</div>';
  }

  async function runStep(scenario = $('simScenario').value) {
    if (running) return;
    running = true;
    $('simRun').disabled = true;
    $('simState').className = 'status';
    $('simState').textContent = 'Running the SHADOW decision engine…';
    try {
      const capital = Number($('simCapital').value);
      const maxTrade = Number($('simMaxTrade').value);
      const allocation = Number($('simAllocation').value);
      const response = await fetch('/api/account/auto-strategy/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ scenario, capital_usd: capital, max_trade_usd: maxTrade, max_allocation_bps: Math.round(allocation * 100) }),
      });
      const data = await response.json().catch(() => ({ error: 'invalid_response' }));
      if (!response.ok) throw Object.assign(new Error(data.error || `HTTP_${response.status}`), { status: response.status });
      const decision = data.decision || {};
      const assessment = data.assessment || {};
      const position = data.position || {};
      $('simAction').textContent = decision.action || '—';
      $('simScore').textContent = Number.isFinite(Number(assessment.quality_score)) ? Number(assessment.quality_score).toFixed(1) + ' / 100' : '—';
      $('simNotional').textContent = money(decision.requested_amount_usd);
      $('simPnl').textContent = Number.isFinite(Number(position.unrealized_pnl_bps)) ? pctBps(position.unrealized_pnl_bps) : 'No position';
      const reasons = Array.isArray(decision.reason_codes) ? decision.reason_codes : [];
      $('simReason').textContent = `${data.scenario_label || scenario}: ${reasons.length ? reasons.join(' · ') : 'No reason code returned.'}`;
      $('simState').className = 'status';
      $('simState').textContent = 'SHADOW decision complete · execution_dispatched=false · funds_moved=false · LIVE authorized=false.';
      history.unshift({ action: decision.action || '—', scenario: data.scenario_label || scenario, score: Number.isFinite(Number(assessment.quality_score)) ? Number(assessment.quality_score).toFixed(1) : '—', time: new Date().toLocaleTimeString() });
      if (history.length > 8) history.length = 8;
      renderHistory();
    } catch (error) {
      $('simState').className = 'status warn';
      $('simState').textContent = error.status === 401 ? 'Secure wallet session required. Reconnect from onboarding.' : 'Simulator temporarily unavailable. No execution authority changed.';
    } finally {
      running = false;
      $('simRun').disabled = false;
    }
  }

  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    $('simAuto').textContent = 'Start Auto Demo';
    $('simAuto').setAttribute('aria-pressed', 'false');
  }

  async function autoStep() {
    const scenario = scenarios[autoIndex % scenarios.length];
    autoIndex += 1;
    $('simScenario').value = scenario;
    await runStep(scenario);
  }

  $('simRun').addEventListener('click', () => runStep());
  $('simAuto').addEventListener('click', async () => {
    if (autoTimer) { stopAuto(); return; }
    $('simAuto').textContent = 'Stop Auto Demo';
    $('simAuto').setAttribute('aria-pressed', 'true');
    await autoStep();
    autoTimer = setInterval(() => { if (!d.hidden) autoStep(); }, 7000);
  });
  d.addEventListener('visibilitychange', () => { if (d.hidden && autoTimer) stopAuto(); });

  const requestedTrader = new URL(location.href).searchParams.get('trader_id');
  const copyTrader = d.getElementById('copyTrader');
  if (copyTrader) {
    const syncTraderChoice = () => {
      const options = [...copyTrader.options];
      if (options.length <= 1) {
        if (copyTrader.options[0]) copyTrader.options[0].textContent = 'No verified traders published yet';
        return;
      }
      copyTrader.options[0].textContent = 'Select trader';
      if (requestedTrader && options.some(option => option.value === requestedTrader)) {
        copyTrader.value = requestedTrader;
        copySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    new MutationObserver(syncTraderChoice).observe(copyTrader, { childList: true });
    syncTraderChoice();
  }
})();