/* js/preflight.js — Preflight Brief panel in the METAR Stream section.
   Talks to /api/preflight-brief (lib/preflight.js decides the verdict; the
   model only narrates, and only for logged-in visitors). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BADGE = { GO: ['go', '🟢 GO'], CAUTION: ['caution', '🟡 CAUTION'], NO_GO: ['nogo', '🔴 NO-GO'] };
  const ROLE = { departure: '🛫 Departure', enroute: '🧭 Enroute', destination: '🛬 Destination' };
  const adminPw = () => { try { return (typeof ADMIN_PASSWORD_SESSION !== 'undefined' && ADMIN_PASSWORD_SESSION) || undefined; } catch { return undefined; } };

  // Model text is escaped first, then given to marked (if loaded) — so only
  // markdown survives, never HTML from the model or from NOTAM text.
  const md = t => (typeof marked !== 'undefined' && marked.parse) ? marked.parse(esc(t)) : esc(t).replace(/\n/g, '<br>');

  function stationCard(s) {
    const [cls, label] = BADGE[s.verdict] || BADGE.CAUTION;
    const flags = s.flags.length
      ? `<ul class="pf-flags">${s.flags.map(f => `<li class="pf-${(BADGE[f.severity] || BADGE.CAUTION)[0]}"><b>${esc(f.source)}</b> ${esc(f.message)}</li>`).join('')}</ul>`
      : '<div class="pf-clean">Within minimums — nothing flagged.</div>';
    return `<div class="pf-station pf-${cls}">
      <div class="pf-st-head"><span>${ROLE[s.role] || esc(s.role)} <b>${esc(s.station)}</b>${s.name ? ` <small>${esc(s.name)}</small>` : ''}</span>
        <span class="pf-badge pf-${cls}">${label}</span></div>
      <div class="pf-st-meta">at ${esc(s.eval_time)} · now <span class="cat-chip cat-${esc(s.category_now)}">${esc(s.category_now)}</span>${s.worst_forecast_category ? ` · forecast worst <span class="cat-chip cat-${esc(s.worst_forecast_category)}">${esc(s.worst_forecast_category)}</span>` : ''}</div>
      ${s.raw_metar ? `<code class="pf-raw">${esc(s.raw_metar)}</code>` : ''}
      ${s.raw_taf ? `<code class="pf-raw">${s.taf_source && s.taf_source !== s.station ? `[${esc(s.taf_source)}] ` : ''}${esc(s.raw_taf)}</code>` : ''}
      ${flags}
    </div>`;
  }

  function render(d) {
    const [cls, label] = BADGE[d.verdict] || BADGE.CAUTION;
    const narrative = d.narrative
      ? `<div class="pf-narr">${md(d.narrative)}<div class="pf-foot">Narrative by ${esc(d.model || 'model')} · verdict and flags by the rules engine</div></div>`
      : d.narrative_locked
        ? `<div class="pf-narr pf-locked"><span>✍️ <b>Log in (free)</b> to get the AI-written pilot brief. The verdict and flags above come from the rules engine and don't need an account.</span>
             <button class="btn-secondary" type="button" onclick="try{showAuthModal('login')}catch(e){}">Log in</button></div>`
        : '';
    $('#pf-out').innerHTML = `
      <div class="pf-verdict pf-${cls}"><span class="pf-badge pf-${cls}">${label}</span>
        <span>${esc(d.route.join(' → '))} · ${esc(d.profile.label || d.profile.name)} · ETD ${esc(d.etd)} · ETE ${esc(d.ete_hours)} h</span></div>
      <div class="pf-grid">${d.stations.map(stationCard).join('')}</div>
      ${narrative}
      <div class="pf-disclaimer">⚠️ ${esc(d.disclaimer)}${d.cached_weather ? ' · weather cached ≤5 min' : ''}</div>`;
  }

  async function run(ev) {
    if (ev) ev.preventDefault();
    const btn = $('#pf-run'), out = $('#pf-out');
    const route = ($('#pf-route').value || '').trim();
    if (!route) { $('#pf-route').focus(); return; }
    const local = $('#pf-etd').value;
    const body = {
      route, profile: $('#pf-profile').value, ete: Number($('#pf-ete').value || 1),
      etd: local ? new Date(local).toISOString() : undefined,
    };
    if (adminPw()) body.adminPassword = adminPw();
    btn.disabled = true; const txt = btn.textContent; btn.textContent = '⏳ Briefing…';
    out.innerHTML = '<div class="pf-placeholder">Pulling METARs, TAFs and NOTAMs and checking them against your minimums…</div>';
    try {
      const r = await fetch('/api/preflight-brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
      render(data);
    } catch (e) {
      out.innerHTML = `<div class="pf-placeholder">⚠️ ${esc(e.message || e)}</div>`;
    } finally { btn.disabled = false; btn.textContent = txt; }
  }

  function boot() {
    const form = $('#pf-form');
    if (!form) return;
    form.addEventListener('submit', run);
    document.querySelectorAll('[data-pf-route]').forEach(b => b.addEventListener('click', () => {
      $('#pf-route').value = b.getAttribute('data-pf-route'); run();
    }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.YH = window.YH || {};
  window.YH.preflight = { run, render };
})();
