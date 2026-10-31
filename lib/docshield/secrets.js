// lib/docshield/secrets.js — credentials and personal data that should never
// reach a model, a vector index or a log. Evidence is always redacted: the
// report shows enough to find the value, never enough to use it.

const SECRET_PATTERNS = [
  { rule: 'DS-SEC-001', name: 'AWS access key ID',     re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'DS-SEC-001', name: 'GitHub token',          re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { rule: 'DS-SEC-001', name: 'Slack token',           re: /\bxox[baprs]-[A-Za-z0-9-]{10,200}\b/g },
  { rule: 'DS-SEC-001', name: 'Stripe live key',       re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,200}\b/g },
  { rule: 'DS-SEC-001', name: 'Anthropic API key',     re: /\bsk-ant-[A-Za-z0-9_-]{20,300}/g },
  { rule: 'DS-SEC-001', name: 'OpenAI API key',        re: /\bsk-(?:proj-|svcacct-)?(?!ant-)[A-Za-z0-9_-]{32,300}/g },
  { rule: 'DS-SEC-001', name: 'Google API key',        re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: 'DS-SEC-001', name: 'Azure storage key',     re: /\bAccountKey=[A-Za-z0-9+/]{40,120}={0,2}/g },
  { rule: 'DS-SEC-002', name: 'Private key block',     re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { rule: 'DS-SEC-003', name: 'Connection string',     re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^:\s/@]{1,100}:[^@\s]{3,200}@[^\s]{1,200}/gi },
  { rule: 'DS-SEC-004', name: 'JSON Web Token',        re: /\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}/g },
];
const ASSIGN_RE = /\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?([^\s"'<>,;]{8,200})/gi;
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
const PHONE_RE = /(?<!\d)(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g;

export function redact(v) {
  const s = String(v);
  if (s.length <= 8) return s[0] + '•'.repeat(Math.max(1, s.length - 1));
  return s.slice(0, 4) + '•'.repeat(Math.min(12, s.length - 6)) + s.slice(-2);
}

export function luhn(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
const cardBrand = d => /^4/.test(d) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(d) ? 'Mastercard' : /^3[47]/.test(d) ? 'Amex' : /^6(011|5)/.test(d) ? 'Discover' : null;

export function entropy(s) {
  const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0; for (const k in f) { const p = f[k] / s.length; h -= p * Math.log2(p); }
  return h;
}
const lineOf = (text, index) => { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

export function scanSecrets(text, { source = 'text' } = {}) {
  const findings = [];
  if (!text) return findings;
  const t = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  const seen = new Set();

  for (const p of SECRET_PATTERNS) {
    const vals = [];
    for (const m of t.matchAll(p.re)) { if (!seen.has(m[0])) { seen.add(m[0]); vals.push(m); } if (vals.length >= 20) break; }
    if (vals.length) findings.push({ rule: p.rule, source, detail: `${vals.length} × ${p.name}.`, evidence: vals.slice(0, 3).map(m => redact(m[0])).join(', '), line: lineOf(t, vals[0].index) });
  }
  const assigned = [];
  for (const m of t.matchAll(ASSIGN_RE)) {
    const v = m[1];
    if (seen.has(v) || [...seen].some(s => s.includes(v) || v.includes(s))) continue;
    if (entropy(v) >= 3.3 && /\d/.test(v) && /[A-Za-z]/.test(v)) assigned.push(m);
    if (assigned.length >= 20) break;
  }
  if (assigned.length) findings.push({ rule: 'DS-SEC-005', source, detail: `${assigned.length} credential-like value(s) assigned to password/key fields.`, evidence: assigned.slice(0, 3).map(m => redact(m[1])).join(', '), line: lineOf(t, assigned[0].index) });

  const ssns = [...t.matchAll(SSN_RE)];
  if (ssns.length) findings.push({ rule: 'DS-PII-001', source, detail: `${ssns.length} Social Security number pattern(s).`, evidence: ssns.slice(0, 3).map(m => '•••-••-' + m[0].slice(-4)).join(', '), line: lineOf(t, ssns[0].index) });

  const cards = [];
  for (const m of t.matchAll(CARD_RE)) {
    const d = m[0].replace(/[ -]/g, '');
    if (d.length >= 13 && d.length <= 19 && cardBrand(d) && luhn(d)) cards.push({ m, d });
    if (cards.length >= 20) break;
  }
  if (cards.length) findings.push({ rule: 'DS-PII-002', source, detail: `${cards.length} Luhn-valid ${[...new Set(cards.map(c => cardBrand(c.d)))].join('/')} card number(s).`, evidence: cards.slice(0, 3).map(c => '•••• ' + c.d.slice(-4)).join(', '), line: lineOf(t, cards[0].m.index) });

  const emails = new Set((t.match(EMAIL_RE) || []).map(e => e.toLowerCase()));
  const phones = new Set(t.match(PHONE_RE) || []);
  if (emails.size || phones.size) findings.push({ rule: 'DS-PII-003', source, detail: `${emails.size} email address(es), ${phones.size} phone number(s) — fine for a resume, worth knowing before indexing.` });
  return findings;
}
