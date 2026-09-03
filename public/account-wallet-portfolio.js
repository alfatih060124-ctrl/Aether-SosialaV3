(() => {
  const d = document;
  const copySection = d.getElementById('copy-mandates');
  if (!copySection || d.getElementById('wallet-portfolio')) return;

  const style = d.createElement('style');
  style.textContent = `
    .walletportfolio{border-color:rgba(141,230,207,.28)!important}
    .walletmetrics{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:14px}
    .walletmetric{padding:13px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#091523}
    .walletmetric span{display:block;color:#8194b0;font-size:9px;text-transform:uppercase;letter-spacing:.1em}
    .walletmetric b{display:block;margin-top:7px;font-size:20px;overflow-wrap:anywhere}
    .walletmetric small{display:block;margin-top:5px;color:#9fb0c8;font-size:10px;line-height:1.4}
    .walletassets{display:grid;gap:7px;margin-top:10px}
    .walletasset{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 11px;border:1px solid rgba(255,255,255,.06);border-radius:10px;background:#081321;align-items:center}
    .walletasset b{font-size:12px}.walletasset small{display:block;margin-top:3px;color:#7f91aa;font-size:9px;word-break:break-all}.walletasset span{font-size:12px;color:#edf4ff}
    .walletactions{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:12px}.walletactions .btn{width:auto;margin-top:0}
    @media(max-width:760px){.walletmetrics{grid-template-columns:1fr}.walletactions .btn{width:100%}}
  `;
  d.head.appendChild(style);

  const section = d.createElement('section');
  section.id = 'wallet-portfolio';
  section.className = 'card full walletportfolio';
  section.innerHTML = `
    <div class="eyebrow">Wallet Portfolio</div>
    <h2>Read-only Wallet Balance</h2>
    <p class="sectionintro">AETHER reads the public on-chain balance of your verified primary wallet. USDC is the primary trading currency, SOL is kept visible for network fees, and USDT is treated as an optional supported asset.</p>
    <div id="walletPortfolioState" class="status warn" role="status" aria-live="polite">Loading public Solana balances…</div>
    <div class="walletmetrics">
      <div class="walletmetric"><span>USDC trading balance</span><b id="portfolioUsdc">—</b><small>Primary AETHER base currency</small></div>
      <div class="walletmetric"><span>SOL balance</span><b id="portfolioSol">—</b><small>Network fee / gas reserve</small></div>
      <div class="walletmetric"><span>USDT balance</span><b id="portfolioUsdt">—</b><small>Optional stable asset</small></div>
    </div>
    <div class="walletactions"><button id="walletPortfolioRefresh" class="btn secondary small" type="button">Refresh Balance</button><span id="walletPortfolioFreshness" class="muted">—</span></div>
    <div class="label" style="margin-top:14px">Other SPL assets</div>
    <div id="walletPortfolioAssets" class="walletassets"><div class="muted">Loading token accounts…</div></div>
    <div class="locked" style="margin-top:14px"><strong>Read-only · Non-custodial.</strong><br>No private key, seed phrase, signer, transaction or transfer authority is required to read these balances. RPC failure is shown as unavailable and is never converted into a zero balance. LIVE remains disabled.</div>
  `;
  copySection.parentNode.insertBefore(section, copySection);

  const $ = id => d.getElementById(id);
  const number = (value, digits = 6) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  };
  const shortMint = mint => mint ? `${mint.slice(0, 5)}…${mint.slice(-5)}` : 'Unknown mint';

  function renderAssets(assets) {
    const host = $('walletPortfolioAssets');
    host.textContent = '';
    const others = (Array.isArray(assets) ? assets : []).filter(asset => !['USDC', 'USDT'].includes(asset.symbol));
    if (!others.length) {
      const empty = d.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No other non-zero SPL token balances detected.';
      host.appendChild(empty);
      return;
    }
    for (const asset of others.slice(0, 20)) {
      const row = d.createElement('div');
      row.className = 'walletasset';
      const left = d.createElement('div');
      const title = d.createElement('b');
      title.textContent = asset.symbol || shortMint(asset.mint);
      const mint = d.createElement('small');
      mint.textContent = `${asset.mint || 'unknown'} · ${asset.token_program || 'SPL'}`;
      left.append(title, mint);
      const amount = d.createElement('span');
      amount.textContent = number(asset.amount, 8);
      row.append(left, amount);
      host.appendChild(row);
    }
  }

  async function loadPortfolio() {
    const button = $('walletPortfolioRefresh');
    button.disabled = true;
    $('walletPortfolioState').className = 'status';
    $('walletPortfolioState').textContent = 'Reading public Solana balances…';
    try {
      const response = await fetch('/api/account/wallet-portfolio', { cache: 'no-store', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => ({ error: 'invalid_response' }));
      if (!response.ok) throw Object.assign(new Error(data.error || `HTTP_${response.status}`), { status: response.status });
      $('portfolioUsdc').textContent = `${number(data.balances?.usdc?.amount, 6)} USDC`;
      $('portfolioSol').textContent = `${number(data.balances?.sol?.amount, 9)} SOL`;
      $('portfolioUsdt').textContent = `${number(data.balances?.usdt?.amount, 6)} USDT`;
      $('walletPortfolioState').className = 'status';
      $('walletPortfolioState').textContent = 'On-chain balance available · read-only · non-custodial · LIVE authorized=false.';
      const observed = data.observed_at ? new Date(data.observed_at) : null;
      $('walletPortfolioFreshness').textContent = observed && !Number.isNaN(observed.getTime()) ? `Observed ${observed.toLocaleString()}${data.cached ? ' · cached briefly' : ''}` : 'Observed on Solana RPC';
      renderAssets(data.assets);
    } catch (error) {
      $('portfolioUsdc').textContent = 'Unavailable';
      $('portfolioSol').textContent = 'Unavailable';
      $('portfolioUsdt').textContent = 'Unavailable';
      $('walletPortfolioState').className = 'status warn';
      $('walletPortfolioState').textContent = error.status === 401 ? 'Secure wallet session required.' : 'Wallet balance is temporarily unavailable. This does not mean the wallet balance is zero.';
      $('walletPortfolioFreshness').textContent = 'No fresh RPC observation available.';
      const host = $('walletPortfolioAssets');
      host.textContent = '';
      const note = d.createElement('div');
      note.className = 'muted';
      note.textContent = 'Token balances unavailable until the read-only RPC request succeeds.';
      host.appendChild(note);
    } finally {
      button.disabled = false;
    }
  }

  $('walletPortfolioRefresh').addEventListener('click', loadPortfolio);
  loadPortfolio();
})();
