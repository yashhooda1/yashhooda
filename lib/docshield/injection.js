// lib/docshield/injection.js — indirect prompt-injection and text-evasion detection.
//
// Documents fed to an LLM (resumes, invoices, policy PDFs, web pages) are a
// channel for instructions. This module looks for the families of phrasing that
// try to steer the model, and for the Unicode / encoding tricks used to keep
// those instructions away from human eyes. Every regex uses bounded quantifiers
// so input cannot trigger catastrophic backtracking.

const PATTERNS = {
  'DS-PI-001': [
    /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the|system|original)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules|directions|guidelines|directives|context|constraints)\b/i,
    /\b(?:new|updated|real|actual|revised|true)\s+(?:instructions?|system\s+prompt|directives?)\s*[:\-—]/i,
    /\bfrom now on\b[^.\n]{0,40}\byou\s+(?:will|must|should|are|shall)\b/i,
  ],
  'DS-PI-002': [
    /^[ \t]*(?:#{1,3}[ \t]*)?(?:system|developer)[ \t]*(?:prompt|message|instructions?)[ \t]*:/im,
    /^[ \t]*(?:system|assistant|developer)[ \t]*:[ \t]*(?:you\b|ignore\b|disregard\b|from now\b|new\b|always\b|never\b|do not\b|important\b)/im,
    /<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|start_header_id|end_header_id|eot_id)\|>/i,
    /\[\/?(?:INST|SYS)\]|<<\/?SYS>>/,
    /<\/?(?:system|system_prompt|instructions|admin_instructions)>/i,
    /\b(?:END|BEGIN)\s+(?:OF\s+)?(?:SYSTEM\s+PROMPT|USER\s+INPUT|UNTRUSTED\s+CONTENT)\b/,
  ],
  'DS-PI-003': [
    /\b(?:note|message|instructions?|attention|reminder)\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:ai|a\.i\.|llm|assistant|model|chatbot|language model|gpt|chatgpt|claude|gemini|copilot|agent|extractor|summari[sz]er|screening (?:bot|tool|system))s?\b/i,
    /\bif you are (?:an?\s+)?(?:ai|llm|large language model|language model|assistant|chatbot|automated (?:system|screener|tool)|bot)\b/i,
    /\b(?:ai|llm|language model|assistant)s?\s+(?:reading|processing|summari[sz]ing|parsing|analy[sz]ing|reviewing)\s+this\b/i,
    /\bwhen (?:summari[sz]ing|processing|extracting|reading|analy[sz]ing|reviewing|parsing) this (?:document|file|page|resume|cv|text|email|pdf|invoice|policy)\b[^.\n]{0,60}\b(?:you|always|must|should|say|state|output|include|ignore|respond)\b/i,
  ],
  'DS-PI-004': [
    /\byou are (?:now|no longer)\b/i,
    /\b(?:act|behave|respond)\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil)\b/i,
    /\bDAN\s+mode\b|\bdo anything now\b/i,
    /\b(?:developer|god|sudo|jailbreak|unrestricted)\s+mode\b/i,
    /\bwithout (?:any\s+)?(?:restrictions|filters|guardrails|safety (?:rules|guidelines))\b/i,
  ],
  'DS-PI-005': [
    // markdown / HTML image whose query string carries a template slot or a data-ish key
    /!\[[^\]\n]{0,100}\]\(\s*https?:\/\/[^)\s?]{1,300}\?[^)\s]{0,200}?(?:[{[<$]|%7B|%5B|\b(?:data|d|q|c|exfil|leak|secret|history|chat|prompt|conv|msg|payload|summary|creds?)=)[^)\s]{0,300}\)/i,
    /<img\b[^>]{0,200}\bsrc\s*=\s*["']?https?:\/\/[^"'\s>?]{1,300}\?[^"'\s>]{0,200}?(?:[{[<$]|%7B|\b(?:data|d|q|exfil|leak|secret|history|chat|prompt|payload|creds?)=)/i,
    /\b(?:send|post|forward|upload|transmit|exfiltrate|leak|email)\b[^.\n]{0,60}\b(?:conversation|chat history|system prompt|credentials|api keys?|passwords?|user data|previous messages|the user'?s)\b[^.\n]{0,60}\b(?:to|at)\b[^.\n]{0,20}(?:https?:\/\/|[\w.+-]+@[\w-]+\.)/i,
    /\b(?:append|include|encode|embed)\b[^.\n]{0,60}\b(?:in|into|to)\s+(?:the\s+|a\s+)?(?:url|link|query string|image (?:url|link)|markdown image)\b/i,
  ],
  'DS-PI-006': [
    /\b(?:do not|don't|never|without)\s+(?:tell(?:ing)?|mention(?:ing)?|reveal(?:ing)?|disclos(?:e|ing)|inform(?:ing)?|alert(?:ing)?|notify(?:ing)?|let(?:ting)?)\b[^.\n]{0,40}\b(?:the\s+)?(?:user|human|reader|reviewer|recruiter|operator)\b/i,
    /\b(?:secretly|silently|quietly|covertly)\s+(?:send|forward|add|change|include|execute|run|approve|transfer|delete|insert)\b/i,
  ],
  'DS-PI-007': [
    /\b(?:reveal|print|output|repeat|show|display|disclose|leak|return)\b[^.\n]{0,30}\b(?:your|the)\s+(?:system\s+prompt|initial\s+(?:prompt|instructions)|hidden\s+(?:prompt|instructions)|original\s+instructions|instructions\s+above)\b/i,
  ],
  'DS-PI-008': [
    /\b(?:report|record|extract|output|return|set|list|enter|classify|mark|score|rate|label)\b[^.\n]{0,40}\b(?:total|amount|premium|balance|price|value|status|score|rating|result|candidate|applicant|claim|invoice|policy|field|verdict|decision)\b[^.\n]{0,30}\b(?:as|to)\s+(?:be\s+)?(?:\$?\d|approved|valid|paid|qualified|highly qualified|a perfect|perfect|excellent|top|10\/10|100%|zero|none|n\/a|accepted|legitimate|safe|clean|benign)/i,
    /\b(?:recommend|rank|shortlist|advance|hire)\s+(?:this|the)\s+(?:candidate|applicant)\b[^.\n]{0,40}\b(?:immediately|first|highest|regardless|above all|without)\b/i,
  ],
  'DS-PI-009': [
    /\b(?:call|invoke|use|run|execute|trigger)\b[^.\n]{0,40}\b(?:tool|function|plugin|command|action|browser|terminal|shell)\b[^.\n]{0,60}\b(?:delete|remove|transfer|wire|pay|purchase|buy|approve|grant|download|install|exfiltrate|rm -rf)\b[^.\n]{0,60}\b(?:immediately|right now|without (?:asking|confirmation|approval|telling)|silently|automatically|before (?:responding|answering|replying))\b/i,
    /\b(?:transfer|wire|send)\s+(?:\$?\d[\d,.]*|all|the)\s*(?:funds|money|usd|dollars|bitcoin|btc|eth|crypto)\b/i,
  ],
};
export const PI_RULES = Object.keys(PATTERNS);

const ZW_RE = /[​‌‍⁠᠎]/g;
const ZW_IN_WORD_RE = /[\p{L}\p{N}][​‌‍⁠᠎﻿]+[\p{L}\p{N}]/gu;
const BIDI_RE = /[‪-‮⁦-⁩]/g;
const TAG_RE = /[\u{E0000}-\u{E007F}]/gu;
const B64_RE = /[A-Za-z0-9+/]{40,4000}={0,2}/g;
const CONFUSABLE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'Ο': 'O', 'Α': 'A' };
const MIXED_WORD_RE = /(?<!\p{L})(?=\p{L}{0,40}\p{Script=Latin})(?=\p{L}{0,40}[\p{Script=Cyrillic}\p{Script=Greek}])\p{L}{3,40}(?!\p{L})/gu;

function snippet(text, index, len) {
  const a = Math.max(0, index - 40), b = Math.min(text.length, index + len + 40);
  return ((a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : '')).replace(/\s+/g, ' ').trim().slice(0, 200);
}
const lineOf = (text, index) => { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

/** Run the phrase families over one string. Returns [{ rule, index, match }]. */
export function matchInjection(text) {
  const hits = [];
  for (const [rule, list] of Object.entries(PATTERNS)) {
    for (const re of list) {
      const m = re.exec(text);
      if (m) { hits.push({ rule, index: m.index, match: m[0] }); break; }
    }
  }
  return hits;
}

/**
 * Scan one text source.
 * @param {string} raw    text as extracted
 * @param {object} o      { source: 'text'|'page-text'|'hidden-text'|'metadata', hidden?: boolean, reason?: string }
 */
export function scanTextSource(raw, { source = 'text', hidden = false, reason = '' } = {}) {
  const findings = [];
  if (!raw) return findings;
  const text = raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw;

  // ── Unicode evasion ──
  const tags = text.match(TAG_RE);
  let tagDecoded = '';
  if (tags) {
    tagDecoded = tags.map(c => { const cp = c.codePointAt(0) - 0xE0000; return cp >= 0x20 && cp <= 0x7E ? String.fromCharCode(cp) : ''; }).join('');
    findings.push({ rule: 'DS-UNI-001', source, detail: `${tags.length} invisible Unicode tag characters decode to ASCII text.`,
      evidence: tagDecoded ? `decoded: "${tagDecoded.slice(0, 160)}"` : undefined });
  }
  const zwInWords = text.match(ZW_IN_WORD_RE);
  if (zwInWords && zwInWords.length >= 3) {
    findings.push({ rule: 'DS-UNI-002', source, detail: `${zwInWords.length} zero-width characters inside words — splits keywords so filters miss them.` });
  }
  const bidi = text.match(BIDI_RE);
  if (bidi) findings.push({ rule: 'DS-UNI-003', source, detail: `${bidi.length} bidirectional override/isolate characters can make text display differently from how it is processed.` });
  const mixed = [...new Set(text.match(MIXED_WORD_RE) || [])];
  if (mixed.length) findings.push({ rule: 'DS-UNI-004', source, detail: `${mixed.length} word(s) mix Latin with Cyrillic/Greek look-alike letters.`, evidence: mixed.slice(0, 5).join(', ') });

  // Normalised view: what a model effectively reads.
  let norm = text.normalize('NFKC').replace(TAG_RE, '').replace(ZW_RE, '').replace(/﻿/g, '').replace(BIDI_RE, '');
  if (mixed.length) norm = norm.replace(/[Ͱ-ϿЀ-ӿ]/g, c => CONFUSABLE[c] || c);

  const rawHits = new Set(matchInjection(text).map(h => h.rule));
  const hits = matchInjection(norm);
  const evadedOnly = hits.filter(h => !rawHits.has(h.rule));
  for (const h of hits) {
    findings.push({ rule: h.rule, source, detail: hidden ? `Found in ${source}${reason ? ` (${reason})` : ''}.` : `Found in ${source}.`,
      evidence: snippet(norm, h.index, h.match.length), line: lineOf(norm, h.index) });
  }
  if (tagDecoded) {
    for (const h of matchInjection(tagDecoded)) {
      findings.push({ rule: h.rule, source: `${source}:unicode-tags`, detail: 'Found inside invisible Unicode tag characters.', evidence: snippet(tagDecoded, h.index, h.match.length) });
    }
  }

  // Base64 blobs that decode to instructions.
  let blobs = 0;
  for (const m of norm.matchAll(B64_RE)) {
    if (++blobs > 50) break;
    let dec;
    try { dec = Buffer.from(m[0], 'base64').toString('utf8'); } catch { continue; }
    const printable = dec.replace(/[^\x20-\x7E\n\r\t]/g, '').length / Math.max(1, dec.length);
    if (dec.length < 20 || printable < 0.9) continue;
    const inner = matchInjection(dec);
    if (inner.length) {
      findings.push({ rule: 'DS-UNI-005', source, detail: `A base64 string decodes to instructions (${inner.map(i => i.rule).join(', ')}).`, evidence: `decoded: "${dec.slice(0, 160).replace(/\s+/g, ' ')}"`, line: lineOf(norm, m.index) });
    }
  }

  // Escalate: an injection a human reviewer cannot see is the attack, not an accident.
  const piHits = findings.filter(f => f.rule.startsWith('DS-PI-'));
  if (piHits.length && (hidden || tagDecoded || evadedOnly.length || findings.some(f => f.rule === 'DS-UNI-005'))) {
    const how = hidden ? (reason || source) : tagDecoded ? 'invisible Unicode tags' : evadedOnly.length ? 'zero-width / homoglyph obfuscation' : 'base64 encoding';
    findings.push({ rule: 'DS-PI-010', source, detail: `Prompt-injection text is concealed from human readers via ${how}.`, evidence: piHits[0].evidence });
  } else if (findings.some(f => f.rule === 'DS-UNI-005')) {
    findings.push({ rule: 'DS-PI-010', source, detail: 'Prompt-injection text is concealed via base64 encoding.' });
  }
  return findings;
}
