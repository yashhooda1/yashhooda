// lib/docshield/index.js — DocShield: a pre-ingestion security gate for AI document pipelines.
//
//   import { scanBuffer, scanText } from './lib/docshield/index.js';
//   const report = scanBuffer(buf, { fileName: 'policy.pdf', declaredMime: 'application/pdf' });
//   report.verdict  → 'ALLOW' | 'REVIEW' | 'BLOCK'
//
// Pipeline:  bytes → file-type/polyglot check → (PDF) structure + text layers
//            → prompt-injection + Unicode evasion → secrets + PII → score → verdict
//
// Pure function of its input: no network, no disk, no model call, no state.
// That is what lets the same engine run in a Vercel function, a CLI, CI and tests.

import { createHash } from 'node:crypto';
import { checkFileType } from './filetype.js';
import { analysePdf } from './pdf.js';
import { scanTextSource } from './injection.js';
import { scanSecrets } from './secrets.js';
import { RULES, SEVERITY_POINTS, SEVERITY_ORDER, mappingsFor } from './rules.js';

export const ENGINE_VERSION = '1.0.0';
export const MAX_BYTES = 10 * 1024 * 1024;
export const THRESHOLDS = { block: 60, review: 12 };

function finalise(raw, extra = {}) {
  // Merge duplicates (same rule + source), keep the first evidence.
  const byKey = new Map();
  for (const f of raw) {
    const key = `${f.rule}|${f.source || 'file'}`;
    if (byKey.has(key)) { byKey.get(key).count++; continue; }
    const r = RULES[f.rule];
    if (!r) continue;
    byKey.set(key, {
      rule: f.rule, title: r.title, severity: f.severity || r.severity, category: r.category,
      source: f.source || 'file', detail: f.detail, evidence: f.evidence, line: f.line, count: 1,
      mappings: mappingsFor(f.rule),
    });
  }
  const findings = [...byKey.values()].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  // Score: full points for the first finding of a rule, half for repeats from other sources.
  const ruleSeen = new Set();
  let score = 0;
  for (const f of findings) { const p = SEVERITY_POINTS[f.severity] || 0; score += ruleSeen.has(f.rule) ? p / 2 : p; ruleSeen.add(f.rule); }
  score = Math.min(100, Math.round(score));
  const hasCritical = findings.some(f => f.severity === 'critical');
  const verdict = hasCritical || score >= THRESHOLDS.block ? 'BLOCK' : score >= THRESHOLDS.review ? 'REVIEW' : 'ALLOW';

  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, findings.filter(f => f.severity === s).length]));
  const frameworks = {
    owasp: [...new Set(findings.flatMap(f => f.mappings.owasp))],
    attack: [...new Set(findings.flatMap(f => f.mappings.attack))],
    atlas: [...new Set(findings.flatMap(f => f.mappings.atlas))],
    cwe: [...new Set(findings.flatMap(f => f.mappings.cwe))],
  };
  return { schema: 'docshield/report@1', engine: ENGINE_VERSION, verdict, score, counts, findings, frameworks, ...extra };
}

function textFindings(sources) {
  const out = [];
  for (const s of sources) {
    if (!s.text) continue;
    out.push(...scanTextSource(s.text, s));
    out.push(...scanSecrets(s.text, s));
  }
  return out;
}

export function scanText(text, { name = 'pasted-text' } = {}) {
  const t0 = performance.now();
  const str = String(text ?? '');
  const findings = textFindings([{ source: 'text', text: str }]);
  return finalise(findings, {
    file: { name, size: Buffer.byteLength(str), sha256: createHash('sha256').update(str).digest('hex'), type: 'text', declared: 'text/plain' },
    stats: { textChars: str.length },
    limitations: [],
    elapsed_ms: Math.round(performance.now() - t0),
  });
}

export function scanBuffer(input, { fileName = '', declaredMime = '' } = {}) {
  const t0 = performance.now();
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const file = { name: fileName || 'upload', size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), declared: declaredMime || null };
  if (buf.length > MAX_BYTES) {
    return finalise([{ rule: 'DS-PDF-010', detail: `File is ${(buf.length / 1048576).toFixed(1)} MB; the scanner limit is ${MAX_BYTES / 1048576} MB.` }],
      { file, stats: {}, limitations: ['File exceeded the size limit and was not parsed.'], elapsed_ms: 0 });
  }

  const ft = checkFileType(buf, { fileName, declaredMime });
  file.type = ft.sniffed.type;
  file.mime = ft.sniffed.mime;
  const raw = [...ft.findings];
  const limitations = [];
  let stats = {};

  if (ft.sniffed.type === 'pdf') {
    const pdf = analysePdf(buf);
    raw.push(...pdf.findings);
    stats = pdf.stats;
    const sources = [{ source: 'page-text', text: pdf.text.visible }];
    for (const h of pdf.text.hidden) {
      const lowConfidence = h.reason === 'white text';     // white-on-dark headings are legitimate design
      raw.push({ rule: 'DS-PDF-011', source: 'hidden-text', severity: lowConfidence ? 'low' : undefined,
        detail: `${h.text.length} characters of ${h.reason}${lowConfidence ? ' (could be white-on-dark design; confirm visually)' : ''}.`,
        evidence: h.text.slice(0, 160) });
      sources.push({ source: 'hidden-text', text: h.text, hidden: true, reason: h.reason });
    }
    if (pdf.text.metadata) sources.push({ source: 'metadata', text: pdf.text.metadata, hidden: true, reason: 'document metadata / annotations' });
    raw.push(...textFindings(sources));
    if (pdf.stats.unmappedRuns) limitations.push(`${pdf.stats.unmappedRuns} text run(s) used fonts without a Unicode map and could not be read.`);
    if (pdf.stats.streamsSkipped) limitations.push(`${pdf.stats.streamsSkipped} stream(s) skipped after the stream limit.`);
    if (!pdf.text.visible && !pdf.text.hidden.length && pdf.stats.pages) limitations.push('No extractable text — likely a scanned image. OCR is out of scope; treat the content as unverified.');
  } else if (ft.sniffed.type === 'text' || ft.sniffed.type === 'html' || ft.sniffed.type === 'svg') {
    const text = buf.toString('utf8');
    raw.push(...textFindings([{ source: ft.sniffed.type === 'text' ? 'text' : ft.sniffed.type, text }]));
    stats = { textChars: text.length };
  } else if (!ft.sniffed.exec) {
    limitations.push(`${ft.sniffed.type} content is checked for type and polyglot tricks only; its contents are not parsed.`);
  }

  return finalise(raw, { file, stats, limitations, elapsed_ms: Math.round(performance.now() - t0) });
}

export { toSarif } from './sarif.js';
export { RULES } from './rules.js';
