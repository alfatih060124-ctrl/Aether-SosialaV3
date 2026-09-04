(() => {
  const d = document;

  function applyAutoTradeMenu() {
    const topLink = d.querySelector('.navlinks a[href="#auto-strategy"], .navlinks a[href="/autotrade-demo"]');
    if (topLink) {
      topLink.href = '/autotrade-demo';
      topLink.textContent = 'Auto Trade';
      topLink.setAttribute('aria-label', 'Open AETHER Auto Trade Demo');
    }

    const mapLink = d.querySelector('.navmap a[href="#auto-strategy"], .navmap a[href="/autotrade-demo"]');
    if (mapLink) {
      mapLink.href = '/autotrade-demo';
      mapLink.innerHTML = '<span class="navicon">⚙</span><span><b>Auto Trade</b><small>Open your persistent AETHER SHADOW auto-trade demo, balance, PnL and trade history.</small></span>';
    }

    const quickLink = d.querySelector('.quickgrid a[href="#auto-strategy"], .quickgrid a[href="/autotrade-demo"]');
    if (quickLink) {
      quickLink.href = '/autotrade-demo';
      const title = quickLink.querySelector('.qtitle');
      const copy = quickLink.querySelector('.qcopy');
      if (title) title.textContent = 'Auto Trade Demo';
      if (copy) copy.textContent = 'Run AETHER automatically in SHADOW mode with your persistent demo balance and trade history.';
    }

    const bottomNav = d.querySelector('.bottomnav');
    if (bottomNav && !bottomNav.querySelector('a[href="/autotrade-demo"]')) {
      const link = d.createElement('a');
      link.href = '/autotrade-demo';
      link.className = 'autotrade';
      link.innerHTML = '<span>⚙</span>Auto Trade';
      const copyLink = bottomNav.querySelector('a[href="#copy-mandates"]');
      bottomNav.insertBefore(link, copyLink || null);
      bottomNav.style.gridTemplateColumns = `repeat(${bottomNav.querySelectorAll('a').length},1fr)`;
    }
  }

  const core = d.createElement('script');
  core.src = '/account-auto-strategy-core.js';
  core.dataset.aetherAutoStrategyCore = 'true';
  core.onload = () => {
    applyAutoTradeMenu();
    setTimeout(applyAutoTradeMenu, 0);
  };
  d.head.appendChild(core);
})();
