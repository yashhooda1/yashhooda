#!/usr/bin/env node
// docshield/eval.js — DocShield vs the site's existing upload filter (lib/fileGuard.js)
// on the same labeled corpus. "Detected" means the gate would not silently pass
// the file: DocShield verdict REVIEW/BLOCK, or fileGuard valid === false.
//
//   node docshield/eval.js            print the scorecard
//   node docshield/eval.js --write    also write public_data_docshield_eval.json (read by the site panel)
//   node docshield/eval.js --check    exit 1 if recall < 0.95 or false-positive rate > 0.15 (CI gate)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS } from '../lib/docshield/fixtures.js';
import { scanBuffer, ENGINE_VERSION } from '../lib/docshield/index.js';
import { validateFile } from '../lib/fileGuard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const rows = [];
for (const c of CORPUS) {
  const { buf, fileName, mime } = c.build();
  const t0 = performance.now();
  const r = scanBuffer(buf, { fileName, declaredMime: mime });
  const ms = performance.now() - t0;
  const fg = validateFile(buf.toString('base64'), mime, fileName);
  rows.push({
    id: c.id, title: c.title, label: c.label, dualUse: !!c.dualUse,
    docshield: { verdict: r.verdict, score: r.score, detected: r.verdict !== 'ALLOW', rules: [...new Set(r.findings.map(f => f.rule))], ms: +ms.toFixed(2) },
    fileguard: { detected: !fg.valid, reason: fg.errors[0] || null },
  });
}

function metrics(key) {
  const mal = rows.filter(r => r.label === 'malicious'), ben = rows.filter(r => r.label === 'benign');
  const tp = mal.filter(r => r[key].detected).length, fp = ben.filter(r => r[key].detected).length;
  return { tp, fn: mal.length - tp, fp, tn: ben.length - fp, recall: +(tp / mal.length).toFixed(3), fpr: +(fp / ben.length).toFixed(3), precision: +(tp / Math.max(1, tp + fp)).toFixed(3) };
}
const ds = metrics('docshield'), fg = metrics('fileguard');
const blocks = rows.filter(r => r.label === 'malicious' && r.docshield.verdict === 'BLOCK').length;
const lat = rows.map(r => r.docshield.ms).sort((a, b) => a - b);
const p = q => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];

const summary = {
  generated: new Date().toISOString(), engine: ENGINE_VERSION,
  corpus: { total: rows.length, malicious: rows.filter(r => r.label === 'malicious').length, benign: rows.filter(r => r.label === 'benign').length },
  docshield: { ...ds, blocked: blocks, latency_ms: { p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1] } },
  fileguard: fg,
  known_false_positives: rows.filter(r => r.label === 'benign' && r.docshield.detected).map(r => ({ id: r.id, title: r.title, dualUse: r.dualUse, rules: r.docshield.rules })),
  cases: rows,
};

const pct = n => `${(n * 100).toFixed(0)}%`;
console.log(`\nDocShield ${ENGINE_VERSION} — ${summary.corpus.malicious} attack + ${summary.corpus.benign} benign documents\n`);
console.log('| gate        | caught | missed | false alarms | recall | FPR  |');
console.log('|-------------|--------|--------|--------------|--------|------|');
console.log(`| DocShield   | ${String(ds.tp).padStart(6)} | ${String(ds.fn).padStart(6)} | ${String(ds.fp).padStart(12)} | ${pct(ds.recall).padStart(6)} | ${pct(ds.fpr).padStart(4)} |`);
console.log(`| fileGuard   | ${String(fg.tp).padStart(6)} | ${String(fg.fn).padStart(6)} | ${String(fg.fp).padStart(12)} | ${pct(fg.recall).padStart(6)} | ${pct(fg.fpr).padStart(4)} |`);
console.log(`\nDocShield blocked ${blocks} outright; latency p50 ${p(0.5)} ms, p95 ${p(0.95)} ms.\n`);
console.log('case'.padEnd(36), 'label'.padEnd(10), 'DocShield'.padEnd(10), 'fileGuard');
for (const r of rows) console.log(r.id.padEnd(36), r.label.padEnd(10), r.docshield.verdict.padEnd(10), r.fileguard.detected ? 'rejected' : 'passed');
if (summary.known_false_positives.length) console.log(`\nKnown false positives: ${summary.known_false_positives.map(f => f.id + (f.dualUse ? ' (dual-use)' : '')).join(', ')}`);

if (args.has('--write')) {
  const out = path.join(root, 'public_data_docshield_eval.json');
  const { cases, ...slim } = summary;
  fs.writeFileSync(out, JSON.stringify({ ...slim, cases: cases.map(c => ({ id: c.id, title: c.title, label: c.label, docshield: c.docshield.verdict, fileguard: c.fileguard.detected ? 'rejected' : 'passed' })) }, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(root, out)}`);
}
if (args.has('--check') && (ds.recall < 0.95 || ds.fpr > 0.15)) {
  console.error(`\nEVAL GATE FAILED: recall ${ds.recall} (min 0.95), FPR ${ds.fpr} (max 0.15)`);
  process.exit(1);
}
