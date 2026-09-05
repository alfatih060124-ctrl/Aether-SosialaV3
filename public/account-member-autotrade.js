(() => {
  const d = document;

  function addMemberChrome(session) {
    d.documentElement.dataset.aetherMember = 'authenticated';
    const nav = d.querySelector('.nav');
    if (!nav) return;
    const existing = d.getElementById('memberSessionControls');
    if (existing) return;
    const host = d.createElement('div');
    host.id = 'memberSessionControls';
    host.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    const badge = d.createElement('span');
    badge.className = 'membertag';
    const wallet = String(session?.user?.primary_wallet || '');
    badge.textContent = wallet ? `MEMBER · ${wallet.slice(0,4)}…${wallet.slice(-4)}` : 'MEMBER SESSION';
    const logout = d.createElement('button');
    logout.type = 'button';
    logout.className = 'btn secondary small';
    logout.style.margin = '0';
    logout.textContent = 'Logout';
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
      location.replace('/');
    });
    host.append(badge, logout);
    const mode = nav.querySelector('.shadowpill');
    if (mode) mode.insertAdjacentElement('beforebegin', host);
    else nav.appendChild(host);
  }

  function applyAutoTradeMenu() {
    const topLink = d.querySelector('.navlinks a[href="#auto-strategy"], .navlinks a[href="/autotrade-demo"]');
    if (topLink) {
      topLink.href = '/autotrade-demo';
      topLink.textContent = 'Auto Trade';
      topLink.setAttribute('aria-label', 'Open AETHER Auto Trade Arbitrage');
    }
    const mapLink = d.querySelector('.navmap a[href="#auto-strategy"], .navmap a[href="/autotrade-demo"]');
    if (mapLink) {
      mapLink.href = '/autotrade-demo';
      mapLink.innerHTML = '<span class="navicon">⚙</span><span><b>Auto Trade Arbitrage</b><small>Open the member-only AETHER real-market arbitrage simulator and execution workspace.</small></span>';
    }
    const quickLink = d.querySelector('.quickgrid a[href="#auto-strategy"], .quickgrid a[href="/autotrade-demo"]');
    if (quickLink) {
      quickLink.href = '/autotrade-demo';
      const title = quickLink.querySelector('.qtitle');
      const copy = quickLink.querySelector('.qcopy');
      if (title) title.textContent = 'Auto Trade Arbitrage';
      if (copy) copy.textContent = 'Run ORCA ↔ Raydium arbitrage in PAPER/SHADOW now; LIVE uses the same qualified opportunity contract behind separate real-execution gates.';
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

  async function enforceMemberSession() {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('session_required');
      const session = await response.json();
      addMemberChrome(session);
      applyAutoTradeMenu();
      return true;
    } catch {
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      location.replace(`/onboarding?next=${next}`);
      return false;
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
  enforceMemberSession();
})();
