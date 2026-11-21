/* js/elections-races.js — race-by-race results for #elections, laid out like Google's election panel.
   Every cycle 2016–2026 × Senate / House / Governor / President: chamber tally with the majority line,
   seats gained/lost, a state map (won / leading / no election), key races, and a per-state race card.
   Data: /data/elections/gold/races.json (pipelines/elections/build_races.py).
   Map:  states layer of /data/elections/us-counties-albers-10m.json (shared with js/elections.js).
   "County map" in a state card hands off to the county explorer below via the yh:elections-drill event. */
(function () {
  'use strict';
  const root = document.getElementById('el-races');
  if (!root) return;
  const $ = s => root.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => n == null ? '—' : Math.round(n).toLocaleString('en-US');
  const p2 = v => v == null ? '—' : v.toFixed(2) + '%';

  const YEARS = [2016, 2018, 2020, 2022, 2024, 2026];
  const RACES = [['senate', 'Senate'], ['house', 'House'], ['governor', 'Governor'], ['president', 'President']];
  const TITLE = { senate: 'US Senate results', house: 'US House results', governor: 'Governor results', president: 'Presidential results' };
  const PARTY = { D: 'Democratic Party', R: 'Republican Party', I: 'Independent (caucuses with Democrats)', O: 'Independent / other' };
  const NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
  const FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };
  // small states get Google-style callout chips to the right of the map
  const CALLOUTS = ['VT', 'NH', 'MA', 'RI', 'CT', 'NJ', 'DE', 'MD', 'DC'];
  const LABEL_NUDGE = { FL: [18, 18], LA: [-12, 2], MI: [14, 26], CA: [-10, 10], KY: [8, 2], ID: [0, 22], HI: [16, 8], AK: [0, 0], NY: [8, 0], VA: [8, 4], WV: [-4, 6], NC: [8, 0], MN: [-6, 10], OK: [12, 0] };

  const S = { year: 2026, race: 'senate', state: null, sort: { k: 'margin', dir: 1 } };
  let R, topo, d3, topojson, path, feats = [], featBy = {}, svg, ready = false;

  function palette() {
    const light = document.documentElement.getAttribute('data-scheme') === 'light';
    return light
      ? { D: '#2a6fdb', R: '#d93b3b', I: '#7b5cd6', O: '#8a6f2c', Dl: '#a9c6f3', Rl: '#f2b3b0', none: '#e4e3df', hatch: '#c9c7c0', text: '#fff', mid: '#cfcfca' }
      : { D: '#4a6cf0', R: '#d0383f', I: '#8a6cf0', O: '#a8873a', Dl: '#2c3f7f', Rl: '#7a2a2e', none: '#2a2c31', hatch: '#45474d', text: '#fff', mid: '#55575c' };
  }
  let P = palette();
  const col = p => P[p] || P.O;

  // ── data helpers ──
  const Y = () => R.years[String(S.year)];
  const block = () => Y()[S.race];
  const share = (c, t) => t && c.v != null ? c.v / t * 100 : null;
  const top2 = rec => { const d = rec.c.find(c => c.p === 'D' || c.p === 'I'), r = rec.c.find(c => c.p === 'R'); return [d, r]; };
  function margin(rec) { const [d, r] = top2(rec); return d && r && rec.t && d.v != null && r.v != null ? (d.v - r.v) / rec.t * 100 : null; }
  const winnerOf = rec => rec.c.find(c => c.w) || null;
  const callOf = rec => rec.win ? { p: rec.win, lead: false } : rec.lead ? { p: rec.lead, lead: true } : null;
  function stateRaces(po) {
    const b = block();
    if (S.race === 'house') return [];
    return (b.states[po] || []);
  }
  function stateCall(po) {  // {fill, label} for the map
    const b = block();
    if (S.race === 'house') {
      const s = b.states[po];
      if (!s) return null;
      const d = (s.seats.D || 0) + (s.seats.I || 0), r = s.seats.R || 0, n = d + r + (s.seats.O || 0) + (s.seats.pending || 0);
      return { d, r, n, house: true };
    }
    const rs = stateRaces(po);
    if (!rs.length) return (block().pending_states || []).includes(po) ? { p: null, waiting: true } : null;
    const calls = rs.map(callOf).filter(Boolean);
    if (!calls.length) return { p: null };
    const parties = [...new Set(calls.map(c => c.p))];
    return { p: parties[0], split: parties.length > 1 ? parties : null, lead: calls.every(c => c.lead) };
  }
  function fillFor(po) {
    const c = stateCall(po);
    if (!c) return 'url(#elr-noel)';
    if (c.house) {
      if (!c.n || c.d + c.r === 0) return P.none;
      const t = c.d / (c.d + c.r);  // majority party's colour, deeper as its share of seats grows
      return t === 0.5 ? P.mid : t > 0.5 ? d3.interpolateLab(P.Dl, P.D)(Math.min(1, (t - 0.5) * 2.5)) : d3.interpolateLab(P.Rl, P.R)(Math.min(1, (0.5 - t) * 2.5));
    }
    if (!c.p) return P.none;
    if (c.split) return 'url(#elr-split)';
    return c.lead ? (c.p === 'D' ? P.Dl : c.p === 'R' ? P.Rl : col(c.p)) : col(c.p);
  }

  // ── boot ──
  function loadScript(src) {
    return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Failed to load ' + src)); document.head.appendChild(s); });
  }
  async function boot() {
    try {
      const json = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
      const [races, t] = await Promise.all([
        json('/data/elections/gold/races.json'),
        json('/data/elections/us-counties-albers-10m.json'),
        window.d3 ? null : loadScript('/js/vendor/d3-7.9.0.min.js'),
      ]);
      if (!window.topojson) await loadScript('/js/vendor/topojson-client-3.1.0.min.js');
      R = races; topo = t; d3 = window.d3; topojson = window.topojson;
      init();
    } catch (e) {
      $('#elr-status').textContent = 'Could not load race results: ' + e.message;
    }
  }

  function init() {
    path = d3.geoPath();
    feats = topojson.feature(topo, topo.objects.states).features.filter(f => FIPS[f.id]);
    feats.forEach(f => { f.po = FIPS[f.id]; featBy[f.po] = f; });
    $('#elr-years').innerHTML = YEARS.map(y => `<button type="button" data-ry="${y}">${y}<small>${y % 4 === 0 ? 'President' : 'Midterm'}</small></button>`).join('');
    $('#elr-tabs').innerHTML = RACES.map(([k, l]) => `<button type="button" role="tab" data-rr="${k}">${l}</button>`).join('');
    buildMap();
    bind();
    ready = true;
    $('#elr-status').remove();
    $('#elr-body').hidden = false;
    render();
  }

  function buildMap() {
    svg = d3.select($('#elr-map')).attr('viewBox', '0 0 1040 610');
    const defs = svg.append('defs');
    const hatch = defs.append('pattern').attr('id', 'elr-noel').attr('patternUnits', 'userSpaceOnUse').attr('width', 7).attr('height', 7).attr('patternTransform', 'rotate(45)');
    hatch.append('rect').attr('class', 'elr-noel-bg').attr('width', 7).attr('height', 7);
    hatch.append('rect').attr('class', 'elr-noel-line').attr('width', 2.2).attr('height', 7);
    const split = defs.append('pattern').attr('id', 'elr-split').attr('patternUnits', 'userSpaceOnUse').attr('width', 12).attr('height', 12).attr('patternTransform', 'rotate(45)');
    split.append('rect').attr('class', 'elr-split-a').attr('width', 6).attr('height', 12);
    split.append('rect').attr('class', 'elr-split-b').attr('x', 6).attr('width', 6).attr('height', 12);
    svg.append('g').attr('class', 'elr-states').selectAll('path').data(feats).join('path')
      .attr('d', path).attr('tabindex', 0).attr('role', 'button').attr('aria-label', f => NAMES[f.po])
      .on('mousemove', (e, f) => tip(e, stateTip(f.po))).on('mouseleave', hideTip)
      .on('click', (e, f) => select(f.po))
      .on('keydown', (e, f) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(f.po); } });
    svg.append('path').datum(topojson.mesh(topo, topo.objects.states, (a, b) => a !== b)).attr('class', 'elr-borders').attr('d', path);
    svg.append('g').attr('class', 'elr-labels');
    svg.append('g').attr('class', 'elr-callouts');
  }

  // ── tooltip (shares #el-tip styling) ──
  let tipEl;
  function tip(e, html) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'el-tip elr-tip'; tipEl.setAttribute('role', 'tooltip'); root.appendChild(tipEl); }
    tipEl.innerHTML = html; tipEl.hidden = false;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }
  function stateTip(po) {
    const head = `<div class="el-tip-h">${esc(NAMES[po])}</div>`;
    if (S.race === 'house') {
      const s = block().states[po];
      if (!s) return head + '<div class="el-tip-row muted">No results loaded</div>';
      const n = Object.values(s.districts).length;
      return head + `<div class="el-tip-row">${n} district${n > 1 ? 's' : ''} · <b style="color:${P.D}">${(s.seats.D || 0) + (s.seats.I || 0)} D</b> · <b style="color:${P.R}">${s.seats.R || 0} R</b>${s.seats.pending ? ` · ${s.seats.pending} undecided` : ''}</div>`;
    }
    const rs = stateRaces(po);
    if (!rs.length && (block().pending_states || []).includes(po)) return head + '<div class="el-tip-row muted">Race on the ballot · result not loaded yet</div>';
    if (!rs.length) return head + `<div class="el-tip-row muted">No ${S.race === 'president' ? 'presidential' : S.race} election in ${S.year}</div>`;
    return head + rs.map(r => `<div class="el-tip-row muted">${esc(raceName(r))}</div>` + r.c.slice(0, 3).map(c =>
      `<div class="el-tip-row">${c.w ? '✔ ' : ''}${esc(c.n)} <span style="color:${col(c.p)}">(${c.p})</span> <b>${p2(share(c, r.t))}</b></div>`).join('')).join('');
  }
  function raceName(r) {
    if (S.race === 'senate') return `US Senate${r.special ? ' special' : ''} · Class ${r.cls}${r.stage === 'runoff' ? ' · runoff' : ''}`;
    if (S.race === 'governor') return 'Governor' + (r.stage === 'runoff' ? ' · runoff' : '');
    return 'President';
  }

  // ── controls ──
  function select(po) { S.state = S.state === po ? null : po; render(); if (S.state && innerWidth < 980) $('#elr-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  function bind() {
    root.addEventListener('click', e => {
      const y = e.target.closest('[data-ry]');
      if (y) { S.year = +y.dataset.ry; if (S.race === 'president' && !Y().president) S.race = 'senate'; render(); return; }
      const r = e.target.closest('[data-rr]');
      if (r && !r.disabled) { S.race = r.dataset.rr; render(); return; }
      const k = e.target.closest('[data-rs]');
      if (k) { select(k.dataset.rs); return; }
      const back = e.target.closest('[data-rback]');
      if (back) { S.state = null; render(); return; }
      const th = e.target.closest('th[data-rk]');
      if (th) { const kk = th.dataset.rk; S.sort = { k: kk, dir: S.sort.k === kk ? -S.sort.dir : (kk === 'name' || kk === 'margin' ? 1 : -1) }; renderTable(); return; }
      const dr = e.target.closest('[data-drill]');
      if (dr) { window.dispatchEvent(new CustomEvent('yh:elections-drill', { detail: { year: S.year, state: dr.dataset.drill } })); }
    });
    root.addEventListener('keydown', e => { const tr = e.target.closest('tr[data-rs]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(tr.dataset.rs); } });
    window.addEventListener('yh:themechange', () => { if (!ready) return; P = palette(); render(); });
  }

  // ── render ──
  function render() {
    root.querySelectorAll('[data-ry]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.ry === S.year)));
    root.querySelectorAll('[data-rr]').forEach(b => {
      const off = b.dataset.rr === 'president' && !Y().president;
      b.disabled = off; b.title = off ? `No presidential election in ${S.year}` : '';
      b.setAttribute('aria-selected', String(b.dataset.rr === S.race));
    });
    root.style.setProperty('--elr-d', P.D); root.style.setProperty('--elr-r', P.R); root.style.setProperty('--elr-i', P.I); root.style.setProperty('--elr-o', P.O);
    root.style.setProperty('--elr-dl', P.Dl); root.style.setProperty('--elr-rl', P.Rl); root.style.setProperty('--elr-none', P.none); root.style.setProperty('--elr-hatch', P.hatch);
    renderMeta(); renderTally(); paint(); renderLegend(); renderNotes(); renderSide(); renderTable();
  }

  function asOf() {
    let latest = null;
    const scan = r => { if (r && r.as_of && (!latest || r.as_of > latest)) latest = r.as_of; };
    const b = block();
    if (S.race === 'house') Object.values(b.states).forEach(s => Object.values(s.districts).forEach(scan));
    else Object.values(b.states).forEach(rs => rs.forEach(scan));
    return latest;
  }
  function renderMeta() {
    const live = S.year === 2026, a = asOf();
    $('#elr-meta').innerHTML = live
      ? `<span class="elr-live">● Unofficial</span><span>${a ? 'Results as of ' + esc(a) : 'Results added as states report'} · replaced as states certify</span>`
      : `<span class="elr-cert">✔ Certified</span><span>Final results</span>`;
    $('#elr-title').textContent = `${S.year} ${TITLE[S.race]}`;
    $('#elr-src').innerHTML = S.year === 2026 ? 'Statewide returns from news and state election sites; each race links its source' : S.race === 'house' && S.year === 2016
      ? 'From <a href="https://github.com/MEDSL/constituency-returns" target="_blank" rel="noopener">MIT Election Lab</a>' : 'From <a href="https://github.com/fivethirtyeight/election-results" target="_blank" rel="noopener">FiveThirtyEight election results</a> (certified)';
  }

  function renderTally() {
    const b = block();
    let dN, rN, pend = 0, maj = b.majority, total = b.total, unit = 'seats', dLab = 'DEM', rLab = 'GOP', gain = null, extra = [];
    if (S.race === 'president') {
      dN = b.ev.D; rN = b.ev.R; pend = b.ev.O || 0; unit = 'electoral votes'; maj = 270;
      const pop = { D: 0, R: 0, t: 0 }; let dn = '', rn = '';
      Object.values(b.states).forEach(([s]) => { s.c.forEach(c => { if (c.p === 'D') { pop.D += c.v || 0; dn = c.n; } if (c.p === 'R') { pop.R += c.v || 0; rn = c.n; } }); pop.t += s.t; });
      dLab = esc(dn.split(' ').pop()) + ' · DEM'; rLab = 'GOP · ' + esc(rn.split(' ').pop());
      extra.push(`Popular vote: ${esc(dn)} ${p2(pop.D / pop.t * 100)} (${fmt(pop.D)}) · ${esc(rn)} ${p2(pop.R / pop.t * 100)} (${fmt(pop.R)})`);
      if (b.prev_ev) gain = b.ev.D - b.prev_ev.D;
    } else {
      dN = b.seats.D + b.seats.I; rN = b.seats.R; pend = b.seats.pending + (b.seats.O || 0);
      if (b.prev) gain = dN - (b.prev.D + b.prev.I);
      if (b.seats.I) extra.push(`${b.seats.I} independent${b.seats.I > 1 ? 's' : ''} caucus${b.seats.I > 1 ? '' : 'es'} with DEM`);
      if (b.seats.O) extra.push(`${b.seats.O} independent${b.seats.O > 1 ? 's' : ''} (no caucus)`);
      if (b.seats.pending) extra.push(`${b.seats.pending} ${S.race === 'house' ? 'district' : 'race'}${b.seats.pending > 1 ? 's' : ''} not called or not loaded yet`);
      if (S.race !== 'house') extra.push(`${b.up} race${b.up > 1 ? 's' : ''} this cycle · totals include seats not up`);
      if (S.race === 'house' && b.popular && b.popular.t) extra.push(`Reported House vote: DEM ${p2(b.popular.D / b.popular.t * 100)} · GOP ${p2(b.popular.R / b.popular.t * 100)}`);
    }
    const w = v => (v / total * 100).toFixed(3) + '%';
    const none = dN + rN === 0;
    if (none) gain = null;
    const so = pend && gain != null ? ' so far' : '';
    const g = gain == null ? '' : gain === 0 ? '<span>No net change</span><span>No net change</span>'
      : `<span>${gain > 0 ? 'Gained' : 'Lost'} ${Math.abs(gain)} ${unit === 'seats' ? (Math.abs(gain) === 1 ? 'seat' : 'seats') : 'EV vs ' + (S.year - 4)}${so}</span><span>${gain > 0 ? 'Lost' : 'Gained'} ${Math.abs(gain)} ${unit === 'seats' ? (Math.abs(gain) === 1 ? 'seat' : 'seats') : 'EV vs ' + (S.year - 4)}${so}</span>`;
    $('#elr-tally').innerHTML = `
      <div class="elr-nums"><div class="elr-n elr-nd"><b>${none ? '—' : dN}</b><span>${dLab}</span></div>
        <div class="elr-maj"><span>${maj} ${unit === 'seats' ? 'seats' : 'to win'}</span><i></i></div>
        <div class="elr-n elr-nr"><span>${rLab}</span><b>${none ? '—' : rN}</b></div></div>
      <div class="elr-bar" role="img" aria-label="${dN} Democratic, ${rN} Republican, ${pend} other or undecided, of ${total}; ${maj} for a majority">
        <i class="elr-bd" style="width:${w(dN)}"></i><i class="elr-bp" style="width:${w(pend)}"></i><i class="elr-br" style="width:${w(rN)}"></i>
        <em style="left:${(maj - 0.5) / total * 100}%"></em></div>
      <div class="elr-gain">${g}</div>
      ${extra.length ? `<div class="elr-extra">${extra.map(x => `<span>${x}</span>`).join('')}</div>` : ''}`;
  }

  function paint() {
    svg.select('.elr-states').selectAll('path').attr('fill', f => fillFor(f.po)).classed('elr-sel', f => f.po === S.state).classed('elr-dim', f => S.state && f.po !== S.state);
    svg.select('#elr-split .elr-split-a').attr('fill', P.D); svg.select('#elr-split .elr-split-b').attr('fill', P.R);
    svg.select('.elr-noel-bg').attr('fill', P.none); svg.select('.elr-noel-line').attr('fill', P.hatch);
    // labels on big states; small states get callout chips (Google-style)
    const lab = feats.filter(f => !CALLOUTS.includes(f.po) && path.area(f) > 260);
    svg.select('.elr-labels').selectAll('text').data(lab, f => f.po).join('text')
      .attr('x', f => path.centroid(f)[0] + (LABEL_NUDGE[f.po] || [0, 0])[0]).attr('y', f => path.centroid(f)[1] + (LABEL_NUDGE[f.po] || [0, 0])[1] + 4)
      .attr('class', f => 'elr-lab' + (stateCall(f.po) ? '' : ' elr-lab-off')).text(f => S.race === 'house' && stateCall(f.po) ? f.po : f.po);
    const co = CALLOUTS.filter(po => featBy[po] && (po !== 'DC' || S.race === 'president'));
    const cg = svg.select('.elr-callouts').selectAll('g').data(co, d => d).join(en => { const g = en.append('g').attr('class', 'elr-co'); g.append('line'); g.append('rect'); g.append('text'); return g; });
    cg.attr('tabindex', 0).attr('role', 'button').attr('aria-label', po => NAMES[po])
      .on('click', (e, po) => select(po)).on('mousemove', (e, po) => tip(e, stateTip(po))).on('mouseleave', hideTip)
      .on('keydown', (e, po) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(po); } })
      .classed('elr-sel', po => po === S.state);
    cg.each(function (po, i) {
      const [cx, cy] = path.centroid(featBy[po]), x = 985, y = 150 + i * 38, g = d3.select(this), lw = S.race === 'house' ? 52 : 40;
      g.select('line').attr('x1', cx).attr('y1', cy).attr('x2', x - lw / 2).attr('y2', y);
      g.select('rect').attr('x', x - lw / 2).attr('y', y - 13).attr('width', lw).attr('height', 26).attr('rx', 13).attr('fill', fillFor(po));
      const c = stateCall(po);
      g.select('text').attr('x', x).attr('y', y + 4.5).attr('class', 'elr-lab' + (c ? '' : ' elr-lab-off')).text(S.race === 'house' && c ? `${po} ${c.d}-${c.r}` : po);
    });
  }

  function renderLegend() {
    const items = S.race === 'house'
      ? [[`linear-gradient(90deg,${P.R},${P.Rl})`, 'GOP majority of seats'], [P.mid, 'Even split'], [`linear-gradient(90deg,${P.Dl},${P.D})`, 'DEM majority (deeper = larger share)']]
      : [[`linear-gradient(90deg,${P.D} 50%,${P.R} 50%)`, 'Won'], [`linear-gradient(90deg,${P.Dl} 50%,${P.Rl} 50%)`, 'Leading (not called)'],
        [P.none, 'Not called / pending'], [`repeating-linear-gradient(45deg,${P.hatch} 0 2px,${P.none} 2px 6px)`, 'No election']];
    if (S.race !== 'house' && Object.values(block().states).some(rs => rs.some(r => r.win === 'O' || r.win === 'I'))) items.splice(1, 0, [P.O, 'Independent']);
    $('#elr-legend').innerHTML = items.map(([bg, l]) => `<span><i style="background:${bg}"></i>${esc(l)}</span>`).join('');
  }

  function renderNotes() {
    const b = block(), n = [];
    if (S.race === 'senate') n.push('Seat totals count the latest election for all 100 seats. Independents Sanders and King caucus with Democrats and are counted with them.');
    if (S.race === 'governor') n.push('Totals count the sitting governor in all 50 states after this election, including odd-year races (VA, NJ, KY, LA, MS) and Jim Justice\'s 2017 switch to Republican.');
    if (S.race === 'house') n.push('District shapes change with redistricting, so each state is shaded by its share of seats won; click a state for every district.');
    if (S.race === 'president') n.push('Maine and Nebraska split electoral votes by congressional district. 2016 shows electoral votes as won; seven faithless electors changed the certified count to 304–227.');
    if (S.year === 2018 && S.race === 'house') n.push('NC-9 (2018) was never certified and stayed vacant until a 2019 re-run, so it counts as undecided.');
    if (S.year === 2026 && S.race === 'house' && b.seats.pending === 435) n.push('2026 district results haven\'t been loaded yet. They go in pipelines/elections/manual/2026_house.csv and appear here on the next build.');
    if (S.year === 2026 && S.race === 'senate' && b.seats.pending) n.push(`${b.seats.pending} 2026 Senate races aren't loaded yet; their seats count as pending, not for the previous holder.`);
    $('#elr-notes').innerHTML = n.map(x => `<p>${x}</p>`).join('');
  }

  // ── side panel: key races, or the selected state's race card ──
  function candRows(rec, showVotes = true) {
    return rec.c.map(c => {
      const s = share(c, rec.t), lead = !rec.win && rec.lead && rec.c[0] === c;
      return `<div class="elr-cand${c.w ? ' elr-won' : ''}">
        <div class="elr-cn"><b>${esc(c.n)}</b><span>${esc(PARTY[c.p])}${c.u ? ' · unopposed' : ''}</span></div>
        <div class="elr-cv">${showVotes && c.v != null ? fmt(c.v) : ''}</div>
        <div class="elr-cp" style="--pc:${col(c.p)}"${c.w || lead ? ' data-on' : ''}>${c.w ? '<i aria-label="Winner">✔</i>' : lead ? '<i aria-label="Leading" class="elr-ld">▲</i>' : ''}${s == null ? (c.u ? 'Unopposed' : '—') : p2(s)}</div>
      </div>`;
    }).join('') + (rec.o ? `<div class="elr-cand elr-oth"><div class="elr-cn"><span>Other / write-in</span></div><div class="elr-cv">${fmt(rec.o)}</div><div class="elr-cp">${p2(rec.o / rec.t * 100)}</div></div>` : '');
  }
  function flipBadge(rec) {
    const w = rec.win, h = rec.held;
    if (!w || !h || w === h || (w === 'I' && h === 'D') || (w === 'D' && h === 'I')) return '';
    return `<span class="elr-flip" style="--fc:${col(w)}">${w === 'I' ? 'IND' : w === 'D' ? 'DEM' : w === 'R' ? 'GOP' : 'IND'} flip from ${h === 'D' ? 'DEM' : h === 'R' ? 'GOP' : 'IND'}</span>`;
  }
  function countyLink(po) {
    // the county explorer below shows one race per state; offer the hand-off when that race matches
    const g = window.YH_ELECTIONS && window.YH_ELECTIONS.stateRace && window.YH_ELECTIONS.stateRace(po, S.year);
    const race = S.race === 'senate' ? ['senate', 'senate_special'] : [S.race];
    return g && race.includes(g) ? `<button type="button" class="elr-drill" data-drill="${po}">County map ↓</button>` : '';
  }
  function renderSide() {
    const box = $('#elr-detail'), b = block();
    if (S.state) {
      const po = S.state;
      let body = '';
      if (S.race === 'house') {
        const s = b.states[po];
        body = !s ? '<p class="el-empty">No district results loaded.</p>' : Object.entries(s.districts).map(([d, rec]) => {
          const one = Object.keys(s.districts).length === 1;
          return `<div class="elr-race"><h4>${one ? 'At-large' : 'District ' + esc(d)}${rec.stage === 'runoff' ? ' · runoff' : ''}${rec.note ? `<small>${esc(rec.note)}</small>` : ''}</h4>${candRows(rec)}${rec.src ? `<p class="elr-srcl">${esc(rec.status || '')} · <a href="${esc(rec.src)}" target="_blank" rel="noopener">source</a></p>` : ''}</div>`;
        }).join('');
        if (s) {
          const d = (s.seats.D || 0) + (s.seats.I || 0), r = s.seats.R || 0, pd = s.prev ? (s.prev.D || 0) + (s.prev.I || 0) : null;
          body = `<div class="elr-hsum"><b style="color:${P.D}">${d} D</b><b style="color:${P.R}">${r} R</b>${s.seats.pending ? `<b>${s.seats.pending} undecided</b>` : ''}${pd != null && pd !== d ? `<span>${d > pd ? '+' : ''}${d - pd} D vs ${S.year - 2}</span>` : ''}</div>` + body;
        }
      } else {
        const rs = stateRaces(po);
        body = !rs.length && (b.pending_states || []).includes(po) ? `<p class="el-empty">${esc(NAMES[po])} has a ${S.race === 'senate' ? 'Senate' : 'governor'} race in ${S.year}; its result isn't loaded yet.</p>`
          : !rs.length ? `<p class="el-empty">No ${S.race === 'president' ? 'presidential' : S.race} election in ${esc(NAMES[po])} in ${S.year}.</p>` : rs.map(rec => {
          const first = rec.first ? `<details class="elr-first"><summary>First round (${esc(rec.stage === 'runoff' ? 'November' : '')})</summary>${candRows(rec.first)}</details>` : '';
          const ev = rec.ev ? `<p class="elr-ev">${rec.ev} electoral votes${rec.ev_split ? ' · split ' + Object.entries(rec.ev_split).map(([p, n]) => `${n} ${p === 'D' ? 'DEM' : 'GOP'}`).join(', ') : ''}</p>` : '';
          const dist = rec.districts ? Object.entries(rec.districts).sort().map(([d, dr]) => `<div class="elr-race elr-sub"><h4>District ${esc(d)} · 1 electoral vote</h4>${candRows(dr)}</div>`).join('') : '';
          return `<div class="elr-race"><h4>${esc(raceName(rec))} ${flipBadge(rec)}</h4>${ev}${candRows(rec)}${first}${dist}
            <p class="elr-srcl">${rec.t ? fmt(rec.t) + ' votes' : ''}${rec.status ? ' · ' + esc(rec.status) : ''}${rec.as_of ? ' · as of ' + esc(rec.as_of) : ''}${rec.src ? ` · <a href="${esc(rec.src)}" target="_blank" rel="noopener">source</a>` : ''}</p></div>`;
        }).join('');
      }
      box.innerHTML = `<div class="elr-dh"><button type="button" class="elr-back" data-rback aria-label="Back to key races">‹</button><h3>${esc(NAMES[po])} · ${S.year}</h3>${countyLink(po)}</div>${body}`;
      return;
    }
    // key races: closest D-vs-R contests (house: closest districts)
    let list = [];
    if (S.race === 'house') {
      Object.entries(b.states).forEach(([po, s]) => Object.entries(s.districts).forEach(([d, rec]) => { const m = margin(rec); if (m != null) list.push({ po, label: po + (Object.keys(s.districts).length > 1 ? '-' + d : '-AL'), rec, m }); }));
    } else {
      Object.entries(b.states).forEach(([po, rs]) => rs.forEach(rec => { const m = margin(rec); list.push({ po, label: po + (rs.length > 1 && rec.special ? '*' : ''), rec, m: m == null ? 999 : m }); }));
    }
    list.sort((a, b2) => Math.abs(a.m) - Math.abs(b2.m));
    const flips = S.race === 'house' ? [] : list.filter(x => flipBadge(x.rec));
    const row = x => {
      const w = winnerOf(x.rec) || x.rec.c[0], s = share(w, x.rec.t), lead = !x.rec.win;
      return `<button type="button" class="elr-kr" data-rs="${x.po}"><span class="elr-ks">${esc(x.label)}</span>
        <span class="elr-kn"><b>${esc(w.n)}</b><small>${esc(PARTY[w.p])}${flipBadge(x.rec) ? ' · flip' : ''}</small></span>
        <span class="elr-kp" style="--pc:${lead ? (w.p === 'D' ? P.Dl : w.p === 'R' ? P.Rl : col(w.p)) : col(w.p)}">${lead ? '▲ ' : '✔ '}${p2(s)}<small>${x.m === 999 ? '' : 'margin ' + Math.abs(x.m).toFixed(1)}</small></span><i aria-hidden="true">›</i></button>`;
    };
    box.innerHTML = `<h3>Key races</h3><p class="el-sub">Closest ${S.race === 'house' ? 'districts' : 'races'} · ${S.year}. Click for the full result.</p>
      ${list.length ? list.slice(0, 8).map(row).join('') : '<p class="el-empty">No results loaded for this race yet.</p>'}
      ${flips.length ? `<h3 class="elr-h3b">Seats that flipped (${flips.length})</h3>${flips.slice(0, 12).map(row).join('')}` : ''}`;
  }

  // ── table: every race, sortable (the map's accessible twin) ──
  function renderTable() {
    const b = block(), rows = [];
    if (S.race === 'house') {
      Object.entries(b.states).forEach(([po, s]) => {
        let d = 0, r = 0, t = 0;
        Object.values(s.districts).forEach(rec => { rec.c.forEach(c => { if (c.p === 'D' || c.p === 'I') d += c.v || 0; if (c.p === 'R') r += c.v || 0; }); t += rec.t; });
        const sd = (s.seats.D || 0) + (s.seats.I || 0), pd = s.prev ? (s.prev.D || 0) + (s.prev.I || 0) : null;
        rows.push({ po, name: NAMES[po], seats: Object.keys(s.districts).length, dS: sd, rS: s.seats.R || 0, chg: pd == null ? null : sd - pd, d: t ? d / t * 100 : null, r: t ? r / t * 100 : null, margin: t ? Math.abs(d - r) / t * 100 : null, t });
      });
    } else {
      Object.entries(b.states).forEach(([po, rs]) => rs.forEach(rec => {
        const [d, r] = top2(rec), w = winnerOf(rec);
        rows.push({ po, name: NAMES[po] + (rs.length > 1 ? (rec.special ? ' (special)' : ' (regular)') : ''), win: w ? w.n : rec.lead ? rec.c[0].n + ' (leading)' : '—', wp: rec.win || rec.lead,
          d: d ? share(d, rec.t) : null, r: r ? share(r, rec.t) : null, margin: margin(rec) == null ? null : Math.abs(margin(rec)), t: rec.t, flip: !!flipBadge(rec), ev: rec.ev });
      }));
    }
    const { k, dir } = S.sort;
    rows.sort((a, c) => k === 'name' ? dir * a.name.localeCompare(c.name) : dir * ((a[k] == null ? 1e12 * dir : a[k]) - (c[k] == null ? 1e12 * dir : c[k])));
    const cols = S.race === 'house'
      ? [['name', 'State'], ['seats', 'Seats'], ['dS', 'DEM won'], ['rS', 'GOP won'], ['chg', `DEM change vs ${S.year - 2}`], ['d', 'DEM vote %'], ['r', 'GOP vote %'], ['t', 'Votes']]
      : [['name', 'State'], ['win', 'Winner'], ['d', 'DEM %'], ['r', 'GOP %'], ['margin', 'Margin'], ['t', 'Votes'], ...(S.race === 'president' ? [['ev', 'EV']] : [['flip', 'Flip']])];
    $('#elr-table-title').textContent = `${S.year} ${TITLE[S.race].replace(' results', '')}: ${rows.length} ${S.race === 'house' ? 'states' : 'races'}`;
    const cell = (r, c) => {
      const v = r[c];
      if (c === 'name') return `<th scope="row">${esc(v)}</th>`;
      if (c === 'win') return `<td><span class="elr-dot" style="background:${col(r.wp)}"></span>${esc(v)}</td>`;
      if (c === 'd' || c === 'r') return `<td>${p2(v)}</td>`;
      if (c === 'margin') return `<td>${v == null ? '—' : v.toFixed(1) + ' pts'}</td>`;
      if (c === 't') return `<td>${fmt(v)}</td>`;
      if (c === 'chg') return `<td>${v == null ? '—' : (v > 0 ? '+' : '') + v}</td>`;
      if (c === 'flip') return `<td>${v ? '<span class="elr-flipdot">Flip</span>' : ''}</td>`;
      return `<td>${v == null ? '—' : esc(v)}</td>`;
    };
    $('#elr-table').classList.toggle('elr-table-house', S.race === 'house');
    $('#elr-table').innerHTML = `<thead><tr>${cols.map(([c, l]) => `<th scope="col" data-rk="${c}" aria-sort="${k === c ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${k === c ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr data-rs="${r.po}" tabindex="0"${r.po === S.state ? ' class="el-row-sel"' : ''}>${cols.map(([c]) => cell(r, c)).join('')}</tr>`).join('')}</tbody>`;
  }

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); boot(); } }, { rootMargin: '800px 0px' });
    io.observe(root);
  } else boot();
})();
