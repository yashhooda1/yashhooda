/* js/elections.js — US Elections 2016–2026 dashboard (#elections).
   Data: /data/elections/gold/{national,counties}.json, built by pipelines/elections/build.py.
   Map:  /data/elections/us-counties-albers-10m.json (us-atlas 3, pre-projected Albers USA).
   Libs: vendored d3 7.9 + topojson-client 3.1 (js/vendor), loaded only when the section
   scrolls near the viewport. Everything is self-hosted: no third-party calls at runtime.
   Margin = (D − R) / all votes, in points; positive = Democratic. */
(function () {
  'use strict';
  const root = document.getElementById('elections');
  if (!root) return;
  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => n == null ? '—' : Math.round(n).toLocaleString('en-US');
  const pct = (a, t) => t ? (a / t * 100) : null;
  const p1 = v => v == null ? '—' : v.toFixed(1) + '%';
  const mLabel = v => v == null ? '—' : Math.abs(v) < 0.05 ? 'Even' : (v > 0 ? 'D+' : 'R+') + Math.abs(v).toFixed(1);
  const sLabel = v => v == null ? '—' : Math.abs(v) < 0.05 ? 'No change' : (v > 0 ? '→ D ' : '→ R ') + Math.abs(v).toFixed(1);

  const YEARS = [2016, 2018, 2020, 2022, 2024, 2026];
  const RACE = { president: 'President', senate: 'US Senate', senate_special: 'US Senate (special)', governor: 'Governor', house: 'US House (all seats)' };
  const FACTORS = {
    hisp: ['Hispanic or Latino', '%'], white: ['White, non-Hispanic', '%'], black: ['Black', '%'], foreign: ['Foreign-born', '%'],
    lesscol: ['No 4-year college degree', '%'], inc: ['Median household income', '$'], rural: ['Rural population', '%'],
    age65: ['Age 65 and older', '%'], unemp: ['Unemployment rate', '%'],
  };
  const S = { year: 2024, view: 'margin', cmp: 'prev', geo: 'counties', state: null, county: null, factor: 'hisp', sort: { k: 'share', dir: -1 } };
  let G, C, topo, d3, topojson, path, counties, states, F2PO = {}, stateFeat = {}, ready = false;
  let svg, zoomG, cSel, sSel, hatchSel;

  // ── colour: diverging blue ↔ red, neutral gray midpoint; one set per scheme ──
  function palette() {
    const light = document.documentElement.getAttribute('data-scheme') === 'light';
    return light
      ? { mid: '#f0efec', D: ['#b7d3f6', '#3987e5', '#104281'], R: ['#f7c3c1', '#e34948', '#8c1d1f'], none: '#dcdbd6', poleD: '#2a78d6', poleR: '#e34948' }
      : { mid: '#383835', D: ['#23476f', '#2a6bc0', '#4a95f0'], R: ['#6b2f2e', '#a8393a', '#e8504f'], none: '#1f2126', poleD: '#3987e5', poleR: '#e66767' };
  }
  let P = palette(), scale;
  function makeScale() {
    const cap = S.view === 'swing' ? 25 : 60;
    scale = d3.scaleLinear().domain([-cap, -cap * 2 / 3, -cap / 3, 0, cap / 3, cap * 2 / 3, cap])
      .range([P.R[2], P.R[1], P.R[0], P.mid, P.D[0], P.D[1], P.D[2]]).interpolate(d3.interpolateLab).clamp(true);
    scale.cap = cap;
  }

  // ── data access ──
  const stRes = (po, y) => G.states[po] && G.states[po].results[String(y)];
  const margin = r => r && r.t ? (r.d - r.r) / r.t * 100 : null;
  function countyRec(f, y) {
    const sr = stRes(F2PO[f.slice(0, 2)], y);
    if (!sr) return null;
    if (sr.statewide_fill) return { d: sr.d, r: sr.r, t: sr.t, fill: true };
    const a = C.results[String(y)] && C.results[String(y)][f];
    return a ? { d: a[0], r: a[1], t: a[2] } : null;
  }
  function prevYear(y) {
    const i = YEARS.indexOf(y), j = S.cmp === 'type' ? i - 2 : i - 1;
    return j >= 0 ? YEARS[j] : null;
  }
  function value(rec, prevRec) {
    const m = margin(rec);
    if (S.view !== 'swing') return m;
    const pm = margin(prevRec);
    return m == null || pm == null ? null : m - pm;
  }
  const countyValue = (f, y = S.year) => value(countyRec(f, y), prevYear(y) && countyRec(f, prevYear(y)));
  const stateValue = (po, y = S.year) => value(stRes(po, y), prevYear(y) && stRes(po, prevYear(y)));
  const hasCountyData = (po, y) => { const sr = stRes(po, y); return !!sr && (sr.statewide_fill || sr.county_level !== false); };
  const countyName = f => C.names[f] || ((G.states[F2PO[f.slice(0, 2)]] || {}).name || 'County') + ' ' + f;

  // ── lazy boot ──
  function loadScript(src) {
    return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Failed to load ' + src)); document.head.appendChild(s); });
  }
  async function boot() {
    try {
      $('#el-status').textContent = 'Loading map and 18,000 county results…';
      const json = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
      const [g, c, t] = await Promise.all([
        json('/data/elections/gold/national.json'),
        json('/data/elections/gold/counties.json'),
        json('/data/elections/us-counties-albers-10m.json'),
        window.d3 ? null : loadScript('/js/vendor/d3-7.9.0.min.js'),
        window.topojson ? null : loadScript('/js/vendor/topojson-client-3.1.0.min.js'),
      ]);
      G = g; C = c; topo = t; d3 = window.d3; topojson = window.topojson;
      Object.entries(G.states).forEach(([po, s]) => { F2PO[s.fips] = po; });
      init();
    } catch (e) {
      $('#el-status').textContent = 'Could not load election data: ' + e.message;
    }
  }

  function init() {
    makeScale();
    path = d3.geoPath();
    counties = topojson.feature(topo, topo.objects.counties).features;
    states = topojson.feature(topo, topo.objects.states).features;
    states.forEach(s => { stateFeat[s.id] = s; });
    const sel = $('#el-state');
    sel.innerHTML = '<option value="">All states</option>' + Object.entries(G.states)
      .sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([po, s]) => `<option value="${po}">${esc(s.name)}</option>`).join('');
    $('#el-years').innerHTML = YEARS.map(y => {
      const e = G.elections.find(x => x.year === y);
      return `<button type="button" data-year="${y}" aria-pressed="${y === S.year}">${y}<small>${e.type === 'presidential' ? 'President' : 'Midterm'}</small></button>`;
    }).join('');
    buildMap();
    bind();
    ready = true;
    $('#el-status').remove();
    $('#el-body').hidden = false;
    renderSpotlight();
    render();
  }

  // ── map ──
  function buildMap() {
    svg = d3.select($('#el-map')).attr('viewBox', '0 0 975 610');
    const defs = svg.append('defs');
    defs.append('pattern').attr('id', 'el-hatch').attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6)
      .attr('patternTransform', 'rotate(45)').append('rect').attr('width', 2).attr('height', 6).attr('class', 'el-hatch-line');
    zoomG = svg.append('g');
    cSel = zoomG.append('g').attr('class', 'el-counties').selectAll('path').data(counties).join('path')
      .attr('d', path).attr('vector-effect', 'non-scaling-stroke')
      .on('mousemove', (e, f) => tip(e, countyTip(f.id))).on('mouseleave', hideTip)
      .on('click', (e, f) => { const po = F2PO[f.id.slice(0, 2)]; if (S.state !== po) selectState(po); selectCounty(f.id); });
    sSel = zoomG.append('g').attr('class', 'el-states').selectAll('path').data(states).join('path')
      .attr('d', path).attr('vector-effect', 'non-scaling-stroke').attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', s => (G.states[F2PO[s.id]] || {}).name || s.properties.name)
      .on('mousemove', (e, s) => tip(e, stateTip(F2PO[s.id]))).on('mouseleave', hideTip)
      .on('click', (e, s) => selectState(F2PO[s.id]))
      .on('keydown', (e, s) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectState(F2PO[s.id]); } });
    hatchSel = zoomG.append('g').attr('class', 'el-hatch').selectAll('path').data(states).join('path').attr('d', path);
    zoomG.append('path').datum(topojson.mesh(topo, topo.objects.states, (a, b) => a !== b)).attr('class', 'el-borders').attr('d', path).attr('vector-effect', 'non-scaling-stroke');
    zoomG.append('path').datum(topojson.mesh(topo, topo.objects.nation)).attr('class', 'el-nation').attr('d', path).attr('vector-effect', 'non-scaling-stroke');
  }

  function paintMap() {
    const y = S.year, countyMode = S.geo === 'counties' || S.state;
    cSel.attr('display', countyMode ? null : 'none')
      .attr('fill', f => { const v = countyValue(f.id); return v == null ? P.none : scale(v); })
      .classed('el-dim', f => S.state && F2PO[f.id.slice(0, 2)] !== S.state)
      .classed('el-sel', f => f.id === S.county);
    cSel.filter(f => f.id === S.county).raise();
    // States layer: filled in state mode, or where a state only has a statewide result for this year.
    sSel.attr('fill', s => {
      const po = F2PO[s.id], v = stateValue(po);
      if (!countyMode) return v == null ? P.none : scale(v);
      return !hasCountyData(po, y) && v != null ? scale(v) : 'transparent';
    }).classed('el-dim', s => S.state && F2PO[s.id] !== S.state)
      .attr('pointer-events', s => (!countyMode || (!hasCountyData(F2PO[s.id], y) && stRes(F2PO[s.id], y))) && !S.state ? 'all' : 'none')
      .classed('el-sel', s => F2PO[s.id] === S.state);
    hatchSel.attr('display', s => { const po = F2PO[s.id], sr = stRes(po, y); return sr && (sr.statewide_fill || !hasCountyData(po, y)) && (countyMode) ? null : 'none'; })
      .classed('el-dim', s => S.state && F2PO[s.id] !== S.state);
    // zoom
    let tr = 'translate(0,0) scale(1)';
    if (S.state && stateFeat[G.states[S.state].fips]) {
      const [[x0, y0], [x1, y1]] = path.bounds(stateFeat[G.states[S.state].fips]);
      const k = Math.min(8, 0.9 / Math.max((x1 - x0) / 975, (y1 - y0) / 610));
      tr = `translate(${975 / 2 - k * (x0 + x1) / 2},${610 / 2 - k * (y0 + y1) / 2}) scale(${k})`;
    }
    zoomG.transition().duration(matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650).attr('transform', tr);
  }

  function renderLegend() {
    const cap = scale.cap, stops = d3.range(0, 1.0001, 0.05).map(t => `${scale(-cap + t * 2 * cap)} ${t * 100}%`).join(',');
    const lab = S.view === 'swing' ? ['Shift to R', 'No change', 'Shift to D'] : ['Republican', 'Even', 'Democratic'];
    $('#el-legend').innerHTML = `
      <div class="el-leg-bar" style="background:linear-gradient(90deg,${stops})"></div>
      <div class="el-leg-ticks"><span>${S.view === 'swing' ? 'R' : 'R'}+${cap}${S.view === 'swing' ? ' pts' : ''}</span><span>${lab[0]}</span><span>${lab[1]}</span><span>${lab[2]}</span><span>D+${cap}${S.view === 'swing' ? ' pts' : ''}</span></div>
      <div class="el-leg-keys"><span><i style="background:${P.none}"></i>No data</span><span><i class="el-key-hatch"></i>Statewide result only</span></div>`;
  }

  // ── tooltip ──
  const tipEl = () => $('#el-tip');
  function tip(e, html) {
    const t = tipEl(); t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = e.clientX + 14, yy = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (yy + h > innerHeight - 8) yy = e.clientY - h - 14;
    t.style.left = x + 'px'; t.style.top = yy + 'px';
  }
  function hideTip() { tipEl().hidden = true; }
  function countyTip(f) {
    const po = F2PO[f.slice(0, 2)], sr = stRes(po, S.year), rec = countyRec(f, S.year), pv = prevYear(S.year);
    const sw = S.view === 'swing' && pv ? countyValue(f) : null;
    return `<div class="el-tip-h">${esc(countyName(f))}, ${po}</div><div class="el-tip-row muted">${S.year} · ${esc(RACE[sr && sr.race] || '')}${rec && rec.fill ? ' · statewide' : ''}</div>`
      + (rec ? `<div class="el-tip-row"><b>${mLabel(margin(rec))}</b> · D ${p1(pct(rec.d, rec.t))} · R ${p1(pct(rec.r, rec.t))}</div>
               <div class="el-tip-row muted">${fmt(rec.t)} votes${!rec.fill && sr ? ' · ' + p1(pct(rec.t, sr.t)) + ' of ' + po : ''}</div>`
             : `<div class="el-tip-row">${sr ? 'County results not loaded for this election' : 'No result'}</div>`)
      + (S.view === 'swing' && pv ? `<div class="el-tip-row">Swing vs ${pv}: <b>${sLabel(sw)}</b></div>` : '');
  }
  function stateTip(po) {
    const sr = stRes(po, S.year), pv = prevYear(S.year), s = G.states[po];
    return `<div class="el-tip-h">${esc(s.name)}</div><div class="el-tip-row muted">${S.year} · ${esc(RACE[sr && sr.race] || 'No statewide result loaded')}${sr && sr.status ? ' · ' + esc(sr.status) : ''}</div>`
      + (sr ? `<div class="el-tip-row"><b>${mLabel(margin(sr))}</b> · D ${p1(pct(sr.d, sr.t))} · R ${p1(pct(sr.r, sr.t))}</div><div class="el-tip-row muted">${fmt(sr.t)} votes</div>` : '')
      + (S.view === 'swing' && pv ? `<div class="el-tip-row">Swing vs ${pv}: <b>${sLabel(stateValue(po))}</b></div>` : '');
  }

  // ── selection & controls ──
  function selectState(po) { S.state = po || null; S.county = null; S.sort = { k: 'share', dir: -1 }; $('#el-state').value = S.state || ''; render(); }
  // Hand-off from the race-by-race panel (js/elections-races.js): which race each state's county map shows,
  // and "County map" jumps here with that year and state selected.
  window.YH_ELECTIONS = { stateRace: (po, y) => { const sr = G && stRes(po, y); return sr && hasCountyData(po, y) && !sr.statewide_fill ? sr.race : null; } };
  window.addEventListener('yh:elections-drill', e => {
    if (!ready) return;
    S.year = e.detail.year; S.view = 'margin'; makeScale(); selectState(e.detail.state);
    $('#el-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  function selectCounty(f) { S.county = S.county === f ? null : f; render(); }
  function bind() {
    $('#el-years').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.year = +b.dataset.year; render(); });
    root.addEventListener('click', e => {
      const v = e.target.closest('[data-view]'); if (v) { S.view = v.dataset.view; makeScale(); render(); }
      const c = e.target.closest('[data-cmp]'); if (c) { S.cmp = c.dataset.cmp; render(); }
      const g = e.target.closest('[data-geo]'); if (g) { S.geo = g.dataset.geo; render(); }
      const crumb = e.target.closest('[data-crumb]'); if (crumb) { if (crumb.dataset.crumb === 'us') selectState(null); else { S.county = null; render(); } }
      const th = e.target.closest('th[data-k]'); if (th) { const k = th.dataset.k; S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : (k === 'name' ? 1 : -1) }; renderTable(); }
      const tr = e.target.closest('tr[data-id]'); if (tr) { if (S.state) selectCounty(tr.dataset.id); else selectState(tr.dataset.id); }
    });
    root.addEventListener('keydown', e => { const tr = e.target.closest('tr[data-id]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tr.click(); } });
    $('#el-state').addEventListener('change', e => selectState(e.target.value));
    $('#el-factor').addEventListener('change', e => { S.factor = e.target.value; renderFactors(); });
    window.addEventListener('yh:themechange', () => { if (!ready) return; P = palette(); makeScale(); render(); renderSpotlight(); });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (ready) { renderTrend(); renderFactors(); renderSpotlight(); } }, 200); });
  }

  // ── render ──
  function render() {
    $$('#el-years button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.year === S.year)));
    $$('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
    $$('[data-cmp]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.cmp === S.cmp)); b.disabled = S.view !== 'swing'; });
    $$('[data-geo]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.geo === S.geo)); b.disabled = !!S.state; });
    renderCrumbs(); renderKPIs(); paintMap(); renderLegend(); renderNotes(); renderTable(); renderDetail(); renderTrend(); renderFactors();
  }

  function renderCrumbs() {
    const parts = [`<button type="button" data-crumb="us">United States</button>`];
    if (S.state) parts.push(S.county ? `<button type="button" data-crumb="state">${esc(G.states[S.state].name)}</button>` : `<span>${esc(G.states[S.state].name)}</span>`);
    if (S.county) parts.push(`<span>${esc(countyName(S.county))}</span>`);
    $('#el-crumbs').innerHTML = parts.join('<i aria-hidden="true">›</i>');
  }

  function scopeRec(y = S.year) {
    if (S.county) return { rec: countyRec(S.county, y), label: countyName(S.county) + ', ' + S.state };
    if (S.state) return { rec: stRes(S.state, y), label: G.states[S.state].name };
    const n = G.national[String(y)];
    return { rec: n && n.states >= 50 ? n : null, label: 'United States' };
  }

  function renderKPIs() {
    const y = S.year, { rec } = scopeRec(), pv = prevYear(y), prev = pv ? scopeRec(pv).rec : null;
    const sr = S.state ? stRes(S.state, y) : null;
    const nat = !S.state && !S.county, partialNat = nat && G.national[String(y)].states < 50;
    let won = '';
    if (S.state && !S.county && rec) {
      let d = 0, r = 0;
      counties.forEach(f => { if (F2PO[f.id.slice(0, 2)] !== S.state) return; const c = countyRec(f.id, y); if (c && !c.fill) { if (c.d > c.r) d++; else if (c.r > c.d) r++; } });
      won = d + r ? `<div class="el-kpi"><span class="el-kpi-v">${d} <small>D</small> · ${r} <small>R</small></span><span class="el-kpi-l">Counties won</span></div>` : '';
    }
    const turnout = rec && prev && prev.t ? (rec.t / prev.t - 1) * 100 : null;
    const race = nat ? (G.elections.find(e => e.year === y).type === 'presidential' ? 'President' : 'Sum of each state\'s race') : RACE[(sr || rec || {}).race] || '';
    $('#el-kpis').innerHTML = !rec || partialNat ? `<div class="el-kpi el-kpi-wide"><span class="el-kpi-v">${partialNat ? (G.national[String(y)].states === 1 ? 'Texas only so far' : G.national[String(y)].states + ' states so far') : 'No result'}</span><span class="el-kpi-l">${partialNat ? (G.national[String(y)].states === 1 ? '2026 statewide results are loaded for Texas; other states are added as they certify' : 'Unofficial statewide results are loaded for ' + G.national[String(y)].states + ' states — click a state for its race. The rest are added as results come in, and all are replaced as states certify') : 'Nothing loaded for this election'}</span></div>` : `
      <div class="el-kpi"><span class="el-kpi-v" style="color:${margin(rec) >= 0 ? P.poleD : P.poleR}">${mLabel(margin(rec))}</span><span class="el-kpi-l">${y} margin · ${esc(race)}</span></div>
      <div class="el-kpi"><span class="el-kpi-v">${p1(pct(rec.d, rec.t))}</span><span class="el-kpi-l">Democratic${sr && sr.dem_candidate ? ' · ' + esc(sr.dem_candidate) : ''}</span></div>
      <div class="el-kpi"><span class="el-kpi-v">${p1(pct(rec.r, rec.t))}</span><span class="el-kpi-l">Republican${sr && sr.rep_candidate ? ' · ' + esc(sr.rep_candidate) : ''}</span></div>
      <div class="el-kpi"><span class="el-kpi-v">${fmt(rec.t)}</span><span class="el-kpi-l">Votes${turnout != null ? ` · ${turnout >= 0 ? '+' : ''}${turnout.toFixed(1)}% vs ${pv}` : ''}</span></div>
      ${prev && margin(prev) != null ? `<div class="el-kpi"><span class="el-kpi-v">${sLabel(margin(rec) - margin(prev))}</span><span class="el-kpi-l">Swing vs ${pv}</span></div>` : ''}
      ${won}`;
  }

  function renderNotes() {
    const y = S.year, notes = [];
    const e = G.elections.find(x => x.year === y);
    if (e.type === 'midterm') notes.push(G.race_rule);
    if (S.view === 'swing') notes.push(prevYear(y) ? `Swing = change in margin since ${prevYear(y)}${S.cmp === 'prev' && e.type !== G.elections.find(x => x.year === prevYear(y)).type ? ' (a different kind of race, so read it as a temperature check, not like-for-like)' : ''}.` : 'No earlier election in this dataset to compare against.');
    const sr = S.state && stRes(S.state, y);
    if (sr && sr.status) notes.push(`${G.states[S.state].name} ${y}: ${sr.status}, as of ${sr.as_of}. <a href="${esc(sr.source)}" target="_blank" rel="noopener">Source</a>.`);
    if (sr && sr.override_note) notes.push(esc(sr.override_note) + '.');
    if (sr && sr.statewide_fill) notes.push(`${G.states[S.state].name} doesn't report this election by county, so the map shows the statewide result.`);
    if (sr && sr.county_level === false) notes.push('County results for this election aren\'t loaded yet; the hatched fill is the statewide result.');
    if (y === 2026 && !S.state) notes.push('2026 is unofficial. Texas is loaded statewide; county files are added as states certify.');
    $('#el-notes').innerHTML = notes.map(n => `<p>${n}</p>`).join('');
  }

  // ── table (the map's accessible twin) ──
  function renderTable() {
    const y = S.year, pv = prevYear(y), rows = [];
    if (S.state) {
      const sr = stRes(S.state, y);
      counties.forEach(f => {
        if (F2PO[f.id.slice(0, 2)] !== S.state) return;
        const c = countyRec(f.id, y);
        if (!c || c.fill) return;
        rows.push({ id: f.id, name: countyName(f.id), d: pct(c.d, c.t), r: pct(c.r, c.t), m: margin(c), t: c.t, share: sr ? pct(c.t, sr.t) : null,
          sw: pv ? (() => { const p = countyRec(f.id, pv); return p && !p.fill ? margin(c) - margin(p) : null; })() : null });
      });
    } else {
      Object.entries(G.states).forEach(([po, s]) => {
        const c = stRes(po, y); if (!c) return;
        const p = pv && stRes(po, pv), nt = G.national[String(y)].t;
        rows.push({ id: po, name: s.name, race: RACE[c.race], d: pct(c.d, c.t), r: pct(c.r, c.t), m: margin(c), t: c.t, share: pct(c.t, nt), sw: p ? margin(c) - margin(p) : null });
      });
    }
    const { k, dir } = S.sort;
    rows.sort((a, b) => k === 'name' ? dir * a.name.localeCompare(b.name) : dir * ((a[k] == null ? -1e9 : a[k]) - (b[k] == null ? -1e9 : b[k])));
    const cols = [['name', S.state ? 'County' : 'State'], ['d', 'D %'], ['r', 'R %'], ['m', 'Margin'], ['t', 'Votes'], ['share', S.state ? '% of state' : '% of total'], ['sw', pv ? 'Swing ' + pv : 'Swing']];
    $('#el-table-title').textContent = rows.length ? `${S.state ? G.states[S.state].name + ' counties' : 'States'} · ${y} (${rows.length})` : 'No county results for this election';
    $('#el-table').innerHTML = `<thead><tr>${cols.map(([c, l]) => `<th data-k="${c}" scope="col" aria-sort="${k === c ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${k === c ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>`
      + rows.map(r => `<tr data-id="${r.id}" tabindex="0"${r.id === S.county ? ' class="el-row-sel"' : ''}><th scope="row">${esc(r.name)}${r.race && r.race !== 'President' ? `<small>${esc(r.race)}</small>` : ''}</th><td>${p1(r.d)}</td><td>${p1(r.r)}</td>
          <td><span class="el-chip" style="--c:${r.m >= 0 ? P.poleD : P.poleR}">${mLabel(r.m)}</span></td><td>${fmt(r.t)}</td><td>${p1(r.share)}</td><td>${r.sw == null ? '—' : sLabel(r.sw).replace('→ ', '').replace('No change', '0')}</td></tr>`).join('') + '</tbody>';
  }

  // ── detail: one county or state across all six elections ──
  function renderDetail() {
    const box = $('#el-detail');
    if (!S.state) { box.hidden = true; return; }
    box.hidden = false;
    const f = S.county, demo = f && C.demographics[f];
    const rows = YEARS.map(y => {
      const rec = f ? countyRec(f, y) : stRes(S.state, y), sr = stRes(S.state, y);
      const m = margin(rec), w = m == null ? 0 : Math.min(Math.abs(m), 60) / 60 * 50;
      return `<tr><th scope="row">${y}<small>${esc(RACE[sr && sr.race] || '—')}</small></th><td>${rec ? p1(pct(rec.d, rec.t)) : '—'}</td><td>${rec ? p1(pct(rec.r, rec.t)) : '—'}</td>
        <td class="el-mbar"><span aria-hidden="true"><i style="${m >= 0 ? 'left:50%' : 'right:50%'};width:${w}%;background:${m >= 0 ? P.poleD : P.poleR}"></i></span>${mLabel(m)}${rec && rec.fill ? ' <small>statewide</small>' : ''}</td>
        <td>${rec ? fmt(rec.t) : '—'}</td>${f ? `<td>${rec && !rec.fill && sr ? p1(pct(rec.t, sr.t)) : '—'}</td>` : ''}</tr>`;
    }).join('');
    box.innerHTML = `<h3>${esc(f ? countyName(f) + ', ' + S.state : G.states[S.state].name)} · every election</h3>
      <div class="el-dwrap"><table class="el-dtable"><thead><tr><th scope="col">Election</th><th scope="col">D %</th><th scope="col">R %</th><th scope="col">Margin</th><th scope="col">Votes</th>${f ? '<th scope="col">% of state</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
      ${demo ? `<div class="el-demo">${Object.entries(FACTORS).filter(([k]) => demo[k] != null).map(([k, [l, u]]) => `<span><b>${u === '$' ? '$' + fmt(demo[k]) : demo[k].toFixed(1) + '%'}</b>${esc(l)}</span>`).join('')}<em>ACS 2012–2016 estimates · population ${fmt(demo.pop)}</em></div>` : ''}`;
  }

  // ── trend: margin over six elections for the current scope (one series) ──
  function trendSeries(scopeFn) { return YEARS.map(y => { const rec = scopeFn(y); return { y, m: margin(rec), mid: G.elections.find(e => e.year === y).type === 'midterm', race: rec && rec.race }; }); }
  function drawTrend(el, series, opts = {}) {
    const W = Math.max(280, el.clientWidth || 520), H = opts.h || 190, pad = { l: 46, r: 18, t: 16, b: 28 };
    const pts = series.filter(s => s.m != null);
    if (!pts.length) { el.innerHTML = '<p class="el-empty">No results to chart.</p>'; return; }
    const max = Math.max(10, Math.ceil(d3.max(pts, s => Math.abs(s.m)) / 10) * 10);
    const x = d3.scalePoint().domain(YEARS).range([pad.l, W - pad.r]).padding(0.3), yS = d3.scaleLinear().domain([-max, max]).range([H - pad.b, pad.t]);
    const ticks = [-max, -max / 2, 0, max / 2, max];
    const line = d3.line().x(s => x(s.y)).y(s => yS(s.m)).defined(s => s.m != null);
    const ext = pts.reduce((a, b) => Math.abs(b.m) > Math.abs(a.m) ? b : a), last = pts[pts.length - 1];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opts.label || 'Margin by election')}">
      ${ticks.map(t => `<line class="el-grid${t === 0 ? ' el-zero' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${yS(t)}" y2="${yS(t)}"/><text class="el-axis" x="${pad.l - 6}" y="${yS(t) + 3.5}" text-anchor="end">${mLabel(t).replace('.0', '')}</text>`).join('')}
      ${YEARS.map(y => `<text class="el-axis" x="${x(y)}" y="${H - 8}" text-anchor="middle">${y}</text>`).join('')}
      <path class="el-tline" d="${line(series)}"/>
      ${pts.map(s => `<circle class="el-tpt" cx="${x(s.y)}" cy="${yS(s.m)}" r="4.5" fill="${s.mid ? 'var(--bg-card, #111)' : (s.m >= 0 ? P.poleD : P.poleR)}" stroke="${s.m >= 0 ? P.poleD : P.poleR}" stroke-width="2"/>`).join('')}
      ${[...new Set([ext, last])].map(s => `<text class="el-tlabel" x="${x(s.y)}" y="${yS(s.m) + (s.m >= 0 ? -10 : 18)}" text-anchor="middle">${mLabel(s.m)}</text>`).join('')}
      ${pts.map(s => `<circle class="el-hit" data-y="${s.y}" cx="${x(s.y)}" cy="${yS(s.m)}" r="14"><title>${s.y} ${RACE[s.race] || ''}: ${mLabel(s.m)}</title></circle>`).join('')}
    </svg>`;
    el.querySelectorAll('.el-hit').forEach(c => {
      const s = series.find(z => z.y === +c.dataset.y);
      c.addEventListener('mousemove', e => tip(e, `<div class="el-tip-h">${s.y} · ${esc(RACE[s.race] || '')}</div><div class="el-tip-row"><b>${mLabel(s.m)}</b></div>`));
      c.addEventListener('mouseleave', hideTip);
    });
  }
  function renderTrend() {
    if (!ready) return;
    const { label } = scopeRec();
    $('#el-trend-title').textContent = `${label}: margin, 2016–2026`;
    drawTrend($('#el-trend'), trendSeries(y => { const r = scopeRec(y).rec; if (r && !r.race) r.race = G.elections.find(e => e.year === y).type === 'presidential' ? 'president' : null; return r; }), { label: label + ' margin by election' });
  }

  // ── factors: county margin or swing vs a demographic (association only) ──
  function renderFactors() {
    if (!ready) return;
    const el = $('#el-scatter'), y = S.year, fk = S.factor, [flabel, unit] = FACTORS[fk];
    const useSwing = S.view === 'swing' && prevYear(y);
    const pts = [];
    for (const f of counties) {
      const po = F2PO[f.id.slice(0, 2)];
      if (S.state && po !== S.state) continue;
      const rec = countyRec(f.id, y), demo = C.demographics[f.id];
      if (!rec || rec.fill || !demo || demo[fk] == null) continue;
      const v = useSwing ? (() => { const p = countyRec(f.id, prevYear(y)); return p && !p.fill ? margin(rec) - margin(p) : null; })() : margin(rec);
      if (v != null) pts.push({ id: f.id, x: demo[fk], y: v, t: rec.t });
    }
    const what = useSwing ? `swing ${prevYear(y)}→${y}` : `${y} margin`;
    $('#el-factor-title').textContent = `${flabel} vs ${what}${S.state ? ' · ' + G.states[S.state].name : ' · all counties'}`;
    if (pts.length < 8) { el.innerHTML = `<p class="el-empty">Not enough county results for ${y}${S.state ? ' in ' + G.states[S.state].name : ''} to compare.</p>`; $('#el-factor-stat').textContent = ''; return; }
    const W = Math.max(280, el.clientWidth || 520), H = 280, pad = { l: 50, r: 14, t: 12, b: 34 };
    const xS = d3.scaleLinear().domain(d3.extent(pts, p => p.x)).nice().range([pad.l, W - pad.r]);
    const ymax = Math.max(10, Math.ceil(d3.max(pts, p => Math.abs(p.y)) / 10) * 10);
    const yS = d3.scaleLinear().domain([-ymax, ymax]).range([H - pad.b, pad.t]);
    const n = pts.length, mx = d3.mean(pts, p => p.x), my = d3.mean(pts, p => p.y);
    let sxy = 0, sxx = 0, syy = 0; pts.forEach(p => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; });
    const b = sxy / sxx, a = my - b * mx, r = sxy / Math.sqrt(sxx * syy);
    const [x0, x1] = xS.domain(), xt = xS.ticks(5), yt = [-ymax, -ymax / 2, 0, ymax / 2, ymax];
    const fx = v => unit === '$' ? '$' + d3.format('~s')(v) : v + '%';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc($('#el-factor-title').textContent)}">
      ${yt.map(t => `<line class="el-grid${t === 0 ? ' el-zero' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${yS(t)}" y2="${yS(t)}"/><text class="el-axis" x="${pad.l - 6}" y="${yS(t) + 3.5}" text-anchor="end">${(useSwing ? sLabel(t).replace('No change', '0').replace('→ ', '') : mLabel(t)).replace('.0', '')}</text>`).join('')}
      ${xt.map(t => `<text class="el-axis" x="${xS(t)}" y="${H - 14}" text-anchor="middle">${fx(t)}</text>`).join('')}
      <text class="el-axis" x="${(pad.l + W - pad.r) / 2}" y="${H - 1}" text-anchor="middle">${esc(flabel)}</text>
      <g class="el-dots">${pts.map(p => `<circle cx="${xS(p.x).toFixed(1)}" cy="${yS(p.y).toFixed(1)}" r="${n > 600 ? 2.2 : 3.5}" fill="${p.y >= 0 ? P.poleD : P.poleR}"${p.id === S.county ? ' class="el-dot-sel"' : ''}/>`).join('')}</g>
      <line class="el-fit" x1="${xS(x0)}" x2="${xS(x1)}" y1="${yS(a + b * x0)}" y2="${yS(a + b * x1)}"/>
      <rect class="el-scatter-hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent"/>
    </svg>`;
    const dl = d3.Delaunay.from(pts, p => xS(p.x), p => yS(p.y)), hit = el.querySelector('.el-scatter-hit'), svgEl = el.querySelector('svg');
    hit.addEventListener('mousemove', e => {
      const pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const lp = pt.matrixTransform(svgEl.getScreenCTM().inverse()), p = pts[dl.find(lp.x, lp.y)];
      if (!p || Math.hypot(xS(p.x) - lp.x, yS(p.y) - lp.y) > 24) { hideTip(); return; }
      tip(e, `<div class="el-tip-h">${esc(countyName(p.id))}, ${F2PO[p.id.slice(0, 2)]}</div><div class="el-tip-row">${esc(flabel)}: <b>${unit === '$' ? '$' + fmt(p.x) : p.x.toFixed(1) + '%'}</b></div><div class="el-tip-row">${useSwing ? 'Swing' : 'Margin'}: <b>${useSwing ? sLabel(p.y) : mLabel(p.y)}</b> · ${fmt(p.t)} votes</div>`);
    });
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('click', e => {
      const pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const lp = pt.matrixTransform(svgEl.getScreenCTM().inverse()), p = pts[dl.find(lp.x, lp.y)];
      if (p && Math.hypot(xS(p.x) - lp.x, yS(p.y) - lp.y) <= 24) { const po = F2PO[p.id.slice(0, 2)]; if (S.state !== po) selectState(po); selectCounty(p.id); }
    });
    const strength = Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.4 ? 'moderate' : Math.abs(r) >= 0.2 ? 'weak' : 'little or no';
    $('#el-factor-stat').innerHTML = `r = <b>${r.toFixed(2)}</b> across ${fmt(n)} counties: a ${strength} ${r >= 0 ? 'positive' : 'negative'} association${useSwing ? ` (counties with more ${esc(flabel.toLowerCase())} ${r >= 0 ? 'moved toward Democrats' : 'moved toward Republicans'})` : ''}. Unweighted, so a 500-vote county counts as much as Harris County. Association, not cause.`;
  }

  // ── Texas spotlight: 2016 → 2026 ──
  function renderSpotlight() {
    if (!ready) return;
    renderHouston();
    const tx = G.states.TX, r26 = tx.results['2026'];
    const series = trendSeries(y => tx.results[String(y)]);
    drawTrend($('#el-tx-trend'), series, { h: 170, label: 'Texas statewide margin by election, 2016 to 2026' });
    const hero = $('#el-tx-hero');
    if (r26) {
      const others = (r26.other_races || []).map(o => `<div class="el-hero-sub"><b style="color:${o.d >= o.r ? P.poleD : P.poleR}">${mLabel((o.d - o.r) / o.t * 100)}</b> ${esc(RACE[o.race])}: ${esc(o.dem_candidate)} ${fmt(o.d)} vs ${esc(o.rep_candidate)} ${fmt(o.r)}${o.t === o.d + o.r ? ' <small>(two-party)</small>' : ''}</div>`).join('');
      const prev = tx.results['2024'];
      hero.innerHTML = `<div class="el-hero-k">Texas 2026 · ${esc(RACE[r26.race])}</div>
        <div class="el-hero-v" style="color:${P.poleD}">${mLabel(margin(r26))}</div>
        <div class="el-hero-sub">${esc(r26.dem_candidate)} ${p1(pct(r26.d, r26.t))} · ${esc(r26.rep_candidate)} ${p1(pct(r26.r, r26.t))} · ${fmt(r26.t)} votes</div>
        ${others}
        <div class="el-hero-sub">A <b>${Math.abs(margin(r26) - margin(prev)).toFixed(1)}-point</b> swing from Trump's ${mLabel(margin(prev))} in 2024.</div>
        <div class="el-hero-foot">${esc(r26.status)} · as of ${esc(r26.as_of)} · <a href="${esc(r26.source)}" target="_blank" rel="noopener">source</a></div>`;
    }
    // small multiples: Texas counties each election
    const txc = counties.filter(f => f.id.startsWith('48')), [[x0, y0], [x1, y1]] = path.bounds(stateFeat['48']);
    const vb = `${x0 - 2} ${y0 - 2} ${x1 - x0 + 4} ${y1 - y0 + 4}`, mScale = d3.scaleLinear().domain([-60, -40, -20, 0, 20, 40, 60])
      .range([P.R[2], P.R[1], P.R[0], P.mid, P.D[0], P.D[1], P.D[2]]).interpolate(d3.interpolateLab).clamp(true);
    $('#el-tx-multiples').innerHTML = YEARS.map(y => {
      const sr = tx.results[String(y)], countyLevel = sr && sr.county_level !== false;
      const body = countyLevel
        ? txc.map(f => { const c = countyRec(f.id, y); return `<path d="${path(f)}" fill="${c ? mScale(margin(c)) : P.none}"/>`; }).join('')
        : `<path d="${path(stateFeat['48'])}" fill="${sr ? mScale(margin(sr)) : P.none}"/><path d="${path(stateFeat['48'])}" fill="url(#el-hatch-sm)"/>`;
      return `<figure><svg viewBox="${vb}" role="img" aria-label="Texas ${y}${countyLevel ? ' by county' : ' statewide'}: ${sr ? mLabel(margin(sr)) : 'no data'}">
        <defs><pattern id="el-hatch-sm" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="1.6" height="5" class="el-hatch-line"/></pattern></defs>${body}</svg>
        <figcaption><b>${y}</b> ${esc(RACE[sr && sr.race] || '')} <span style="color:${sr && margin(sr) >= 0 ? P.poleD : P.poleR}">${sr ? mLabel(margin(sr)) : '—'}</span>${countyLevel ? '' : '<small>statewide · counties pending</small>'}</figcaption></figure>`;
    }).join('');
    // biggest county shifts: latest pair of elections that both have Texas county data
    const withCounties = YEARS.filter(y => tx.results[String(y)] && tx.results[String(y)].county_level !== false);
    const b = withCounties[withCounties.length - 1], a = withCounties.includes(b - 4) ? b - 4 : withCounties[withCounties.length - 2];
    const sh = txc.map(f => { const p = countyRec(f.id, a), c = countyRec(f.id, b); return p && c ? { id: f.id, s: margin(c) - margin(p), t: c.t } : null; }).filter(Boolean).filter(x => x.t >= 20000);
    sh.sort((p, q) => q.s - p.s);
    const li = x => `<li><button type="button" data-tx="${x.id}">${esc(countyName(x.id))}</button><span>${sLabel(x.s)}</span><small>${fmt(x.t)} votes</small></li>`;
    $('#el-tx-shifts').innerHTML = `<h4>Biggest county shifts, ${a} → ${b} <small>(counties with 20,000+ votes)</small></h4>
      <div class="el-shift-cols"><div><h5 style="color:${P.poleD}">Toward Democrats</h5><ol>${sh.slice(0, 5).filter(x => x.s > 0).map(li).join('') || '<li>None</li>'}</ol></div>
      <div><h5 style="color:${P.poleR}">Toward Republicans</h5><ol>${sh.slice(-5).reverse().filter(x => x.s < 0).map(li).join('') || '<li>None</li>'}</ol></div></div>`;
    $$('[data-tx]').forEach(btn => btn.onclick = () => { S.year = b; S.view = 'swing'; S.cmp = YEARS.indexOf(b) - YEARS.indexOf(a) === 2 ? 'type' : 'prev'; makeScale(); selectState('TX'); selectCounty(btn.dataset.tx); $('#el-map').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  }

  // ── Greater Houston spotlight: five counties, 2016 → 2026 ──
  const HOU = [['48201', 'Harris'], ['48157', 'Fort Bend'], ['48339', 'Montgomery'], ['48039', 'Brazoria'], ['48167', 'Galveston']];
  const TX_CANDS = { 2016: ['Clinton', 'Trump'], 2018: ["O'Rourke", 'Cruz'], 2020: ['Biden', 'Trump'], 2022: ["O'Rourke", 'Abbott'], 2024: ['Harris', 'Trump'] };
  const H = { year: null, scope: 'region' };
  const houRace = y => { const sr = G.states.TX.results[String(y)]; return sr && sr.race; };
  function houRec(scope, y) {
    const ids = scope === 'region' ? HOU.map(h => h[0]) : [scope];
    let d = 0, r = 0, t = 0;
    for (const f of ids) {
      const c = countyRec(f, y);
      if (!c || c.fill) return null;  // region needs all five counties
      d += c.d; r += c.r; t += c.t;
    }
    return { d, r, t, race: houRace(y) };
  }
  const houName = s => s === 'region' ? 'Houston area' : HOU.find(h => h[0] === s)[1] + ' County';
  function houShift(scope, y, back) {  // back = 1: previous election; 2: previous election of the same type
    const i = YEARS.indexOf(y), py = YEARS[i - back];
    const c = houRec(scope, y), p = py && houRec(scope, py);
    return c && p ? margin(c) - margin(p) : null;
  }
  function houCands(y) {
    const sr = G.states.TX.results[String(y)];
    return sr && sr.dem_candidate ? [sr.dem_candidate.split(' ').pop(), sr.rep_candidate.split(' ').pop()] : TX_CANDS[y] || ['Democrat', 'Republican'];
  }

  function renderHouston() {
    const yrs = YEARS.filter(y => houRec('region', y));
    if (!yrs.length) { $('#el-hou').hidden = true; return; }
    if (!yrs.includes(H.year)) H.year = yrs[yrs.length - 1];
    const tx = G.states.TX, mScale = d3.scaleLinear().domain([-60, -40, -20, 0, 20, 40, 60])
      .range([P.R[2], P.R[1], P.R[0], P.mid, P.D[0], P.D[1], P.D[2]]).interpolate(d3.interpolateLab).clamp(true);
    const col = m => m == null ? P.none : m >= 0 ? P.poleD : P.poleR;

    // hero: the whole region for the chosen year
    const y = H.year, rg = houRec('region', y), sr = tx.results[String(y)], [dn, rn] = houCands(y);
    const s1 = houShift('region', y, 1), s2 = houShift('region', y, 2), won = HOU.filter(([f]) => { const c = houRec(f, y); return c && c.d > c.r; }).length;
    const vsState = margin(rg) - margin(sr);
    $('#el-hou-hero').innerHTML = `<div class="el-hero-k">Houston area ${y} · ${esc(RACE[rg.race] || '')}</div>
      <div class="el-hero-v" style="color:${col(margin(rg))}">${mLabel(margin(rg))}</div>
      <div class="el-hero-sub">${esc(dn)} (D) <b>${p1(pct(rg.d, rg.t))}</b> · ${esc(rn)} (R) <b>${p1(pct(rg.r, rg.t))}</b> · ${fmt(rg.t)} votes</div>
      <div class="el-hero-sub">${s1 == null ? '' : `<b>${sLabel(s1)}</b> vs ${YEARS[YEARS.indexOf(y) - 1]}`}${s1 != null && s2 != null ? ' · ' : ''}${s2 == null ? '' : `<b>${sLabel(s2)}</b> vs ${YEARS[YEARS.indexOf(y) - 2]} <small>(same type)</small>`}</div>
      <div class="el-hero-sub">${esc(dn)} carried ${won} of 5 counties · the region ran <b>${Math.abs(vsState).toFixed(1)} pts ${vsState >= 0 ? 'more Democratic' : 'more Republican'}</b> than Texas (${mLabel(margin(sr))})</div>
      <div class="el-hero-foot">${y === 2026 ? `County returns ${esc(sr.status || 'unofficial')} · as of Nov 10 · <a href="https://abcnews.com/Elections/texas-county-senate-election-results-2026" target="_blank" rel="noopener">source</a>` : 'Certified county returns'}</div>`;

    // year buttons + map of the five counties (neighbouring Texas counties drawn for context)
    $('#el-hou-years').innerHTML = yrs.map(v => `<button type="button" data-houy="${v}" aria-pressed="${v === y}">${v}</button>`).join('');
    const five = counties.filter(f => HOU.some(h => h[0] === f.id)), [[x0, y0], [x1, y1]] = path.bounds({ type: 'FeatureCollection', features: five });
    const pad = (x1 - x0) * .06, w = x1 - x0 + pad * 2, fs = w / 24;
    const ctx = counties.filter(f => f.id.startsWith('48') && !five.includes(f));
    $('#el-hou-map').innerHTML = `<svg viewBox="${x0 - pad} ${y0 - pad} ${w} ${y1 - y0 + pad * 2}" role="img" aria-label="Houston-area counties, ${y} margins">
      <g class="el-hou-ctx">${ctx.map(f => `<path d="${path(f)}"/>`).join('')}</g>
      ${five.map(f => { const c = houRec(f.id, y); return `<path class="el-hou-c${H.scope === f.id ? ' el-sel' : ''}" data-houc="${f.id}" d="${path(f)}" fill="${c ? mScale(margin(c)) : P.none}" tabindex="0" role="button" aria-label="${esc(houName(f.id))}: ${c ? mLabel(margin(c)) : 'no data'}"/>`; }).join('')}
      ${five.map(f => { const [cx, cy] = path.centroid(f), c = houRec(f.id, y); return `<text x="${cx}" y="${cy}" font-size="${fs}" text-anchor="middle" class="el-hou-lbl">${esc(HOU.find(h => h[0] === f.id)[1])}<tspan x="${cx}" dy="${fs * 1.15}" font-weight="700">${c ? mLabel(margin(c)) : '—'}</tspan></text>`; }).join('')}
    </svg>`;

    // scope pills
    $('#el-hou-scope').innerHTML = [['region', 'Houston area (5 counties)'], ...HOU].map(([k, l]) => `<button type="button" data-hous="${k}" aria-pressed="${H.scope === k}">${esc(l)}</button>`).join('');

    // trend + drill-down table for the chosen scope
    $('#el-hou-trend-title').textContent = `${houName(H.scope)}: margin, every election`;
    drawTrend($('#el-hou-trend'), trendSeries(v => houRec(H.scope, v)), { h: 190, label: houName(H.scope) + ' margin by election, 2016 to 2026' });
    const reg = H.scope !== 'region';
    $('#el-hou-table').innerHTML = `<table class="el-dtable el-hou-dt"><thead><tr><th scope="col">Election</th><th scope="col">D %</th><th scope="col">R %</th><th scope="col">Margin</th><th scope="col">Shift vs last</th><th scope="col">Shift vs same type</th><th scope="col">Votes</th>${reg ? '<th scope="col">% of area</th>' : ''}</tr></thead><tbody>${
      YEARS.map(v => {
        const c = houRec(H.scope, v), a = houRec('region', v), [d_, r_] = houCands(v), sa = houShift(H.scope, v, 1), sb = houShift(H.scope, v, 2);
        const sh = s => s == null ? '—' : `<span style="color:${Math.abs(s) < .05 ? 'inherit' : col(s)}">${sLabel(s)}</span>`;
        return `<tr${v === y ? ' class="el-hou-cur"' : ''}><th scope="row">${v}<small>${esc(RACE[houRace(v)] || '—')} · ${esc(d_)} v ${esc(r_)}</small></th>
          <td>${c ? p1(pct(c.d, c.t)) : '—'}</td><td>${c ? p1(pct(c.r, c.t)) : '—'}</td>
          <td style="color:${col(c && margin(c))};font-weight:700">${c ? mLabel(margin(c)) : '—'}</td><td>${sh(sa)}</td><td>${sh(sb)}</td>
          <td>${c ? fmt(c.t) : '—'}</td>${reg ? `<td>${c && a ? p1(pct(c.t, a.t)) : '—'}</td>` : ''}</tr>`;
      }).join('')}</tbody></table>`;

    // county × election grid
    $('#el-hou-grid').innerHTML = `<table class="el-dtable el-hou-grid"><thead><tr><th scope="col">County</th>${YEARS.map(v => `<th scope="col">${v}<small>${esc(RACE[houRace(v)] || '')}</small></th>`).join('')}<th scope="col">2016 → ${yrs[yrs.length - 1]}</th></tr></thead><tbody>${
      [['region', 'Houston area'], ...HOU].map(([k, l]) => {
        const first = houRec(k, YEARS[0]), last = houRec(k, yrs[yrs.length - 1]), net = first && last ? margin(last) - margin(first) : null;
        return `<tr${H.scope === k ? ' class="el-hou-cur"' : ''}><th scope="row"><button type="button" data-hous="${k}">${esc(l)}</button></th>${YEARS.map(v => {
          const c = houRec(k, v), s = houShift(k, v, 1);
          return c ? `<td style="--c:${mScale(margin(c))}"><b>${mLabel(margin(c))}</b><small>${s == null ? '&nbsp;' : sLabel(s)}</small></td>` : '<td>—</td>';
        }).join('')}<td><b style="color:${col(net)}">${sLabel(net)}</b></td></tr>`;
      }).join('')}</tbody></table>`;

    $$('[data-houy]').forEach(b => b.onclick = () => { H.year = +b.dataset.houy; renderHouston(); });
    $$('[data-hous]').forEach(b => b.onclick = () => { H.scope = b.dataset.hous; renderHouston(); });
    $$('[data-houc]').forEach(p => {
      const pick = () => { H.scope = H.scope === p.dataset.houc ? 'region' : p.dataset.houc; renderHouston(); };
      p.onclick = pick;
      p.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      p.onmousemove = e => { const c = houRec(p.dataset.houc, y); tip(e, `<div class="el-tip-h">${esc(houName(p.dataset.houc))} · ${y}</div>${c ? `<div class="el-tip-row">D ${p1(pct(c.d, c.t))} · R ${p1(pct(c.r, c.t))}</div><div class="el-tip-row"><b>${mLabel(margin(c))}</b> · ${fmt(c.t)} votes</div>` : '<div class="el-tip-row">No county data</div>'}`); };
      p.onmouseleave = hideTip;
    });
  }

  // boot when the section gets close
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); boot(); } }, { rootMargin: '800px 0px' });
    io.observe(root);
  } else boot();
})();
