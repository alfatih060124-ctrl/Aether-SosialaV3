(() => {
  const d = document;
  if (!d.querySelector('script[data-aether-wallet-portfolio]')) {
    const walletScript = d.createElement('script');
    walletScript.src = '/account-wallet-portfolio.js';
    walletScript.dataset.aetherWalletPortfolio = 'true';
    d.head.appendChild(walletScript);
  }
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
    .copyactivity{border-color:rgba(141,230,207,.24)!important}.activitysummary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.activitymetric{padding:11px;border:1px solid rgba(255,255,255,.07);border-radius:11px;background:#091523}.activitymetric span{display:block;color:#8194b0;font-size:9px;text-transform:uppercase;letter-spacing:.1em}.activitymetric b{display:block;margin-top:6px;font-size:17px}.activitylist{display:grid;gap:8px;margin-top:12px}.activityrow{padding:12px;border:1px solid rgba(255,255,255,.07);border-radius:11px;background:#091523}.activityrow strong{display:block}.activityrow .meta{margin-top:5px;color:#9fb0c8;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.activitybadge{display:inline-flex;margin-top:7px;padding:4px 7px;border:1px solid rgba(141,230,207,.22);border-radius:999px;color:#bce3d8;font-size:9px;font-weight:850;letter-spacing:.08em}.activitybadge.terminal{border-color:rgba(255,255,255,.12);color:#9fb0c8}.activitybadge.failed{border-color:rgba(247,211,122,.24);color:#ead99e}.activitynote{margin-top:10px;padding:11px 12px;border:1px solid rgba(247,211,122,.22);border-radius:11px;background:rgba(247,211,122,.04);color:#d9c98f;font-size:11px;line-height:1.55}
    .copyconsent{margin-top:12px;padding:12px 13px;border:1px solid rgba(141,230,207,.22);border-radius:11px;background:rgba(141,230,207,.04);color:#c5d7ea;font-size:12px;line-height:1.55}.copyconsent label{display:flex;gap:9px;align-items:flex-start;color:#edf4ff;font-weight:700}.copyconsent input{width:auto!important;margin:3px 0 0!important;accent-color:#8de6cf}.copyconsent .consentmeta{margin-top:7px;color:#9fb0c8;font-size:11px}
    @media(min-width:901px){.quickgrid{grid-template-columns:repeat(4,1fr)!important}}
    @media(max-width:760px){.simcontrols{grid-template-columns:1fr 1fr}.simresult,.activitysummary{grid-template-columns:1fr 1fr}.simactions .btn{width:100%}}
    @media(max-width:430px){.simcontrols{grid-template-columns:1fr}}
  `;
  d.head.appendChild(style);

  const createMandateButton = d.getElementById('createMandate');
  const copyStateHost = d.getElementById('copyState');
  if (createMandateButton && !d.getElementById('copyConsent')) {
    const consentWrap = d.createElement('div');
    consentWrap.className = 'copyconsent';
    consentWrap.innerHTML = `
      <label><input id="copyConsent" type="checkbox"><span>I understand this creates a SHADOW Copy Mandate only. It stores my follower intent and risk limits; it does not sign a transaction, move funds, or enable LIVE execution.</span></label>
      <div class="consentmeta">Consent version: aether.copy_mandate.consent.v1 · Policy: FIXED_USD · The Max copy per trade amount is the fixed policy value.</div>
    `;
    createMandateButton.parentNode.insertBefore(consentWrap, createMandateButton);
    const consent = d.getElementById('copyConsent');
    createMandateButton.disabled = true;
    consent.addEventListener('change', () => { createMandateButton.disabled = !consent.checked; });
    createMandateButton.addEventListener('click', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!consent.checked) {
        if (copyStateHost) copyStateHost.textContent = 'Review and accept the SHADOW Copy Mandate consent before creating a mandate.';
        return;
      }
      const traderId = d.getElementById('copyTrader')?.value || '';
      if (!traderId) {
        if (copyStateHost) copyStateHost.textContent = 'Select a verified trader first.';
        return;
      }
      const maxCopy = Number(d.getElementById('copyAmount')?.value);
      const maxPosition = Number(d.getElementById('positionAmount')?.value);
      const toBps = id => Math.round(Number(d.getElementById(id)?.value) * 100);
      const payload = {
        trader_id: traderId,
        consent_accepted: true,
        consent_version: 'aether.copy_mandate.consent.v1',
        policy_type: 'FIXED_USD',
        policy_value: maxCopy,
        max_copy_amount_usd: maxCopy,
        max_position_amount_usd: maxPosition,
        allocation_bps: toBps('allocationPct'),
        max_slippage_bps: toBps('slippagePct'),
        max_daily_loss_bps: toBps('dailyLossPct'),
        stop_drawdown_bps: toBps('drawdownPct')
      };
      createMandateButton.disabled = true;
      if (copyStateHost) {
        copyStateHost.className = 'status';
        copyStateHost.textContent = 'Creating versioned SHADOW Copy Mandate…';
      }
      try {
        const response = await fetch('/api/account/copy-mandates', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({ error: 'invalid_response' }));
        if (!response.ok) throw Object.assign(new Error(data.error || `HTTP_${response.status}`), { status: response.status });
        if (copyStateHost) {
          copyStateHost.className = 'status';
          copyStateHost.textContent = 'SHADOW Copy Mandate created with explicit versioned consent. LIVE authorized=false.';
        }
        setTimeout(() => location.reload(), 450);
      } catch (error) {
        const messages = {
          copy_mandate_exists: 'A mandate for this trader already exists. Use the existing mandate controls.',
          self_copy_not_allowed: 'You cannot create a copy mandate for your own trader profile.',
          trader_not_copyable: 'This trader is not currently verified and published for copying.',
          copy_mandate_consent_required: 'Explicit SHADOW Copy Mandate consent is required.',
          invalid_consent_version: 'The Copy Mandate consent version is not accepted.',
          invalid_policy_type: 'The selected Copy Mandate policy is not supported.',
          invalid_policy_value: 'The fixed copy amount is invalid.'
        };
        if (copyStateHost) {
          copyStateHost.className = 'status warn';
          copyStateHost.textContent = messages[error.message] || 'Copy Mandate creation did not complete. No execution authority changed.';
        }
        createMandateButton.disabled = !consent.checked;
      }
    }, true);
  }

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

  const activitySection = d.createElement('section');
  activitySection.id = 'copy-activity';
  activitySection.className = 'card full copyactivity';
  activitySection.innerHTML = `
    <div class="eyebrow">Follower Center</div>
    <h2>Active Trades & Copy Activity</h2>
    <p class="sectionintro">Follower-specific execution activity generated from your copy workflow. PENDING and QUEUED requests are shown as in-flight. SHADOW simulations never move funds.</p>
    <div id="copyActivityState" class="status warn" role="status" aria-live="polite">Loading your follower execution activity…</div>
    <div class="activitysummary">
      <div class="activitymetric"><span>In flight</span><b id="activityInFlight">—</b></div>
      <div class="activitymetric"><span>Simulated</span><b id="activitySimulated">—</b></div>
      <div class="activitymetric"><span>Completed</span><b id="activityCompleted">—</b></div>
      <div class="activitymetric"><span>Rejected / failed</span><b id="activityFailed">—</b></div>
    </div>
    <div id="copyActivityList" class="activitylist"><div class="activityrow"><span class="meta">No activity loaded yet.</span></div></div>
    <div class="activitynote"><strong>Open-position PnL is not inferred from execution requests.</strong> Position accounting must be independently integrated before AETHER shows entry price, current price, unrealized PnL or a position as OPEN. This prevents simulated or incomplete execution records from being presented as real positions.</div>
  `;
  copySection.parentNode.insertBefore(activitySection, copySection.nextSibling);

  const $ = id => d.getElementById(id);
  const scenarios = ['qualified_entry', 'healthy_position', 'trailing_stop_exit', 'risk_reject', 'stop_loss_exit'];
  let autoTimer = null;
  let autoIndex = 0;
  let running = false;
  let activityTimer = null;
  const history = [];

  const money = value => {
    const n = Number(value);
    return Number.isFinite(n) ? '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  };
  const pctBps = value => {
    const n = Number(value);
    return Number.isFinite(n) ? (n / 100).toFixed(2).replace(/\.00$/, '') + '%' : '—';
  };
  const shortHash = value => {
    const text = String(value || '');
    return text.length > 16 ? `${text.slice(0, 7)}…${text.slice(-7)}` : (text || '—');
  };
  const safeDate = value => {
    const time = new Date(value || 0);
    return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString();
  };

  function renderHistory() {
    $('simHistory').innerHTML = history.length ? history.map(row => `<div><b>${row.action}</b> · ${row.scenario} · score ${row.score} · ${row.time}</div>`).join('') : '<div>No simulation steps yet.</div>';
  }

  function renderCopyActivity(data) {
    const summary = data?.summary || {};
    $('activityInFlight').textContent = String(Number(summary.in_flight || 0));
    $('activitySimulated').textContent = String(Number(summary.simulated || 0));
    $('activityCompleted').textContent = String(Number(summary.completed || 0));
    $('activityFailed').textContent = String(Number(summary.failed || 0));
    const rows = Array.isArray(data?.items) ? data.items : [];
    $('copyActivityState').className = rows.length ? 'status' : 'status warn';
    $('copyActivityState').textContent = rows.length
      ? `${rows.length} follower execution record(s) · SHADOW posture · LIVE authorized=false.`
      : 'No follower execution activity yet. Your copy mandate can exist before any trade signal creates an execution request.';
    $('copyActivityList').innerHTML = '';
    if (!rows.length) {
      const empty = d.createElement('div');
      empty.className = 'activityrow';
      empty.innerHTML = '<span class="meta">No copy execution records yet.</span>';
      $('copyActivityList').appendChild(empty);
      return;
    }
    for (const item of rows.slice(0, 50)) {
      const row = d.createElement('div');
      row.className = 'activityrow';
      const pair = item.token_in || item.token_out ? `${shortHash(item.token_in)} → ${shortHash(item.token_out)}` : 'Token pair unavailable';
      const status = String(item.status || 'UNKNOWN').toUpperCase();
      const badgeClass = ['REJECTED', 'FAILED'].includes(status) ? 'activitybadge failed' : ['SIMULATED', 'EXECUTED'].includes(status) ? 'activitybadge terminal' : 'activitybadge';
      row.innerHTML = `<strong>${pair} · ${money(item.requested_amount_usd)}</strong><div class="meta">Trader ${shortHash(item.trader_id)} · ${item.dex || 'DEX unavailable'} · ${item.mode || 'SHADOW'} · Updated ${safeDate(item.updated_at || item.created_at)}<br>Source trade reference ${shortHash(item.source_tx_hash)} · follower execution ${shortHash(item.execution_request_id)}</div><span class="${badgeClass}">${status}</span>`;
      $('copyActivityList').appendChild(row);
    }
  }

  async function loadCopyActivity() {
    try {
      const response = await fetch('/api/account/copy-trades?limit=50', { cache: 'no-store', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => ({ error: 'invalid_response' }));
      if (!response.ok) throw Object.assign(new Error(data.error || `HTTP_${response.status}`), { status: response.status });
      renderCopyActivity(data);
    } catch (error) {
      $('copyActivityState').className = 'status warn';
      $('copyActivityState').textContent = error.status === 401
        ? 'Secure wallet session required. Reconnect from onboarding.'
        : 'Follower execution activity is temporarily unavailable. No execution authority changed.';
    }
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
  d.addEventListener('visibilitychange', () => {
    if (d.hidden && autoTimer) stopAuto();
    if (!d.hidden) loadCopyActivity();
  });

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

  loadCopyActivity();
  activityTimer = setInterval(() => { if (!d.hidden) loadCopyActivity(); }, 15000);
  window.addEventListener('pagehide', () => { if (activityTimer) clearInterval(activityTimer); }, { once: true });
})();
