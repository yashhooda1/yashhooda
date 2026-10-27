/* ═══════════════════════════════════════════════════════════════════════════
   yashhooda.ai — UI SHELL  (js/ui-shell.js)
   ───────────────────────────────────────────────────────────────────────────
   Navigation + AI affordances layered on top of index.html. Nothing here
   replaces existing page code; it only adds:

     YH.theme    — 8 themes (css/themes.css), persisted, system-aware
     YH.palette  — ⌘K / Ctrl+K command palette: fuzzy jump to any section,
                   actions, recent jumps, voice input, and an AI mode that
                   routes natural-language questions via /api/navigate
     YH.rail     — desktop section rail + scroll-spy + sticky breadcrumb
     YH.mobile   — bottom tab bar on phones
     YH.sections — "✨ Ask AI" + "🔗" tools injected into every section h2
     YH.keys     — keyboard shortcuts (?, /, t, c, g+letter, Esc)
     YH.fit      — Fit Check: instant keyword scan + /api/fit-check report
     YH.toast    — tiny toast helper

   Loaded with `defer`, so it runs after the inline page scripts and can call
   toggleChat(), sendMsg(), showAuthModal() etc. when they exist.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const isLoggedIn = () => {
    try { return !!(window.AUTH_USER || (typeof AUTH_USER !== 'undefined' && AUTH_USER) || (typeof ADMIN_PASSWORD_SESSION !== 'undefined' && ADMIN_PASSWORD_SESSION) || localStorage.getItem('hooda_auth_token')); } catch { return false; }
  };
  const adminPw = () => { try { return (typeof ADMIN_PASSWORD_SESSION !== 'undefined' && ADMIN_PASSWORD_SESSION) || undefined; } catch { return undefined; } };
  const YH = window.YH = window.YH || {};

  /* ── Toast ─────────────────────────────────────────────────────────────── */
  YH.toast = function (msg, ms) {
    let host = $('#yh-toasts');
    if (!host) { host = document.createElement('div'); host.id = 'yh-toasts'; document.body.appendChild(host); }
    const t = document.createElement('div'); t.className = 'yh-toast'; t.textContent = msg; host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms || 2200);
  };

  /* ══════════════════════════════════════════════════════════════════════
     THEMES
     ══════════════════════════════════════════════════════════════════════ */
  const THEMES = [
    { id: 'terminal', name: 'Terminal', sub: 'phosphor green', scheme: 'dark',  c: ['#0d1117', '#4caf50', '#1e293b'] },
    { id: 'midnight', name: 'Midnight', sub: 'navy · cyan',    scheme: 'dark',  c: ['#050b17', '#22d3ee', '#0b1526'] },
    { id: 'aurora',   name: 'Aurora',   sub: 'violet dusk',    scheme: 'dark',  c: ['#0e0a1f', '#a78bfa', '#171130'] },
    { id: 'ember',    name: 'Ember',    sub: 'amber · warm',   scheme: 'dark',  c: ['#120d09', '#f59e0b', '#1e1611'] },
    { id: 'cockpit',  name: 'Cockpit',  sub: 'OLED · avionics',scheme: 'dark',  c: ['#000000', '#ffb000', '#0a0a0a'] },
    { id: 'rose',     name: 'Rose',     sub: 'graphite · pink',scheme: 'dark',  c: ['#140b12', '#f472b6', '#1f1320'] },
    { id: 'daylight', name: 'Daylight', sub: 'light · forest', scheme: 'light', c: ['#f4f6f4', '#2e7d32', '#ffffff'] },
    { id: 'paper',    name: 'Paper',    sub: 'cream · teal',   scheme: 'light', c: ['#faf6ee', '#0f766e', '#fffdf8'] },
  ];
  const theme = YH.theme = {
    list: THEMES,
    current() { return document.documentElement.getAttribute('data-theme') || 'terminal'; },
    apply(id, opts) {
      const t = THEMES.find(x => x.id === id) || THEMES[0];
      const html = document.documentElement;
      if (!(opts && opts.silent)) { html.classList.add('yh-theme-anim'); setTimeout(() => html.classList.remove('yh-theme-anim'), 450); }
      html.setAttribute('data-theme', t.id);
      html.setAttribute('data-scheme', t.scheme);
      const meta = $('#meta-theme-color'); if (meta) meta.setAttribute('content', t.c[0]);
      const name = $('#nav-theme-name'); if (name) name.textContent = t.name;
      $$('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === t.id));
      if (!(opts && opts.noSave)) store.set('yh_theme', t.id);
      window.dispatchEvent(new CustomEvent('yh:themechange', { detail: { theme: t.id, scheme: t.scheme } }));
      if (!(opts && opts.silent)) YH.toast(`Theme: ${t.name}`);
    },
    cycle() { const i = THEMES.findIndex(t => t.id === theme.current()); theme.apply(THEMES[(i + 1) % THEMES.length].id); },
    useSystem() { store.set('yh_theme', 'system'); const light = matchMedia('(prefers-color-scheme: light)').matches; theme.apply(light ? 'daylight' : 'terminal', { noSave: true }); },
    toggle(ev) {
      if (ev) ev.stopPropagation();
      const p = buildThemePop(); p.classList.toggle('open');
      if (!p.classList.contains('open')) return;
      $$('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === theme.current()));
      // anchor under whichever button opened it (nav button or mobile bar)
      const btn = (ev && ev.target && ev.target.closest('button')) || $('#nav-theme-btn');
      const r = btn ? btn.getBoundingClientRect() : null;
      if (r && r.bottom < window.innerHeight - 200) { p.style.top = Math.round(r.bottom + 8) + 'px'; p.style.bottom = 'auto'; p.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px'; }
      else { p.style.top = 'auto'; p.style.bottom = '72px'; p.style.right = '8px'; }
    },
    close() { const p = $('#yh-theme-pop'); if (p) p.classList.remove('open'); },
  };
  function buildThemePop() {
    let p = $('#yh-theme-pop'); if (p) return p;
    p = document.createElement('div'); p.id = 'yh-theme-pop'; p.className = 'theme-pop'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Choose a theme');
    p.innerHTML = `<h5><span>🎨 Themes</span><span>press <kbd>t</kbd> to cycle</span></h5>
      <div class="theme-grid">${THEMES.map(t => `<button class="theme-card" data-theme="${t.id}" title="${t.name}">
        <span class="tc-preview" style="background:${t.c[0]}"><i style="background:${t.c[1]}"></i><i style="background:${t.c[2]};outline:1px solid ${t.c[1]}55"></i><i style="background:${t.c[1]};opacity:.6"></i></span>
        <span><span class="tc-name">${t.name}</span><br><span class="tc-sub">${t.sub}</span></span></button>`).join('')}</div>
      <div class="tp-foot"><span>saved on this device</span><button type="button" id="yh-theme-system">match system</button></div>`;
    document.body.appendChild(p);
    p.addEventListener('click', e => {
      const card = e.target.closest('.theme-card'); if (card) { theme.apply(card.dataset.theme); return; }
      if (e.target.id === 'yh-theme-system') { theme.useSystem(); theme.close(); }
      e.stopPropagation();
    });
    document.addEventListener('click', e => { if (!e.target.closest('#yh-theme-pop') && !e.target.closest('#nav-theme-btn')) theme.close(); });
    return p;
  }
  // honour the early boot (head script) and keep the nav label in sync
  theme.apply(theme.current(), { silent: true, noSave: true });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (store.get('yh_theme', 'terminal') === 'system') theme.useSystem(); });

  /* ══════════════════════════════════════════════════════════════════════
     SECTION INDEX (shared by palette, rail, navigator)
     ══════════════════════════════════════════════════════════════════════ */
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}\u{200D}\u{2B50}\u{2B06}\u{2194}-\u{21AA}]/gu;
  const clean = s => String(s || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
  // heading text without the injected "Ask AI / 🔗" tool buttons
  const headText = el => { if (!el) return ''; const c = el.cloneNode(true); $$('.yh-sec-tools', c).forEach(t => t.remove()); return c.textContent; };
  // Human hints help the AI navigator and the fuzzy matcher (synonyms users type).
  const HINTS = {
    'about': 'bio, who is yash, background, resume, experience, skills',
    'fit-check': 'job description, JD, hiring, recruiter, match score, am I a fit, resume match',
    'projects': 'portfolio, github, what has he built, HoodaAgents, METAR, PaceForge, fine-tuning, RAG',
    'governance': 'AI governance studio, responsible AI, risk tiers, human oversight, NIST, EU AI Act',
    'aviation': 'flight tracker, infinite flight, live aircraft map, pilot logbook, flying hobby',
    'metar': 'aviation weather streaming, kafka, spark, delta lake, medallion, airports',
    'ercot': 'texas power grid, electricity demand, energy',
    'weather': 'current weather, local conditions, forecast, radar',
    'climate': 'ClimatePulse, warming trends, NOAA, 13 cities, temperature',
    'carbon': 'CO2, carbon, TCRE, emissions, warming',
    'hurricanes': 'storms, atlantic, ACE, sea surface temperature',
    'sealevel': 'rising seas, coastal risk, ice sheets',
    'datacenters': 'AI data centers, energy, water, footprint',
    'apple-lab': 'apple silicon, local LLM benchmark, iOS apps, RunOS, siri shortcuts, M-series',
    'running': 'running journey, marathon, half marathon, races, PRs, training',
    'running-analytics': 'strava intelligence, running stats, analytics',
    'mcp-garmin': 'garmin training plans, MCP server, watch workouts',
    'hoodarun': 'apple watch workout builder, HoodaRun, watchOS',
    'heat-pace': 'heat adjusted pace, humidity, dew point, hot weather running calculator',
    'wind-cold': 'wind chill, cold weather pace adjustment',
    'pace-calc': 'pace calculator, time distance pace, splits',
    'race-predictor': 'race predictor, VDOT, training paces, equivalent race times',
    'heat-equivalent': 'race time by temperature, heat, dew point, convert a race result across conditions',
    'strava-feed': 'live strava feed, latest runs, photos, route maps',
    'thisweek': 'last week activity, weekly mileage',
    'certifications': 'certs, databricks certified, IBM, credentials',
    'tars': 'TARS AI assistant, chatbot',
    'hikes': 'hiking, colorado, lake monarch',
    'snow': 'snow photos, album',
    'network': 'network analyzer, IP, connection info',
    'sports': 'live sports scores, astros, texans, rockets',
    'buildlog': 'build log, changelog, what is new, shipped recently',
    'contact': 'email, linkedin, hire me, get in touch',
  };
  function navGroups() {
    const map = {};
    $$('nav .nav-dropdown').forEach(d => {
      const label = clean($('.nav-drop-trigger', d)?.textContent).replace(/▾/g, '').trim();
      $$('a[href^="#"]', d).forEach(a => { map[a.getAttribute('href').slice(1)] = label; });
    });
    return map;
  }
  function buildIndex() {
    const groups = navGroups();
    const seen = new Set();
    const items = [];
    $$('section[id]').forEach(sec => {
      const id = sec.id; if (seen.has(id)) return; seen.add(id);
      const h2 = $('h2, h1.hpc-title, h1, h3', sec);
      const navA = $(`nav a[href="#${id}"]`);
      const emoji = ((headText(h2) || navA?.textContent || '').match(EMOJI_RE) || ['§'])[0];
      const title = clean(headText(h2)) || clean(navA?.textContent) || id.replace(/-/g, ' ');
      const p = $('p', sec);
      items.push({ id, title, emoji, group: groups[id] || (sec.closest('#about, #projects') ? 'Core' : 'Sections'), hint: HINTS[id] || clean(p?.textContent).slice(0, 140) });
    });
    // standalone anchors that live inside sections (e.g. #journey)
    $$('nav .nav-drop-menu a[href^="#"], nav .nav-links > a[href^="#"]').forEach(a => {
      const id = a.getAttribute('href').slice(1); if (!id || seen.has(id)) return; const el = document.getElementById(id); if (!el) return; seen.add(id);
      items.push({ id, title: clean(a.textContent), emoji: (a.textContent.match(EMOJI_RE) || ['§'])[0], group: groups[id] || 'Sections', hint: HINTS[id] || '' });
    });
    return items;
  }
  let INDEX = [];
  YH.sections = { index: () => INDEX, rebuild: () => (INDEX = buildIndex()) };

  function jump(id, opts) {
    const el = document.getElementById(id); if (!el) return false;
    el.classList.add('visible'); // reveal even if the IntersectionObserver hasn't fired
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { history.replaceState(null, '', '#' + id); } catch {}
    if (!(opts && opts.quiet)) {
      const rec = store.get('yh_recent', []).filter(x => x !== id); rec.unshift(id); store.set('yh_recent', rec.slice(0, 6));
    }
    return true;
  }
  YH.jump = jump;

  /* ══════════════════════════════════════════════════════════════════════
     COMMAND PALETTE
     ══════════════════════════════════════════════════════════════════════ */
  const ACTIONS = [
    { id: 'act-chat',    emoji: '💬', title: 'Open HoodaAgents chat', sub: 'talk to the multi-model assistant', kbd: 'c', run: () => { try { if (typeof chatOpen === 'undefined' || !chatOpen) toggleChat(); } catch {} } },
    { id: 'act-fit',     emoji: '🎯', title: 'Run a Fit Check on a job description', sub: 'AI scores the match, lists gaps', run: () => { jump('fit-check'); setTimeout(() => $('#fc-jd')?.focus(), 500); } },
    { id: 'act-theme',   emoji: '🎨', title: 'Change theme', sub: `${THEMES.length} themes · press t to cycle`, kbd: 't', run: () => setTimeout(() => theme.toggle(), 50) },
    ...THEMES.map(t => ({ id: 'theme-' + t.id, emoji: '◐', title: `Theme: ${t.name}`, sub: t.sub, run: () => theme.apply(t.id), hidden: true })),
    { id: 'act-top',     emoji: '⬆️', title: 'Back to top', sub: '', run: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { id: 'act-copy',    emoji: '🔗', title: 'Copy link to this page', sub: location.host, run: () => navigator.clipboard?.writeText(location.href).then(() => YH.toast('Link copied')) },
    { id: 'act-github',  emoji: '⭐', title: 'Open GitHub profile', sub: 'github.com/yashhooda1', run: () => window.open('https://github.com/yashhooda1', '_blank', 'noopener') },
    { id: 'act-email',   emoji: '📬', title: 'Email Yash', sub: 'yash.hooda6@gmail.com', run: () => { location.href = 'mailto:yash.hooda6@gmail.com'; } },
    { id: 'act-keys',    emoji: '⌨️', title: 'Keyboard shortcuts', sub: 'press ? anytime', kbd: '?', run: () => YH.keys.show() },
  ];
  // fuzzy score: exact > prefix > word-start > subsequence; title weighs more than hint
  function score(q, item) {
    const t = item.title.toLowerCase(), h = (item.hint || '').toLowerCase(), g = (item.group || '').toLowerCase(), id = item.id.toLowerCase();
    if (!q) return 1;
    let s = 0;
    const words = q.split(/\s+/).filter(Boolean);
    for (const w of words) {
      let ws = 0;
      if (t === w || id === w) ws = 100;
      else if (t.startsWith(w) || id.startsWith(w)) ws = 70;
      else if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t)) ws = 55;
      else if (t.includes(w)) ws = 40;
      else if (h.includes(w) || g.includes(w)) ws = 25;
      else if (subseq(w, t)) ws = 10;
      if (!ws) return 0;
      s += ws;
    }
    return s / words.length;
  }
  function subseq(n, h) { let i = 0; for (const c of h) { if (c === n[i]) i++; if (i === n.length) return true; } return false; }
  function hl(text, q) {
    if (!q) return esc(text);
    const words = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return esc(text).replace(new RegExp('(' + words.join('|') + ')', 'ig'), '<mark>$1</mark>');
  }

  const palette = YH.palette = { el: null, sel: 0, items: [], ai: false, rec: null };
  function buildPalette() {
    if (palette.el) return palette.el;
    const el = document.createElement('div'); el.id = 'yh-palette'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Site search');
    el.innerHTML = `<div class="pal-backdrop"></div>
      <div class="pal-box">
        <div class="pal-input-row">
          <span class="pal-icon">⌘</span>
          <input id="yh-pal-input" type="text" placeholder="Jump to a section, run an action, or ask “where can I…”" autocomplete="off" spellcheck="false" aria-label="Search" />
          <button class="pal-mode" id="yh-pal-mode" type="button" title="Toggle AI navigator (or start your query with ?)">AI off</button>
          <button class="pal-mic" id="yh-pal-mic" type="button" title="Voice: say a section name" aria-label="Voice search">🎤</button>
        </div>
        <div class="pal-list" id="yh-pal-list"></div>
        <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> go</span><span><kbd>?</kbd>+query ask AI</span><span><kbd>esc</kbd> close</span></div>
      </div>`;
    document.body.appendChild(el);
    palette.el = el;
    const input = $('#yh-pal-input', el);
    $('.pal-backdrop', el).addEventListener('click', palette.close);
    input.addEventListener('input', () => { palette.sel = 0; palette.rec = null; render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); palette.sel = Math.min(palette.sel + 1, palette.items.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palette.sel = Math.max(palette.sel - 1, 0); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = palette.items[palette.sel]; if (it) choose(it); }
      else if (e.key === 'Escape') { palette.close(); }
      else if (e.key === 'Tab') { e.preventDefault(); palette.ai = !palette.ai; syncMode(); render(); }
    });
    $('#yh-pal-mode', el).addEventListener('click', () => { palette.ai = !palette.ai; syncMode(); render(); input.focus(); });
    $('#yh-pal-list', el).addEventListener('click', e => {
      const row = e.target.closest('.pal-item'); if (row) { const it = palette.items[+row.dataset.i]; if (it) choose(it); return; }
      const j = e.target.closest('.paa-jump'); if (j) { palette.close(); jump(j.dataset.target.slice(1)); }
    });
    $('#yh-pal-mic', el).addEventListener('click', () => voice.toggle());
    return el;
  }
  function syncMode() { const b = $('#yh-pal-mode'); if (b) { b.textContent = palette.ai ? 'AI on' : 'AI off'; b.classList.toggle('ai', palette.ai); } }
  palette.open = function (prefill) {
    buildPalette(); INDEX = buildIndex();
    palette.el.classList.add('open'); document.body.style.overflow = 'hidden';
    const input = $('#yh-pal-input'); input.value = prefill || ''; palette.sel = 0; palette.rec = null; syncMode(); render();
    setTimeout(() => input.focus(), 30);
  };
  palette.close = function () { if (!palette.el) return; palette.el.classList.remove('open'); document.body.style.overflow = ''; voice.stop(); };
  palette.isOpen = () => !!(palette.el && palette.el.classList.contains('open'));

  function render() {
    const list = $('#yh-pal-list'); if (!list) return;
    const raw = $('#yh-pal-input').value;
    let q = raw.trim().toLowerCase();
    const askAI = palette.ai || q.startsWith('?');
    if (q.startsWith('?')) q = q.slice(1).trim();
    const rows = [];
    const push = (group, it) => { rows.push({ group, it }); };

    if (!q) {
      const rec = store.get('yh_recent', []).map(id => INDEX.find(x => x.id === id)).filter(Boolean);
      rec.forEach(it => push('Recent', { ...it, kind: 'section' }));
      ACTIONS.filter(a => !a.hidden).forEach(a => push('Actions', { ...a, kind: 'action' }));
      INDEX.forEach(it => push(it.group, { ...it, kind: 'section' }));
    } else {
      const scored = [
        ...INDEX.map(it => ({ it: { ...it, kind: 'section' }, s: score(q, it) })),
        ...ACTIONS.map(a => ({ it: { ...a, kind: 'action', hint: a.sub }, s: score(q, { title: a.title, hint: a.sub, group: 'actions', id: a.id }) })),
      ].filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 18);
      scored.forEach(x => push(x.it.kind === 'action' ? 'Actions' : x.it.group, x.it));
      if (askAI || q.split(' ').length >= 3 || scored.length === 0) {
        push('Ask', { kind: 'ai', emoji: '✨', title: `Ask HoodaAgents: “${raw.replace(/^\?/, '').trim()}”`, sub: isLoggedIn() ? 'AI navigator finds the right section and answers in one line' : 'log in (free) to use the AI navigator', q: raw.replace(/^\?/, '').trim() });
      }
    }
    palette.items = rows.map(r => r.it);
    if (palette.sel >= palette.items.length) palette.sel = 0;
    let html = '', lastGroup = null;
    rows.forEach((r, i) => {
      if (r.group !== lastGroup) { html += `<div class="pal-group">${esc(r.group)}</div>`; lastGroup = r.group; }
      const it = r.it;
      html += `<div class="pal-item${i === palette.sel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === palette.sel}">
        <span class="pi-ico">${esc(it.emoji || '§')}</span>
        <span class="pi-body"><span class="pi-title">${hl(it.title, q)}</span>${(it.sub || it.hint) ? `<span class="pi-sub">${hl(it.sub || it.hint, q)}</span>` : ''}</span>
        ${it.kbd ? `<span class="pi-kbd">${esc(it.kbd)}</span>` : it.kind === 'section' ? `<span class="pi-kbd">#${esc(it.id)}</span>` : ''}</div>`;
    });
    if (palette.rec) html = renderAI(palette.rec) + html;
    if (!rows.length && !palette.rec) html = `<div class="pal-empty">No matches. Try <b>?</b> + your question to ask the AI navigator.</div>`;
    list.innerHTML = html;
    const selEl = $('.pal-item.sel', list); if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }
  function renderAI(r) {
    if (r.loading) return `<div class="pal-ai-answer"><div class="paa-label"><span class="pal-spin"></span> thinking…</div></div>`;
    if (r.error) return `<div class="pal-ai-answer"><div class="paa-label">✨ navigator</div>${esc(r.error)}</div>`;
    const t = r.target ? INDEX.find(x => '#' + x.id === r.target) : null;
    return `<div class="pal-ai-answer"><div class="paa-label">✨ navigator ${r.cached ? '· cached' : ''}</div>${esc(r.answer || '')}
      ${t ? `<br><button class="paa-jump" data-target="${esc(r.target)}">${esc(t.emoji)} Go to ${esc(t.title)} →</button>` : ''}
      ${(r.alternates || []).map(a => { const x = INDEX.find(y => '#' + y.id === a); return x ? `<button class="paa-jump" style="background:none;border:1px solid var(--border);color:var(--text-muted);margin-left:.4rem" data-target="${esc(a)}">${esc(x.title)}</button>` : ''; }).join('')}</div>`;
  }
  async function choose(it) {
    if (it.kind === 'section') { palette.close(); jump(it.id); return; }
    if (it.kind === 'action') { palette.close(); try { it.run(); } catch (e) { console.warn(e); } return; }
    if (it.kind === 'ai') {
      if (!isLoggedIn()) { palette.close(); try { showAuthModal('login'); } catch { YH.toast('Log in to use the AI navigator'); } return; }
      palette.rec = { loading: true }; render();
      try {
        const body = { q: it.q, sections: INDEX.map(s => ({ id: s.id, title: s.title, group: s.group, hint: s.hint })) };
        if (adminPw()) body.adminPassword = adminPw();
        const r = await fetch('/api/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error || 'navigator error');
        palette.rec = data;
      } catch (e) { palette.rec = { error: String(e.message || e) }; }
      render();
    }
  }

  /* ── Voice (Web Speech API, client-side only) ──────────────────────────── */
  const voice = YH.voice = { rec: null, on: false,
    toggle() { voice.on ? voice.stop() : voice.start(); },
    start() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { YH.toast('Voice search is not supported in this browser'); return; }
      const rec = voice.rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
      const mic = $('#yh-pal-mic'); mic && mic.classList.add('listening'); voice.on = true;
      rec.onresult = e => { const t = Array.from(e.results).map(r => r[0].transcript).join(' '); const inp = $('#yh-pal-input'); if (inp) { inp.value = t; palette.sel = 0; render(); } if (e.results[e.results.length - 1].isFinal) { voice.stop(); const best = palette.items.find(i => i.kind === 'section'); if (best && score(t.toLowerCase(), best) >= 40) { palette.close(); jump(best.id); YH.toast(`→ ${best.title}`); } } };
      rec.onerror = () => voice.stop(); rec.onend = () => voice.stop();
      try { rec.start(); } catch { voice.stop(); }
    },
    stop() { try { voice.rec && voice.rec.stop(); } catch {} voice.on = false; const mic = $('#yh-pal-mic'); mic && mic.classList.remove('listening'); },
  };

  /* ══════════════════════════════════════════════════════════════════════
     RAIL + SCROLL-SPY + BREADCRUMB + MOBILE BAR
     ══════════════════════════════════════════════════════════════════════ */
  const RAIL = [ // curated: one dot per destination worth a glance
    ['about', '⚡', 'About'], ['fit-check', '🎯', 'Fit Check'], ['projects', '🚀', 'Projects'], ['governance', '🛡️', 'AI Governance'], null,
    ['aviation', '✈️', 'Aviation'], ['metar', '🌪️', 'METAR Stream'], ['climate', '🌡️', 'Climate'], ['datacenters', '🖥️', 'Data Centers'], ['apple-lab', '🍎', 'Apple Lab'], null,
    ['running', '🏃', 'Running'], ['heat-pace', '🌡️', 'Running Tools'], ['strava-feed', '📡', 'Live Strava'], null,
    ['certifications', '🏆', 'Certs'], ['buildlog', '📋', 'Build Log'], ['contact', '📬', 'Contact'],
  ];
  const rail = YH.rail = { el: null, active: null };
  function buildRail() {
    const el = document.createElement('div'); el.id = 'yh-rail'; el.setAttribute('role', 'navigation'); el.setAttribute('aria-label', 'Section quick-jump');
    el.innerHTML = RAIL.map(r => r ? `<a href="#${r[0]}" data-id="${r[0]}" data-label="${esc(r[2])}" aria-label="${esc(r[2])}">${r[1]}</a>` : '<div class="rail-sep"></div>').join('');
    el.addEventListener('click', e => { const a = e.target.closest('a'); if (!a) return; e.preventDefault(); jump(a.dataset.id); });
    document.body.appendChild(el); rail.el = el;
    const crumb = document.createElement('div'); crumb.id = 'yh-crumb'; crumb.innerHTML = '<span></span>';
    const nav = $('body > nav'); if (nav && nav.parentNode) nav.parentNode.insertBefore(crumb, nav.nextSibling);
  }
  function buildMobileBar() {
    const el = document.createElement('div'); el.id = 'yh-mobilebar'; el.setAttribute('role', 'navigation'); el.setAttribute('aria-label', 'Quick actions');
    el.innerHTML = `<button data-act="top"><span>🏠</span>Home</button><button data-act="palette"><span>🔎</span>Jump</button><button data-act="chat"><span>💬</span>AI Chat</button><button data-act="fit"><span>🎯</span>Fit</button><button data-act="theme"><span>🎨</span>Theme</button>`;
    el.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.act;
      if (a === 'top') window.scrollTo({ top: 0, behavior: 'smooth' }); else if (a === 'palette') palette.open(); else if (a === 'chat') { try { toggleChat(); } catch {} } else if (a === 'fit') { jump('fit-check'); } else if (a === 'theme') theme.toggle(e); });
    document.body.appendChild(el);
  }
  function spy() {
    const secs = $$('section[id]'); if (!secs.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) setActive(en.target.id); });
    }, { rootMargin: '-35% 0px -55% 0px', threshold: 0 });
    secs.forEach(s => io.observe(s));
    // show the rail only when there is free margin left of the content column
    let room = true;
    const measure = () => { const c = $('body > .container'); room = !!c && c.getBoundingClientRect().left >= 66; };
    const railToggle = () => rail.el && rail.el.classList.toggle('show', room && window.scrollY > 420);
    window.addEventListener('scroll', railToggle, { passive: true });
    window.addEventListener('resize', () => { measure(); railToggle(); });
    measure(); railToggle();
  }
  function setActive(id) {
    if (rail.active === id) return; rail.active = id;
    const it = INDEX.find(x => x.id === id);
    // nearest rail dot: the section itself, else the last rail entry that precedes it in DOM order
    let dot = id; if (!RAIL.some(r => r && r[0] === id)) { const order = $$('section[id]').map(s => s.id); const pos = order.indexOf(id); let best = null; RAIL.forEach(r => { if (r && order.indexOf(r[0]) !== -1 && order.indexOf(r[0]) <= pos) best = r[0]; }); dot = best; }
    $$('#yh-rail a').forEach(a => a.classList.toggle('active', a.dataset.id === dot));
    const c = $('#yh-crumb span'); if (c) { if (it && window.scrollY > 420) { c.innerHTML = `${esc(it.group)} <b>/ ${esc(it.emoji)} ${esc(it.title)}</b>`; c.classList.add('show'); } else c.classList.remove('show'); }
  }

  /* ══════════════════════════════════════════════════════════════════════
     SECTION TOOLS — "✨ Ask AI" / "🔗" on every h2
     ══════════════════════════════════════════════════════════════════════ */
  function injectSectionTools() {
    $$('section[id]').forEach(sec => {
      const h2 = $('h2, h1.hpc-title', sec); if (!h2 || $('.yh-sec-tools', h2)) return;
      const title = clean(headText(h2));
      const tools = document.createElement('span'); tools.className = 'yh-sec-tools';
      tools.innerHTML = `<button type="button" class="yh-sec-btn" data-ask="${esc(title)}" title="Ask the AI to explain this section">✨ <span class="lbl">Ask AI</span></button><button type="button" class="yh-sec-btn" data-link="${sec.id}" title="Copy link to this section">🔗</button>`;
      h2.appendChild(tools);
    });
    document.addEventListener('click', e => {
      const ask = e.target.closest('.yh-sec-btn[data-ask]');
      if (ask) { e.preventDefault(); YH.askAbout(ask.dataset.ask); return; }
      const link = e.target.closest('.yh-sec-btn[data-link]');
      if (link) { e.preventDefault(); const url = location.origin + location.pathname + '#' + link.dataset.link; navigator.clipboard?.writeText(url).then(() => YH.toast('Section link copied')); }
    });
  }
  YH.askAbout = function (title) {
    const prompt = `Explain the "${title}" section of yashhooda.ai: what does it show, how was it built, and what's the most interesting engineering decision behind it?`;
    try { if (typeof chatOpen === 'undefined' || !chatOpen) toggleChat(); } catch {}
    const input = $('#chat-input'); if (input) { input.value = prompt; input.focus(); }
    if (isLoggedIn()) { setTimeout(() => { try { sendMsg(); } catch {} }, 250); }
    else YH.toast('Log in to send — the question is ready in the chat box');
  };

  /* ══════════════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ══════════════════════════════════════════════════════════════════════ */
  const GO = { a: 'about', p: 'projects', f: 'fit-check', g: 'governance', r: 'running', b: 'buildlog', c: 'contact', m: 'metar', w: 'weather', s: 'strava-feed' };
  const keys = YH.keys = { el: null,
    show() {
      if (!keys.el) {
        const el = document.createElement('div'); el.id = 'yh-keys';
        el.innerHTML = `<div class="keys-box"><h4><span>⌨️ Keyboard shortcuts</span><button type="button" aria-label="Close">✕</button></h4><table>
          <tr><td><kbd>⌘</kbd><kbd>K</kbd> / <kbd>Ctrl</kbd><kbd>K</kbd> / <kbd>/</kbd></td><td>Open the jump palette</td></tr>
          <tr><td><kbd>?</kbd> + text in palette</td><td>Ask the AI navigator</td></tr>
          <tr><td><kbd>Tab</kbd> in palette</td><td>Toggle AI mode</td></tr>
          <tr><td><kbd>c</kbd></td><td>Open / close HoodaAgents chat</td></tr>
          <tr><td><kbd>t</kbd></td><td>Cycle themes</td></tr>
          <tr><td><kbd>g</kbd> then <kbd>a</kbd> <kbd>p</kbd> <kbd>f</kbd> <kbd>r</kbd> <kbd>b</kbd> <kbd>c</kbd> <kbd>m</kbd></td><td>Go to About · Projects · Fit Check · Running · Build Log · Contact · METAR</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close any overlay</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr></table></div>`;
        el.addEventListener('click', e => { if (e.target === el || e.target.closest('h4 button')) keys.hide(); });
        document.body.appendChild(el); keys.el = el;
      }
      keys.el.classList.add('open');
    },
    hide() { keys.el && keys.el.classList.remove('open'); },
  };
  let goArmed = 0;
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.isOpen() ? palette.close() : palette.open(); return; }
    if (e.key === 'Escape') { if (palette.isOpen()) palette.close(); keys.hide(); theme.close(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); palette.open(); return; }
    if (e.key === '?') { e.preventDefault(); keys.el && keys.el.classList.contains('open') ? keys.hide() : keys.show(); return; }
    if (e.key === 't') { theme.cycle(); return; }
    if (e.key === 'c') { try { toggleChat(); } catch {} return; }
    if (e.key === 'g') { goArmed = Date.now(); return; }
    if (goArmed && Date.now() - goArmed < 1200 && GO[e.key]) { goArmed = 0; jump(GO[e.key]); YH.toast(`→ ${GO[e.key]}`); return; }
    goArmed = 0;
  });

  /* ══════════════════════════════════════════════════════════════════════
     FIT CHECK
     ══════════════════════════════════════════════════════════════════════ */
  // Mirrors lib/profile.js SKILL_GROUPS / KNOWN_GAPS for the instant, offline scan.
  const SKILLS = [
    ['Python', ['python']], ['SQL', ['sql', 't-sql', 'postgres', 'mysql', 'snowflake', 'bigquery', 'redshift']], ['PySpark / Spark', ['pyspark', 'spark', 'structured streaming']],
    ['Databricks', ['databricks', 'delta lake', 'delta live', 'unity catalog']], ['Microsoft Fabric', ['fabric', 'synapse', 'power bi', 'azure data factory', 'adf']], ['Azure', ['azure', 'azure openai', 'document intelligence']],
    ['AWS', ['aws', 's3', 'glue', 'lambda', 'athena', 'emr', 'kinesis']], ['GCP', ['gcp', 'google cloud', 'dataflow', 'pub/sub']], ['Kafka / Streaming', ['kafka', 'redpanda', 'streaming', 'real-time', 'realtime', 'event-driven']],
    ['ETL / ELT', ['etl', 'elt', 'data pipeline', 'pipelines', 'ingestion', 'medallion', 'data warehouse', 'lakehouse']], ['Orchestration', ['airflow', 'dagster', 'prefect', 'github actions', 'orchestration', 'scheduling']], ['dbt', ['dbt']],
    ['Data Quality', ['data quality', 'great expectations', 'reconciliation', 'validation', 'observability']], ['LLM APIs', ['llm', 'openai', 'anthropic', 'claude', 'gpt', 'gemini', 'large language']],
    ['RAG', ['rag', 'retrieval', 'vector', 'embedding', 'embeddings', 'faiss', 'chroma', 'pinecone', 'weaviate', 'upstash']], ['Agents / MCP', ['agent', 'agentic', 'mcp', 'tool use', 'function calling', 'react']],
    ['LangChain', ['langchain', 'langgraph', 'llamaindex']], ['Fine-tuning', ['fine-tun', 'finetun', 'lora', 'qlora', 'peft', 'sft', 'pytorch', 'hugging face', 'huggingface', 'transformers']],
    ['ML / Stats', ['machine learning', 'scikit', 'sklearn', 'pandas', 'numpy', 'regression', 'statistics', 'statistical']], ['Evals', ['eval', 'evaluation', 'benchmark', 'golden']],
    ['Node.js / JS', ['node', 'javascript', 'typescript', 'react.js', 'next.js']], ['FastAPI / APIs', ['fastapi', 'rest', 'api design', 'microservice']], ['Docker / K8s', ['docker', 'kubernetes', 'k8s', 'container']],
    ['CI/CD', ['ci/cd', 'cicd', 'continuous integration', 'testing', 'pytest', 'unit test']], ['Serverless', ['serverless', 'vercel', 'cloud functions']], ['Redis', ['redis', 'caching']], ['Security', ['security', 'auth', 'rate limit', 'jwt', 'oauth']],
    ['Swift / iOS', ['swift', 'swiftui', 'ios', 'watchos', 'xcode']], ['Terraform / IaC', ['terraform', 'infrastructure as code', 'iac', 'cloudformation']], ['Scala / Java', ['scala', 'java ']], ['Go', [' go ', 'golang']], ['Tableau / BI', ['tableau', 'looker', 'business intelligence', 'dashboards']],
  ];
  const GAPS = new Set(['AWS', 'GCP', 'dbt', 'Terraform / IaC', 'Scala / Java', 'Go']);
  const PARTIAL = new Set(['Docker / K8s', 'Tableau / BI']);
  const SAMPLE_JD = `Senior Data Engineer — AI Platform (Remote, US)\n\nWe're building the data backbone for an LLM-powered analytics product. You'll own streaming and batch pipelines on Databricks (PySpark, Delta Lake, medallion architecture), stand up retrieval infrastructure for our RAG features (vector stores, embeddings, evaluation), and partner with ML engineers on agent tooling.\n\nRequirements\n• 3+ years building production data pipelines (Spark, Kafka or similar streaming)\n• Strong SQL and Python; experience with Databricks or a comparable lakehouse\n• Hands-on with LLM APIs (OpenAI/Anthropic), RAG, and evaluation harnesses\n• CI/CD, testing, and observability for data systems\n• Nice to have: Azure, dbt, Terraform, MCP/agent frameworks, Docker/Kubernetes`;
  const fit = YH.fit = {
    scan(text) {
      const t = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
      const hits = [], misses = [];
      SKILLS.forEach(([name, al]) => { if (al.some(a => t.includes(a))) (GAPS.has(name) ? misses : hits).push({ name, partial: PARTIAL.has(name) }); });
      return { hits, misses };
    },
    renderKeywords(k) {
      const el = $('#fc-keywords'); if (!el) return;
      if (!k.hits.length && !k.misses.length) { el.innerHTML = ''; return; }
      el.innerHTML = k.hits.map(h => `<span class="fc-kw hit" title="${h.partial ? 'partial evidence' : 'strong evidence on this site'}">✓ ${esc(h.name)}${h.partial ? ' ~' : ''}</span>`).join('') +
        k.misses.map(m => `<span class="fc-kw miss" title="no strong evidence — will be reported as a gap">✗ ${esc(m.name)}</span>`).join('') +
        `<span class="fc-kw">${k.hits.length}/${k.hits.length + k.misses.length} keyword coverage</span>`;
    },
    sample() { const ta = $('#fc-jd'); if (ta) { ta.value = SAMPLE_JD; ta.dispatchEvent(new Event('input')); ta.focus(); } },
    clear() { const ta = $('#fc-jd'); if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input')); } const o = $('#fc-out'); if (o) o.innerHTML = '<div class="fc-placeholder">🎯 Your fit report will appear here.</div>'; },
    async run() {
      const jd = ($('#fc-jd')?.value || '').trim(); const out = $('#fc-out'); const btn = $('#fc-run');
      if (jd.length < 80) { YH.toast('Paste a fuller job description (a few sentences at least)'); return; }
      if (!isLoggedIn()) { try { showAuthModal('login'); } catch {} YH.toast('Log in (free) to run the AI report — keyword scan is shown below'); return; }
      btn.disabled = true; const label = btn.textContent; btn.textContent = '⏳ Analyzing…';
      out.innerHTML = `<div class="fc-placeholder"><span class="pal-spin"></span><br><br>Reading the role, matching against shipped systems, checking for gaps…</div>`;
      try {
        const body = { jd }; if (adminPw()) body.adminPassword = adminPw();
        const r = await fetch('/api/fit-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
        fit.render(data);
      } catch (e) {
        out.innerHTML = `<div class="fc-placeholder">⚠️ ${esc(e.message || e)}<br><small>The free keyword scan still works without the AI report.</small></div>`;
      } finally { btn.disabled = false; btn.textContent = label; }
    },
    render(d) {
      const out = $('#fc-out'); if (!out) return;
      const who = [d.role_title, d.company].filter(Boolean).join(' @ ');
      out.innerHTML = `
        <div class="fc-score"><div class="fc-ring" style="--p:${Math.round(d.score)}"><b>${Math.round(d.score)}</b></div>
          <div class="fc-verdict">${esc(d.verdict)}${who ? ` — ${esc(who)}` : ''}<small>${esc(d.headline)}</small></div></div>
        <div class="fc-cols">
          <div class="fc-col strong"><h5>✓ Strengths (with proof)</h5><ul>${(d.strengths || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
          <div class="fc-col gap"><h5>◆ Honest gaps</h5><ul>${(d.gaps || []).map(s => `<li>${esc(s)}</li>`).join('') || '<li>None flagged</li>'}</ul></div>
        </div>
        <div class="fc-pitch"><span class="lbl">Tailored pitch (first person)</span>${esc(d.pitch)}</div>
        ${(d.questions || []).length ? `<div class="fc-col" style="margin-top:.8rem"><h5>❓ Questions I'd ask you</h5><ul>${d.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
        <div class="fc-foot">
          <button class="btn-secondary" type="button" onclick="YH.fit.copy()">📋 Copy report</button>
          <button class="btn-secondary" type="button" onclick="YH.askAbout('Fit Check result — discuss the gaps and how Yash would close them for this role')">💬 Discuss in chat</button>
          <a class="btn-primary" href="mailto:yash.hooda6@gmail.com?subject=${encodeURIComponent('Re: ' + (who || 'your Fit Check') + ' — let\'s talk')}">📬 Reach out</a>
        </div>
        <div class="fc-meta">${d.cached ? 'cached result · ' : ''}model ${esc(d.model || '')} · model score ${esc(d.model_score)} blended with keyword coverage</div>`;
      fit.last = d;
    },
    copy() {
      const d = fit.last; if (!d) return;
      const txt = `Fit Check — ${d.verdict} (${d.score}/100)\n${d.headline}\n\nStrengths:\n${(d.strengths || []).map(s => '• ' + s).join('\n')}\n\nGaps:\n${(d.gaps || []).map(s => '• ' + s).join('\n')}\n\nPitch:\n${d.pitch}\n\nQuestions:\n${(d.questions || []).map(s => '• ' + s).join('\n')}\n\n— generated on yashhooda.ai/#fit-check`;
      navigator.clipboard?.writeText(txt).then(() => YH.toast('Report copied'));
    },
  };
  function wireFit() {
    const ta = $('#fc-jd'); if (!ta) return;
    let t; ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => fit.renderKeywords(fit.scan(ta.value)), 160); });
  }

  /* ══════════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════════ */
  function boot() {
    INDEX = buildIndex();
    buildRail(); buildMobileBar(); spy(); injectSectionTools(); wireFit();
    // deep link on load: reveal + mark recent without scrolling twice
    if (location.hash && location.hash.length > 1) { const id = location.hash.slice(1); const el = document.getElementById(id); if (el) el.classList.add('visible'); }
    // one-time hint for first-time visitors
    if (!store.get('yh_shell_hint', false)) { setTimeout(() => { const touch = matchMedia('(pointer: coarse)').matches; YH.toast(touch ? 'Tip: tap 🔎 Jump to find anything · 🎨 for themes' : 'Tip: press ⌘K (or /) to jump anywhere · t to change theme', 4200); store.set('yh_shell_hint', true); }, 2500); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
