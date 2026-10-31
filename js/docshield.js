/* js/docshield.js — DocShield section (#docshield).
   Reads a file in the browser, sends it to /api/docshield, renders the report.
   Every string from the report (filenames, evidence snippets — attacker text by
   definition) is HTML-escaped before it touches the DOM. */
(function () {
  'use strict';
  const root = document.getElementById('docshield');
  if (!root) return;
  const $ = s => root.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX = 2 * 1024 * 1024;
  const VERDICT = { ALLOW: '✅ ALLOW', REVIEW: '⚠️ REVIEW', BLOCK: '⛔ BLOCK' };
  const SOURCE = { file: 'file', 'page-text': 'visible page text', 'hidden-text': 'hidden text layer', metadata: 'metadata', text: 'text' };
  let mode = 'file', picked = null, last = null;

  // ── input ──
  root.querySelectorAll('.ds-tabs button').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    root.querySelectorAll('.ds-tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $('#ds-drop').hidden = mode !== 'file';
    $('#ds-text').hidden = mode !== 'text';
  }));
  const drop = $('#ds-drop'), input = $('#ds-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('ds-over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('ds-over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) pick(input.files[0]); });

  function pick(f) {
    picked = f;
    $('#ds-picked').innerHTML = `<span class="ds-file">${esc(f.name)}</span> · ${(f.size / 1024).toFixed(1)} KB`;
    if (f.size > MAX) { picked = null; $('#ds-picked').innerHTML = `<span style="color:#d0453a">${esc(f.name)} is over 2 MB.</span>`; }
  }
  const toB64 = f => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(f); });

  async function call(body) {
    $('#ds-out').innerHTML = '<div class="ds-placeholder">🛡️ Scanning…</div>';
    $('#ds-run').disabled = true;
    try {
      const r = await fetch('/api/docshield', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, format: 'sarif' }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
      last = d; render(d);
    } catch (e) {
      $('#ds-out').innerHTML = `<div class="ds-err">Scan failed: ${esc(e.message)}</div>`;
    } finally { $('#ds-run').disabled = false; }
  }

  $('#ds-run').addEventListener('click', async () => {
    if (mode === 'text') {
      const text = $('#ds-text').value;
      if (!text.trim()) { $('#ds-text').focus(); return; }
      return call({ text });
    }
    if (!picked) { input.click(); return; }
    call({ fileName: picked.name, mimeType: picked.type, data: await toB64(picked) });
  });
  root.querySelectorAll('[data-ds-sample]').forEach(b => b.addEventListener('click', () => call({ sample: b.dataset.dsSample })));

  // ── output ──
  const chips = (list, cls) => list.map(x => `<span class="ds-chip ${cls}" title="${esc(x)}">${esc(x.split(' ')[0])}</span>`).join('');
  const chipsFull = (list, cls) => list.map(x => `<span class="ds-chip ${cls}">${esc(x)}</span>`).join('');

  function render(d) {
    const f = d.file || {};
    const fw = d.frameworks || {};
    const findings = (d.findings || []).map(x => `
      <li class="ds-f ds-s-${esc(x.severity)}">
        <div class="ds-f-head"><span class="ds-sev">${esc(x.severity)}</span><span class="ds-f-title">${esc(x.title)}</span><span class="ds-rule">${esc(x.rule)} · ${esc(SOURCE[x.source] || x.source)}${x.count > 1 ? ` · ×${x.count}` : ''}</span></div>
        <div class="ds-f-detail">${esc(x.detail)}</div>
        ${x.evidence ? `<code class="ds-ev">${esc(x.evidence)}</code>` : ''}
        <div class="ds-fw">${chips(x.mappings.owasp, 'ds-owasp')}${chips(x.mappings.attack, 'ds-attack')}${chips(x.mappings.atlas, 'ds-atlas')}${chips(x.mappings.cwe, '')}</div>
      </li>`).join('');
    $('#ds-out').innerHTML = `
      <div class="ds-verdict">
        <span class="ds-badge ds-v-${esc(d.verdict)}">${VERDICT[d.verdict] || esc(d.verdict)}</span>
        <div class="ds-meter"><span>Risk score ${esc(d.score)} / 100</span><div class="ds-bar"><i style="width:${Math.max(2, Number(d.score) || 0)}%"></i></div></div>
      </div>
      ${d.sample ? `<div class="ds-meta">Sample: ${esc(d.sample.title)} (${esc(d.sample.label)})</div>` : ''}
      <div class="ds-meta">${esc(f.name)} · ${esc(f.type)} · ${(Number(f.size || 0) / 1024).toFixed(1)} KB · sha256 ${esc((f.sha256 || '').slice(0, 16))}… · ${esc(d.elapsed_ms)} ms${d.stats?.pages ? ` · ${esc(d.stats.pages)} page(s), ${esc(d.stats.streams)} streams decoded` : ''}</div>
      ${(fw.owasp?.length || fw.attack?.length || fw.atlas?.length) ? `<div class="ds-fw">${chipsFull(fw.owasp || [], 'ds-owasp')}${chipsFull(fw.atlas || [], 'ds-atlas')}${chipsFull(fw.attack || [], 'ds-attack')}</div>` : ''}
      ${findings ? `<ul class="ds-findings">${findings}</ul>` : '<div class="ds-placeholder" style="padding:1.2rem">No findings. Nothing in this file tries to steer a model, hide content or leak secrets.</div>'}
      ${(d.limitations || []).length ? `<div class="ds-limits">ℹ️ ${d.limitations.map(esc).join('<br>ℹ️ ')}</div>` : ''}
      <div class="ds-dl"><button type="button" data-dl="json">⬇ Report JSON</button><button type="button" data-dl="sarif">⬇ SARIF 2.1.0</button></div>`;
    $('#ds-out').querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => download(b.dataset.dl)));
  }

  function download(kind) {
    if (!last) return;
    const { sarif, ...report } = last;
    const data = kind === 'sarif' ? sarif : report;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `docshield-${(last.file?.sha256 || 'report').slice(0, 8)}.${kind === 'sarif' ? 'sarif' : 'json'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── benchmark ──
  fetch('/public_data_docshield_eval.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(e => {
    if (!e) return;
    const pct = n => `${Math.round(n * 100)}%`;
    const row = (name, m, me) => `<tr class="${me ? 'ds-me' : ''}"><td>${name}</td><td class="ds-num">${m.tp}/${m.tp + m.fn}</td><td class="ds-num">${pct(m.recall)}</td><td class="ds-num">${m.fp}/${m.fp + m.tn}</td></tr>`;
    $('#ds-bench-table').innerHTML = `<thead><tr><th>Gate</th><th>Attacks caught</th><th>Recall</th><th>False alarms</th></tr></thead>
      <tbody>${row('DocShield', e.docshield, true)}${row('Previous upload filter', e.fileguard, false)}</tbody>`;
    $('#ds-bench-meta').textContent = `${e.corpus.malicious} attack + ${e.corpus.benign} benign documents · p50 ${e.docshield.latency_ms.p50} ms, p95 ${e.docshield.latency_ms.p95} ms · engine ${e.engine}`;
  }).catch(() => {});
})();
