(() => {
  const FRAME_LABELS = Object.freeze({
    '5m': '5m',
    '15m': '15m',
    '1h': '1H',
    '4h': '4H',
    '1d': '1D',
    '1w': '1W',
  });
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  let activeTimeframe = '15m';
  let chartRequest = 0;

  function currentMint() {
    const detailMint = String(document.getElementById('detailMint')?.textContent || '').trim();
    if (BASE58.test(detailMint)) return detailMint;
    const searchMint = String(document.getElementById('mint')?.value || '').trim();
    return BASE58.test(searchMint) ? searchMint : '';
  }

  function setActiveButton() {
    document.querySelectorAll('[data-chart-timeframe]').forEach(button => {
      const active = button.dataset.chartTimeframe === activeTimeframe;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const label = document.getElementById('chartTimeframeLabel');
    if (label) label.textContent = `${FRAME_LABELS[activeTimeframe]} · provider-backed OHLCV`;
  }

  async function loadChart(mint, timeframe = activeTimeframe) {
    if (!BASE58.test(mint) || !FRAME_LABELS[timeframe]) return;
    const id = ++chartRequest;
    const chart = document.getElementById('chart');
    const label = document.getElementById('chartTimeframeLabel');
    if (label) label.textContent = `${FRAME_LABELS[timeframe]} · loading provider OHLCV…`;
    if (chart) chart.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`/api/market/chart?mint=${encodeURIComponent(mint)}&timeframe=${encodeURIComponent(timeframe)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('chart_unavailable');
      const data = await response.json();
      if (id !== chartRequest || String(data?.mint || '') !== mint || String(data?.timeframe || '') !== timeframe) return;
      const candles = Array.isArray(data?.candles) ? data.candles : [];
      if (typeof candleChart !== 'function') throw new Error('chart_renderer_unavailable');
      candleChart(candles);
      const svg = document.querySelector('#chart svg');
      if (svg) svg.setAttribute('aria-label', `Provider-backed ${FRAME_LABELS[timeframe]} candlestick price chart with volume`);
      if (label) label.textContent = `${FRAME_LABELS[timeframe]} · GeckoTerminal OHLCV`;
      const url = new URL(location.href);
      url.searchParams.set('mint', mint);
      url.searchParams.set('timeframe', timeframe);
      history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
    } catch {
      if (id !== chartRequest) return;
      if (chart) chart.textContent = 'Timeframe chart temporarily unavailable. No synthetic candles are shown.';
      if (label) label.textContent = `${FRAME_LABELS[timeframe]} · unavailable`;
    } finally {
      if (chart) chart.removeAttribute('aria-busy');
    }
  }

  function installControls() {
    const top = document.querySelector('.charttop');
    if (!top || document.getElementById('chartTimeframes')) return;
    const style = document.createElement('style');
    style.textContent = '.chartcontrols{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.timeframes{display:flex;align-items:center;gap:4px;padding:3px;border:1px solid #253244;border-radius:9px;background:#090f17}.timeframes button{border:0;background:transparent;color:#728197;padding:6px 8px;border-radius:6px;font-size:9px;font-weight:850;cursor:pointer}.timeframes button.active{background:#1a2635;color:#fff}.chartframe{color:#7f8da0;font-size:9px;white-space:nowrap}@media(max-width:520px){.chartcontrols{width:100%;justify-content:space-between}.timeframes{max-width:100%;overflow:auto}.timeframes button{padding:6px 7px}}';
    document.head.appendChild(style);
    const controls = document.createElement('div');
    controls.className = 'chartcontrols';
    controls.innerHTML = `<span id="chartTimeframeLabel" class="chartframe">15m · provider-backed OHLCV</span><div id="chartTimeframes" class="timeframes" role="group" aria-label="Chart timeframe">${Object.entries(FRAME_LABELS).map(([key, label]) => `<button type="button" data-chart-timeframe="${key}" aria-pressed="false">${label}</button>`).join('')}</div>`;
    const legend = top.querySelector('.chartlegend');
    if (legend) legend.insertAdjacentElement('beforebegin', controls);
    else top.appendChild(controls);
    controls.addEventListener('click', event => {
      const button = event.target.closest('[data-chart-timeframe]');
      if (!button) return;
      const next = button.dataset.chartTimeframe;
      if (!FRAME_LABELS[next]) return;
      activeTimeframe = next;
      setActiveButton();
      const mint = currentMint();
      if (mint) loadChart(mint, activeTimeframe);
    });
    setActiveButton();
  }

  const urlFrame = new URL(location.href).searchParams.get('timeframe');
  if (urlFrame && FRAME_LABELS[urlFrame.toLowerCase()]) activeTimeframe = urlFrame.toLowerCase();
  installControls();

  if (typeof analyze === 'function') {
    const originalAnalyze = analyze;
    analyze = async function enhancedAnalyze(mint) {
      await originalAnalyze(mint);
      const normalized = String(mint || '').trim();
      if (BASE58.test(normalized) && activeTimeframe !== '15m') await loadChart(normalized, activeTimeframe);
      else setActiveButton();
    };
  }

  const initialMint = currentMint();
  if (initialMint && activeTimeframe !== '15m') loadChart(initialMint, activeTimeframe);
})();
