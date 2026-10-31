#!/usr/bin/env node
// docshield/cli.js — scan files from the command line or CI.
//
//   node docshield/cli.js <file|dir>... [--json] [--sarif out.sarif] [--fail-on review|block]
//
// Exit codes: 0 = nothing at/above the --fail-on level, 1 = at least one file hit it, 2 = usage error.
// Directories are walked recursively (skipping node_modules and .git).

import fs from 'node:fs';
import path from 'node:path';
import { scanBuffer, toSarif } from '../lib/docshield/index.js';

const argv = process.argv.slice(2);
const opt = { json: false, sarif: null, failOn: 'block' };
const targets = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opt.json = true;
  else if (a === '--sarif') opt.sarif = argv[++i];
  else if (a === '--fail-on') opt.failOn = String(argv[++i] || '').toLowerCase();
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(0); }
  else targets.push(a);
}
if (!targets.length || !['review', 'block', 'none'].includes(opt.failOn)) {
  console.error('usage: docshield <file|dir>... [--json] [--sarif out.sarif] [--fail-on review|block|none]');
  process.exit(2);
}

const files = [];
const walk = p => {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) if (e !== 'node_modules' && e !== '.git') walk(path.join(p, e)); }
  else files.push(p);
};
for (const t of targets) walk(t);

const MIME = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', html: 'text/html', svg: 'image/svg+xml' };
const ICON = { ALLOW: '✓', REVIEW: '!', BLOCK: '✗' };
const RANK = { ALLOW: 0, REVIEW: 1, BLOCK: 2 };
const reports = [];
for (const f of files) {
  const ext = f.split('.').pop().toLowerCase();
  const report = scanBuffer(fs.readFileSync(f), { fileName: path.basename(f), declaredMime: MIME[ext] || '' });
  reports.push({ report, uri: path.relative(process.cwd(), f).split(path.sep).join('/') });
}

if (opt.json) console.log(JSON.stringify(reports.map(r => ({ path: r.uri, ...r.report })), null, 2));
else {
  for (const { report, uri } of reports) {
    console.log(`${ICON[report.verdict]} ${report.verdict.padEnd(6)} ${String(report.score).padStart(3)}  ${uri}`);
    for (const f of report.findings.filter(x => x.severity !== 'info')) {
      console.log(`      ${f.severity.toUpperCase().padEnd(8)} ${f.rule}  ${f.title} — ${f.detail}${f.evidence ? `\n               ↳ ${f.evidence}` : ''}`);
    }
  }
  const n = v => reports.filter(r => r.report.verdict === v).length;
  console.log(`\n${reports.length} file(s): ${n('BLOCK')} block, ${n('REVIEW')} review, ${n('ALLOW')} allow`);
}
if (opt.sarif) { fs.writeFileSync(opt.sarif, JSON.stringify(toSarif(reports), null, 2)); if (!opt.json) console.log(`SARIF → ${opt.sarif}`); }

const floor = opt.failOn === 'none' ? Infinity : RANK[opt.failOn.toUpperCase()];
process.exit(reports.some(r => RANK[r.report.verdict] >= floor) ? 1 : 0);
