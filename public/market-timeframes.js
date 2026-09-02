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
  const SVG_NS = 'http://www.w3.org/2000/svg';
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

  function normalizedCandles(series) {
    return (Array.isArray(series) ? series : []).map(x => ({
      timestamp: Number(x.timestamp),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volume) || 0,
    })).filter(x => Number.isFinite(x.timestamp)
      && [x.open, x.high, x.low, x.close].every(Number.isFinite)
      && x.high >= x.low
      && x.high >= Math.max(x.open, x.close)
      && x.low <= Math.min(x.open, x.close));
  }

  function priceText(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (n >= 0.01) return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return '$' + n.toPrecision(5);
  }

  function volumeText(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (typeof money === 'function') return money(n);
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
  }

  function timeText(timestamp) {
    const n = Number(timestamp);
    if (!Number.isFinite(n)) return '—';
    const date = new Date(n * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function ensureChartReadout() {
    const wrap = document.querySelector('.chartwrap');
    const chart = document.getElementById('chart');
    if (!wrap || !chart) return null;
    let readout = document.getElementById('chartOhlcReadout');
    if (!readout) {
      readout = document.createElement('div');
      readout.id = 'chartOhlcReadout';
      readout.className = 'ohlcreadout';
      readout.innerHTML = '<span class="ohlctime">Tap or move across the chart</span><span>O <b id="ohlcOpen">—</b></span><span>H <b id="ohlcHigh">—</b></span><span>L <b id="ohlcLow">—</b></span><span>C <b id="ohlcClose">—</b></span><span>Vol <b id="ohlcVolume">—</b></span>';
      chart.insertAdjacentElement('beforebegin', readout);
    }
    return readout;
  }

  function showCandleReadout(candle) {
    if (!candle) return;
    const readout = ensureChartReadout();
    if (!readout) return;
    const t = readout.querySelector('.ohlctime');
    if (t) t.textContent = `${FRAME_LABELS[activeTimeframe]} · ${timeText(candle.timestamp)}`;
    const map = {
      ohlcOpen: candle.open,
      ohlcHigh: candle.high,
      ohlcLow: candle.low,
      ohlcClose: candle.close,
    };
    for (const [id, value] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.textContent = priceText(value);
    }
    const volume = document.getElementById('ohlcVolume');
    if (volume) volume.textContent = volumeText(candle.volume);
    readout.dataset.direction = candle.close >= candle.open ? 'up' : 'down';
  }

  function addCrosshair(series) {
    const chart = document.getElementById('chart');
    const svg = chart?.querySelector('svg');
    const rows = normalizedCandles(series).slice(-72);
    if (!chart || !svg || rows.length < 2) return;
    ensureChartReadout();
    showCandleReadout(rows[rows.length - 1]);

    const lo = Math.min(...rows.map(x => x.low));
    const hi = Math.max(...rows.map(x => x.high));
    const priceSpan = Math.max(hi - lo, Number.EPSILON);
    const w = 720, left = 8, right = 54, top = 10, priceBottom = 218;
    const plotW = w - left - right;
    const step = plotW / rows.length;
    const y = price => top + (hi - price) / priceSpan * (priceBottom - top);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-chart-crosshair', 'true');
    group.setAttribute('visibility', 'hidden');
    group.setAttribute('pointer-events', 'none');
    const vertical = document.createElementNS(SVG_NS, 'line');
    vertical.setAttribute('y1', String(top));
    vertical.setAttribute('y2', '268');
    vertical.setAttribute('stroke', '#74869d');
    vertical.setAttribute('stroke-width', '1');
    vertical.setAttribute('stroke-dasharray', '3 3');
    vertical.setAttribute('opacity', '.65');
    const horizontal = document.createElementNS(SVG_NS, 'line');
    horizontal.setAttribute('x1', String(left));
    horizontal.setAttribute('x2', String(w - right));
    horizontal.setAttribute('stroke', '#74869d');
    horizontal.setAttribute('stroke-width', '1');
    horizontal.setAttribute('stroke-dasharray', '3 3');
    horizontal.setAttribute('opacity', '.45');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', '#f7f7f8');
    dot.setAttribute('stroke', '#080d14');
    dot.setAttribute('stroke-width', '1.5');
    group.append(vertical, horizontal, dot);
    svg.appendChild(group);

    const update = event => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const clientX = event.clientX ?? event.touches?.[0]?.clientX;
      if (!Number.isFinite(clientX)) return;
      const viewX = ((clientX - rect.left) / rect.width) * w;
      const clampedX = Math.min(w - right - 0.01, Math.max(left, viewX));
      const index = Math.min(rows.length - 1, Math.max(0, Math.floor((clampedX - left) / step)));
      const candle = rows[index];
      const x = left + step * index + step / 2;
      const cy = y(candle.close);
      vertical.setAttribute('x1', x.toFixed(2));
      vertical.setAttribute('x2', x.toFixed(2));
      horizontal.setAttribute('y1', cy.toFixed(2));
      horizontal.setAttribute('y2', cy.toFixed(2));
      dot.setAttribute('cx', x.toFixed(2));
      dot.setAttribute('cy', cy.toFixed(2));
      dot.setAttribute('fill', candle.close >= candle.open ? '#52e38e' : '#ff5c67');
      group.setAttribute('visibility', 'visible');
      showCandleReadout(candle);
    };

    chart.onpointerdown = update;
    chart.onpointermove = event => {
      if (event.pointerType === 'mouse' || event.buttons === 1 || event.pointerType === 'pen') update(event);
    };
    chart.onpointerleave = () => {
      group.setAttribute('visibility', 'hidden');
      showCandleReadout(rows[rows.length - 1]);
    };
  }

  function installChartEnhancer() {
    if (typeof window.candleChart !== 'function' || window.candleChart.__aetherEnhanced) return;
    const original = window.candleChart;
    const enhanced = function enhancedCandleChart(series) {
      original(series);
      addCrosshair(series);
    };
    enhanced.__aetherEnhanced = true;
    window.candleChart = enhanced;
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
    style.textContent = '.chartcontrols{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.timeframes{display:flex;align-items:center;gap:4px;padding:3px;border:1px solid #253244;border-radius:9px;background:#090f17}.timeframes button{border:0;background:transparent;color:#728197;padding:6px 8px;border-radius:6px;font-size:9px;font-weight:850;cursor:pointer}.timeframes button.active{background:#1a2635;color:#fff}.chartframe{color:#7f8da0;font-size:9px;white-space:nowrap}.ohlcreadout{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;padding:7px 9px;border:1px solid #1e2b3b;border-radius:9px;background:#090f17;color:#718197;font-size:9px;font-variant-numeric:tabular-nums}.ohlcreadout .ohlctime{color:#a9b6c7;margin-right:auto}.ohlcreadout b{color:#dbe4ef;font-weight:800}.ohlcreadout[data-direction="up"] #ohlcClose{color:#52e38e}.ohlcreadout[data-direction="down"] #ohlcClose{color:#ff5c67}.chart{touch-action:pan-y;cursor:crosshair}.chart[aria-busy="true"]{opacity:.72}@media(max-width:520px){.chartcontrols{width:100%;justify-content:space-between}.timeframes{max-width:100%;overflow:auto}.timeframes button{padding:6px 7px}.ohlcreadout{gap:7px}.ohlcreadout .ohlctime{width:100%;margin-right:0}}';
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
  installChartEnhancer();
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
