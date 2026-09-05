(() => {
  const d = document;

  const memberMenu = [
    { label: 'Home', href: '/account', icon: '⌂', description: 'Overview, next step, wallet session and member status.' },
    { label: 'Auto Trade', href: '/autotrade-demo', icon: '⚙', description: 'ORCA ↔ Raydium arbitrage workspace for PAPER/SHADOW and gated LIVE.' },
    { label: 'Market Discovery', href: '/market', icon: '◈', description: 'Find Solana markets and review liquidity, price and risk context.' },
    { label: 'Trader Marketplace', href: '/marketplace', icon: '◎', description: 'Review verified published traders before following or copying.' },
    { label: 'Copy Trading', href: '#copy-mandates', icon: '⇄', description: 'Create and manage follower-owned SHADOW copy mandates.' },
    { label: 'Trader Center', href: '#become-trader', icon: '↗', description: 'Apply as a trader and review verification status.' },
    { label: 'Account & Wallet', href: '#account-identity', icon: '◉', description: 'Verified wallet, member identity, service access and session controls.' },
    { label: 'System Status', href: '/dashboard', icon: '●', description: 'Runtime, SHADOW posture, safety gates and service health.' },
    { label: 'Help & Safety', href: '#help-safety', icon: '?', description: 'Wallet signatures, non-custodial safety and AETHER operating rules.' },
  ];

  function addMemberChrome(session) {
    d.documentElement.dataset.aetherMember = 'authenticated';
    const nav = d.querySelector('.nav');
    if (!nav || d.getElementById('memberSessionControls')) return;
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

  function buildTopNavigation() {
    const navlinks = d.querySelector('.navlinks');
    if (!navlinks) return;
    const items = [
      ['Home', '/account'],
      ['Auto Trade', '/autotrade-demo'],
      ['Markets', '/market'],
      ['Traders', '/marketplace'],
      ['Copy', '#copy-mandates'],
      ['Account', '#account-identity'],
    ];
    navlinks.replaceChildren();
    for (const [label, href] of items) {
      const a = d.createElement('a');
      a.href = href;
      a.textContent = label;
      if ((href === '/account' && location.pathname === '/account') || (href.startsWith('/') && href !== '/account' && location.pathname === href)) a.className = 'active';
      if (label === 'Auto Trade') a.setAttribute('aria-label', 'Open AETHER Auto Trade Arbitrage');
      navlinks.appendChild(a);
    }
  }

  function buildFunctionalNavigator() {
    const map = d.querySelector('.navmap');
    if (!map) return;
    map.replaceChildren();
    for (const item of memberMenu) {
      const a = d.createElement('a');
      a.className = 'navitem';
      a.href = item.href;
      const icon = d.createElement('span');
      icon.className = 'navicon';
      icon.textContent = item.icon;
      const body = d.createElement('span');
      const title = d.createElement('b');
      title.textContent = item.label;
      const copy = d.createElement('small');
      copy.textContent = item.description;
      body.append(title, copy);
      a.append(icon, body);
      map.appendChild(a);
    }

    const heading = d.querySelector('.navigatorhead h2');
    const intro = d.querySelector('.navigatorhead p');
    if (heading) heading.textContent = 'Member tools arranged by function.';
    if (intro) intro.textContent = 'Start with Auto Trade or Market Discovery, then move to social tools, account controls and system status.';

    const next = d.getElementById('nextStep');
    if (next) {
      const label = next.querySelector('.nextlabel');
      const title = next.querySelector('b');
      const copy = next.querySelector('span');
      if (label) label.textContent = 'Recommended flow';
      if (title) title.textContent = '1. Review market → 2. Open Auto Trade → 3. Run PAPER/SHADOW → 4. Enable LIVE only after all gates pass';
      if (copy) copy.textContent = 'PAPER/SHADOW remains available to members without a paid LIVE subscription. LIVE uses the same ORCA ↔ Raydium arbitrage logic behind subscription, wallet authority, funding and safety gates.';
    }
  }

  function applyAutoTradeCards() {
    const quick = d.querySelector('.quickgrid a[href="#auto-strategy"], .quickgrid a[href="/autotrade-demo"]');
    if (quick) {
      quick.href = '/autotrade-demo';
      quick.classList.add('primary');
      const title = quick.querySelector('.qtitle');
      const copy = quick.querySelector('.qcopy');
      if (title) title.textContent = 'Auto Trade Arbitrage';
      if (copy) copy.textContent = 'Run ORCA ↔ Raydium two-leg arbitrage in PAPER/SHADOW. LIVE uses the same qualified opportunity contract behind separate real-execution gates.';
    }
  }

  function buildBottomNavigation() {
    const bottom = d.querySelector('.bottomnav');
    if (!bottom) return;
    const items = [
      ['⌂', 'Home', '/account'],
      ['⚙', 'Auto Trade', '/autotrade-demo'],
      ['◈', 'Markets', '/market'],
      ['◎', 'Traders', '/marketplace'],
      ['◉', 'Account', '#account-identity'],
    ];
    bottom.replaceChildren();
    for (const [icon, label, href] of items) {
      const a = d.createElement('a');
      a.href = href;
      if ((href === '/account' && location.pathname === '/account') || (href.startsWith('/') && href !== '/account' && location.pathname === href)) a.className = 'active';
      const i = d.createElement('span');
      i.textContent = icon;
      a.append(i, d.createTextNode(label));
      bottom.appendChild(a);
    }
    bottom.style.gridTemplateColumns = `repeat(${items.length},1fr)`;
  }

  function applyMemberNavigation() {
    buildTopNavigation();
    buildFunctionalNavigator();
    applyAutoTradeCards();
    buildBottomNavigation();
  }

  async function enforceMemberSession() {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('session_required');
      const session = await response.json();
      addMemberChrome(session);
      applyMemberNavigation();
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
    applyMemberNavigation();
    setTimeout(applyMemberNavigation, 0);
  };
  d.head.appendChild(core);
  enforceMemberSession();
})();
