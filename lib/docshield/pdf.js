// lib/docshield/pdf.js — PDF structural triage + text extraction, no dependencies.
//
// What it does, in order:
//   1. Walks every "N G obj … endobj" (and objects packed inside /ObjStm streams).
//   2. Decodes streams (Flate, ASCIIHex, ASCII85) under hard size budgets, so a
//      decompression bomb is reported instead of exhausting memory.
//   3. Normalises #hex name escapes (/J#61vaScript → /JavaScript) and records when
//      an escape was used to disguise a dangerous keyword.
//   4. Flags active content: JavaScript, auto-run actions, Launch, embedded files,
//      form submission / XFA / RichMedia, encryption, incremental updates, links.
//   5. Extracts page text through each font's ToUnicode CMap, tracking the graphics
//      state so text a human cannot see (render mode 3, white fill, sub-1pt size,
//      off-page placement) is separated from visible text.
//
// It is a triage parser, not a renderer: it is deliberately tolerant of broken
// files and never executes anything it finds.

import zlib from 'node:zlib';
import { EXEC_EXT } from './filetype.js';

export const PDF_LIMITS = {
  maxObjects: 20000,
  maxStreams: 4000,
  perStreamBytes: 4 * 1024 * 1024,
  totalDecodedBytes: 32 * 1024 * 1024,
  bombRatio: 100,
};

const NAME_ESC_RE = /\/([A-Za-z0-9_.+-]*#[0-9A-Fa-f]{2}[A-Za-z0-9_.+#-]*)/g;
const DANGEROUS_NAMES = new Set(['JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'EmbeddedFile', 'EmbeddedFiles',
  'URI', 'SubmitForm', 'XFA', 'RichMedia', 'GoToR', 'GoToE', 'ImportData', 'Action', 'S']);

const latin1 = buf => buf.toString('latin1');

/* ── name normalisation ──────────────────────────────────────────────────── */
function normaliseNames(dict, obfuscated) {
  return dict.replace(NAME_ESC_RE, (m, body) => {
    const decoded = body.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (DANGEROUS_NAMES.has(decoded)) obfuscated.add(`/${body} → /${decoded}`);
    return '/' + decoded;
  });
}

/* ── stream filters ──────────────────────────────────────────────────────── */
function filtersOf(dict) {
  const m = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
  if (!m) return [];
  return (m[1].match(/\/[A-Za-z0-9]+/g) || []).map(s => s.slice(1));
}

function asciiHex(buf) {
  const s = latin1(buf).replace(/[^0-9A-Fa-f>]/g, '');
  const end = s.indexOf('>');
  const hex = end >= 0 ? s.slice(0, end) : s;
  return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
}

function ascii85(buf) {
  let s = latin1(buf).replace(/\s+/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let v = 0; for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length; while (group.length < 5) group.push(84);
    let v = 0; for (const g of group) v = v * 85 + g;
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Buffer.from(out);
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode', 'DCT', 'CCF']);

/** Decode one stream. Returns { data, skipped?, bomb? } and charges the shared budget. */
function decodeStream(raw, dict, budget) {
  const filters = filtersOf(dict);
  let data = raw;
  for (const f of filters) {
    if (IMAGE_FILTERS.has(f)) return { data: null, skipped: 'image' };
    if (f === 'FlateDecode' || f === 'Fl') {
      const cap = Math.min(PDF_LIMITS.perStreamBytes, Math.max(0, budget.left));
      if (cap <= 0) return { data: null, skipped: 'budget' };
      try {
        data = zlib.inflateSync(data, { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) {
          return { data: null, bomb: { compressed: raw.length, limit: cap } };
        }
        try { data = zlib.inflateRawSync(data, { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
        catch { return { data: null, skipped: 'corrupt' }; }
      }
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
    else return { data: null, skipped: `filter:${f}` };
  }
  budget.left -= data.length;
  return { data };
}

/* ── object walker ───────────────────────────────────────────────────────── */
function walkObjects(src, buf, obfuscated) {
  const objects = new Map();
  const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let m, count = 0;
  while ((m = re.exec(src)) && count < PDF_LIMITS.maxObjects) {
    count++;
    const start = m.index + m[0].length;
    let end = src.indexOf('endobj', start);
    if (end < 0) end = src.length;
    let body = src.slice(start, end);
    let streamRaw = null;
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)[0].length;
      const dictPart = body.slice(0, si);
      let dataEnd = -1;
      const lenM = dictPart.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (lenM) {
        const L = Number(lenM[1]);
        if (dataStart + L <= src.length && /^\s*endstream/.test(src.slice(dataStart + L, dataStart + L + 20))) dataEnd = dataStart + L;
      }
      if (dataEnd < 0) { dataEnd = src.indexOf('endstream', dataStart); if (dataEnd < 0) dataEnd = src.length; }
      streamRaw = buf.subarray(dataStart, dataEnd);
      if (dataEnd > end) { end = src.indexOf('endobj', dataEnd); if (end < 0) end = src.length; }
      body = dictPart;
      re.lastIndex = Math.max(re.lastIndex, end);
    } else {
      re.lastIndex = Math.max(re.lastIndex, end);
    }
    objects.set(Number(m[1]), { num: Number(m[1]), dict: normaliseNames(body, obfuscated), streamRaw, decoded: undefined });
  }
  return objects;
}

function getDecoded(obj, budget, stats) {
  if (obj.decoded !== undefined) return obj.decoded;
  obj.decoded = null;
  if (!obj.streamRaw) return null;
  if (stats.streams >= PDF_LIMITS.maxStreams) { stats.streamsSkipped++; return null; }
  stats.streams++;
  const r = decodeStream(obj.streamRaw, obj.dict, budget);
  if (r.bomb) stats.bombs.push({ obj: obj.num, ...r.bomb });
  if (r.data) { obj.decoded = r.data; stats.decodedBytes += r.data.length; }
  return obj.decoded;
}

function expandObjectStreams(objects, budget, stats, obfuscated) {
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const data = getDecoded(obj, budget, stats);
    if (!data) continue;
    const s = latin1(data);
    const first = Number((obj.dict.match(/\/First\s+(\d+)/) || [])[1]);
    const n = Number((obj.dict.match(/\/N\s+(\d+)/) || [])[1]);
    if (!Number.isFinite(first) || !Number.isFinite(n)) continue;
    const nums = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < Math.min(n, nums.length / 2); i++) {
      const num = nums[2 * i], off = first + nums[2 * i + 1];
      const nextOff = i + 1 < n ? first + nums[2 * i + 3] : s.length;
      if (!objects.has(num)) objects.set(num, { num, dict: normaliseNames(s.slice(off, nextOff), obfuscated), streamRaw: null, decoded: null, inObjStm: obj.num });
    }
  }
}

/* ── PDF string literals ─────────────────────────────────────────────────── */
function readLiteral(s, i) {           // s[i] === '('
  let depth = 1, out = '';
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (n in map) { out += map[n]; i += 2; continue; }
      if (n >= '0' && n <= '7') {
        let oct = n; i += 2;
        while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
        out += String.fromCharCode(parseInt(oct, 8) & 255); continue;
      }
      if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; }
      if (n === '\n') { i += 2; continue; }
      i += 1; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    out += c; i++;
  }
  return { value: out, end: i };
}
function readHex(s, i) {               // s[i] === '<' and s[i+1] !== '<'
  const end = s.indexOf('>', i);
  const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/[^0-9A-Fa-f]/g, '');
  const h = hex.length % 2 ? hex + '0' : hex;
  let out = '';
  for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
  return { value: out, end: end < 0 ? s.length : end + 1 };
}
export function pdfTextString(bytes) {   // PDFDocEncoding or UTF-16BE with BOM
  if (bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  return bytes;
}

/* ── ToUnicode CMaps ─────────────────────────────────────────────────────── */
function utf16beHex(hex) {
  if (hex.length <= 2) return hex ? String.fromCharCode(parseInt(hex, 16)) : '';
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}
function parseCMap(text) {
  const map = new Map();
  let width = 1;
  for (const r of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const h = r[1].match(/<([0-9A-Fa-f]+)>/);
    if (h) width = Math.max(width, h[1].length / 2);
  }
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(p[1], 16), utf16beHex(p[2]));
  }
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(p[1], 16), hi = Math.min(parseInt(p[2], 16), lo + 65535);
      if (p[4] !== undefined) {
        const base = p[4], last = parseInt(base.slice(-4) || base, 16), prefix = base.length > 4 ? utf16beHex(base.slice(0, -4)) : '';
        for (let c = lo; c <= hi; c++) map.set(c, prefix + String.fromCharCode(last + (c - lo)));
      } else {
        const list = [...p[5].matchAll(/<([0-9A-Fa-f]*)>/g)].map(x => utf16beHex(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      }
    }
  }
  return { map, width };
}

function refOf(dict, key) {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
}

function buildFonts(objects, budget, stats) {
  const fonts = new Map();             // resource name → { cmap|null, identity:boolean }
  const fontInfo = num => {
    const f = objects.get(num);
    if (!f) return null;
    let cmap = null;
    const tu = refOf(f.dict, 'ToUnicode');
    if (tu != null && objects.get(tu)) {
      const d = getDecoded(objects.get(tu), budget, stats);
      if (d) cmap = parseCMap(latin1(d));
    }
    return { cmap, identity: /\/Identity-H|\/Identity-V/.test(f.dict) };
  };
  const readPairs = text => {
    for (const p of text.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      if (!fonts.has(p[1])) { const info = fontInfo(Number(p[2])); if (info) fonts.set(p[1], info); }
    }
  };
  for (const obj of objects.values()) {
    const direct = obj.dict.match(/\/Font\s*<<([^<>]*)>>/);
    if (direct) readPairs(direct[1]);
    const ind = obj.dict.match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (ind && objects.get(Number(ind[1]))) readPairs(objects.get(Number(ind[1])).dict);
  }
  return fonts;
}

/* ── content-stream interpreter (text + visibility only) ─────────────────── */
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const isWs = c => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';

function* tokens(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '(') { const r = readLiteral(s, i); i = r.end; yield { t: 'str', v: r.value }; continue; }
    if (c === '<') {
      if (s[i + 1] === '<') { i += 2; yield { t: 'dict<' }; continue; }
      const r = readHex(s, i); i = r.end; yield { t: 'str', v: r.value }; continue;
    }
    if (c === '>' && s[i + 1] === '>') { i += 2; yield { t: 'dict>' }; continue; }
    if (c === '[') { i++; yield { t: '[' }; continue; }
    if (c === ']') { i++; yield { t: ']' }; continue; }
    if (c === '/') { let j = i + 1; while (j < n && !isWs(s[j]) && !DELIM.has(s[j])) j++; yield { t: 'name', v: s.slice(i + 1, j) }; i = j; continue; }
    let j = i;
    while (j < n && !isWs(s[j]) && !DELIM.has(s[j])) j++;
    if (j === i) { i++; continue; }
    const word = s.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { t: 'num', v: parseFloat(word) }; continue; }
    if (word === 'ID') {                // inline image: skip binary data up to EI
      const ei = s.slice(i).search(/\sEI(\s|$)/);
      i = ei < 0 ? n : i + ei + 3;
      continue;
    }
    yield { t: 'op', v: word };
  }
}

function extractText(content, fonts, out) {
  let gs = { fill: 'black', mode: 0, size: 12, font: null, ctmScale: 1, tm: [1, 0, 0, 1, 0, 0] };
  const saved = [];
  const operands = [];
  let arr = null, dictDepth = 0;

  const hiddenReason = () => {
    if (gs.mode === 3 || gs.mode === 7) return 'invisible render mode (Tr 3)';
    const [a, b, c, d, e, f] = gs.tm;
    const eff = Math.abs(gs.size) * Math.sqrt(Math.abs(a * d - b * c)) * gs.ctmScale;
    if (eff < 1) return `microscopic font (${eff.toFixed(2)} pt)`;
    if (e < -1000 || f < -1000 || e > 20000 || f > 20000) return 'placed off the page';
    if (gs.fill === 'white') return 'white text';
    return null;
  };
  const decode = bytes => {
    const f = fonts.get(gs.font);
    if (f?.cmap) {
      const w = f.cmap.width;
      let s = '';
      for (let i = 0; i + w - 1 < bytes.length; i += w) {
        let code = 0; for (let k = 0; k < w; k++) code = (code << 8) | bytes.charCodeAt(i + k);
        s += f.cmap.map.get(code) ?? '';
      }
      return s;
    }
    if (f?.identity) { out.unmapped++; return ''; }
    return bytes.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  };
  const emit = text => {
    if (!text) return;
    const reason = hiddenReason();
    out.segments.push({ text, hidden: reason });
  };
  const setFill = nums => {
    if (nums.length === 1) gs.fill = nums[0] >= 0.95 ? 'white' : 'other';
    else if (nums.length === 3) gs.fill = nums.every(v => v >= 0.95) ? 'white' : 'other';
    else if (nums.length === 4) gs.fill = nums.every(v => v <= 0.05) ? 'white' : 'other';
  };

  for (const tok of tokens(content)) {
    if (tok.t === 'dict<') { dictDepth++; continue; }
    if (tok.t === 'dict>') { dictDepth = Math.max(0, dictDepth - 1); continue; }
    if (dictDepth) continue;
    if (tok.t === '[') { arr = []; continue; }
    if (tok.t === ']') { operands.push({ t: 'arr', v: arr || [] }); arr = null; continue; }
    if (arr && tok.t !== 'op') { arr.push(tok); continue; }
    if (tok.t !== 'op') { operands.push(tok); continue; }
    const op = tok.v;
    const nums = operands.filter(o => o.t === 'num').map(o => o.v);
    switch (op) {
      case 'q': saved.push({ ...gs, tm: [...gs.tm] }); if (saved.length > 256) saved.shift(); break;
      case 'Q': if (saved.length) gs = saved.pop(); break;
      case 'cm': if (nums.length >= 4) gs.ctmScale *= Math.sqrt(Math.abs(nums[0] * nums[3] - nums[1] * nums[2])) || 0; break;
      case 'BT': gs.tm = [1, 0, 0, 1, 0, 0]; break;
      case 'ET': out.segments.push({ text: '\n', hidden: null, sep: true }); break;
      case 'Tf': { const nm = operands.find(o => o.t === 'name'); if (nm) gs.font = nm.v; if (nums.length) gs.size = nums[nums.length - 1]; break; }
      case 'Tr': if (nums.length) gs.mode = nums[0]; break;
      case 'Tm': if (nums.length >= 6) gs.tm = nums.slice(-6); break;
      case 'Td': case 'TD':
        if (nums.length >= 2) {
          gs.tm[4] += nums[0] * gs.tm[0]; gs.tm[5] += nums[1] * gs.tm[3];
          // Horizontal moves are glyph positioning (real spaces are glyphs); only line moves separate.
          if (nums[1] !== 0) out.segments.push({ text: '\n', hidden: null, sep: true });
        }
        break;
      case 'T*': out.segments.push({ text: '\n', hidden: null, sep: true }); break;
      case 'g': case 'rg': case 'k': setFill(nums); break;
      case 'sc': case 'scn': if (nums.length) setFill(nums); break;
      case 'Tj': case "'": case '"': { const s = [...operands].reverse().find(o => o.t === 'str'); if (s) emit(decode(s.v)); if (op !== 'Tj') out.segments.push({ text: '\n', hidden: null, sep: true }); break; }
      case 'TJ': {
        const a = [...operands].reverse().find(o => o.t === 'arr');
        if (a) emit(a.v.map(x => x.t === 'str' ? decode(x.v) : (x.t === 'num' && x.v < -200 ? ' ' : '')).join(''));
        break;
      }
      default: break;
    }
    operands.length = 0;
    if (out.segments.length > 200000) break;
  }
}

/* ── main entry ──────────────────────────────────────────────────────────── */
export function analysePdf(buf) {
  const src = latin1(buf);
  const findings = [];
  const obfuscated = new Set();
  const budget = { left: PDF_LIMITS.totalDecodedBytes };
  const stats = { objects: 0, streams: 0, streamsSkipped: 0, decodedBytes: 0, bombs: [], pages: 0, textChars: 0, hiddenChars: 0, unmappedRuns: 0 };

  const objects = walkObjects(src, buf, obfuscated);
  expandObjectStreams(objects, budget, stats, obfuscated);
  stats.objects = objects.size;
  const trailer = normaliseNames(src.slice(Math.max(0, src.lastIndexOf('trailer'))), obfuscated);
  const dicts = [...objects.values()].map(o => o.dict).join('\n') + '\n' + trailer;

  // ── active content ──
  const has = re => re.test(dicts);
  if (obfuscated.size) findings.push({ rule: 'DS-PDF-006', detail: `Keyword names written with #hex escapes, a classic scanner-evasion trick: ${[...obfuscated].slice(0, 4).join(', ')}.` });

  if (has(/\/(?:JavaScript|JS)(?![A-Za-z0-9])/)) {
    let snippet = '';
    const lit = dicts.match(/\/JS\s*\(/);
    if (lit) snippet = readLiteral(dicts, lit.index + lit[0].length - 1).value;
    else {
      const ref = dicts.match(/\/JS\s+(\d+)\s+\d+\s+R/);
      const o = ref && objects.get(Number(ref[1]));
      const d = o && getDecoded(o, budget, stats);
      if (d) snippet = latin1(d);
    }
    findings.push({ rule: 'DS-PDF-001', detail: 'Document-level or action JavaScript is present; PDF readers can execute it.',
      evidence: snippet ? snippet.replace(/\s+/g, ' ').trim().slice(0, 160) : undefined });
  }
  const autoRun = [];
  if (has(/\/OpenAction(?![A-Za-z])/)) autoRun.push('/OpenAction');
  if (has(/\/AA(?![A-Za-z])/)) autoRun.push('/AA (additional actions)');
  if (autoRun.length) findings.push({ rule: 'DS-PDF-002', detail: `Triggers on open / page events: ${autoRun.join(', ')}.` });
  const js = findings.find(f => f.rule === 'DS-PDF-001');
  if (js && autoRun.length) { js.severity = 'critical'; js.detail = 'JavaScript wired to an automatic trigger — it runs as soon as the document is opened.'; }
  if (has(/\/Launch(?![A-Za-z])/)) {
    const target = (dicts.match(/\/Launch[\s\S]{0,200}?\/F\s*\(([^)]{1,120})\)/) || [])[1];
    findings.push({ rule: 'DS-PDF-003', detail: 'A Launch action can ask the reader to start an external program.', evidence: target ? `target: ${target}` : undefined });
  }
  if (has(/\/EmbeddedFiles?(?![A-Za-z])/)) {
    const names = [...dicts.matchAll(/\/(?:UF|F)\s*\(([^)]{1,200})\)/g)].map(m => pdfTextString(m[1]));
    const risky = names.filter(n => EXEC_EXT.has(n.toLowerCase().split('.').pop()));
    findings.push({ rule: 'DS-PDF-004', detail: `Embedded file attachment(s)${names.length ? `: ${[...new Set(names)].slice(0, 5).join(', ')}` : ''}.` });
    if (risky.length) findings.push({ rule: 'DS-PDF-005', detail: `Attachment with an executable extension: ${[...new Set(risky)].join(', ')}.` });
  }
  const forms = ['SubmitForm', 'XFA', 'RichMedia', 'ImportData', 'GoToR', 'GoToE'].filter(k => has(new RegExp(`/${k}(?![A-Za-z])`)));
  if (forms.length) findings.push({ rule: 'DS-PDF-007', detail: `Interactive features present: ${forms.map(f => '/' + f).join(', ')}.` });
  if (/\/Encrypt(?![A-Za-z])/.test(trailer) || has(/\/Encrypt\s+\d+\s+\d+\s+R/)) findings.push({ rule: 'DS-PDF-008', detail: 'Encrypted streams cannot be decoded without the key, so their content was not inspected.' });

  const eofs = (src.match(/%%EOF/g) || []).length - (has(/\/Linearized/) ? 1 : 0);
  if (eofs > 1) findings.push({ rule: 'DS-PDF-009', detail: `${eofs - 1} incremental update(s) appended after the original save — content can be changed or overlaid after signing.` });

  const uris = [...dicts.matchAll(/\/URI\s*\(([^)]{1,500})\)/g)].map(m => pdfTextString(m[1]));
  if (uris.length) {
    const hosts = [...new Set(uris.map(u => { try { return new URL(u).host; } catch { return u.slice(0, 40); } }))];
    findings.push({ rule: 'DS-PDF-012', detail: `${uris.length} link(s) to ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? ' …' : ''}.` });
  }

  // ── text ──
  const fonts = buildFonts(objects, budget, stats);
  const contentNums = new Set();
  for (const o of objects.values()) {
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(o.dict)) {
      stats.pages++;
      const c = o.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
      if (c) for (const r of c[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentNums.add(Number(r[1]));
    }
    if (/\/Subtype\s*\/Form/.test(o.dict) && o.streamRaw) contentNums.add(o.num);
  }
  if (!contentNums.size) for (const o of objects.values()) if (o.streamRaw && !/\/(Type\s*\/(XObject|ObjStm|XRef|Metadata|EmbeddedFile)|Length1|Subtype\s*\/Image)/.test(o.dict)) contentNums.add(o.num);

  const textOut = { segments: [], unmapped: 0 };
  for (const num of contentNums) {
    const o = objects.get(num);
    const d = o && getDecoded(o, budget, stats);
    if (d) extractText(latin1(d), fonts, textOut);
  }
  stats.unmappedRuns = textOut.unmapped;

  // Decode every remaining non-image stream once (budgeted) so bombs and
  // oversize streams are caught even when nothing references them.
  for (const o of objects.values()) if (o.streamRaw && o.decoded === undefined) getDecoded(o, budget, stats);

  for (const b of stats.bombs) {
    findings.push({ rule: 'DS-PDF-010', detail: `Stream in object ${b.obj} (${b.compressed.toLocaleString()} bytes compressed) inflates past the ${(b.limit / 1048576).toFixed(0)} MB limit — stopped decoding.` });
  }

  const visible = textOut.segments.filter(s => !s.hidden).map(s => s.text).join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const hiddenByReason = {};
  let prev = null;
  for (const s of textOut.segments) {
    if (s.hidden) { hiddenByReason[s.hidden] = (hiddenByReason[s.hidden] || '') + (prev === s.hidden ? '' : ' ') + s.text; prev = s.hidden; }
    else if (!s.sep || s.text === '\n') prev = null;
  }
  const hidden = Object.entries(hiddenByReason).map(([reason, t]) => ({ reason, text: t.replace(/\s+/g, ' ').trim() })).filter(h => h.text);
  stats.textChars = visible.length;
  stats.hiddenChars = hidden.reduce((n, h) => n + h.text.length, 0);

  // Metadata + annotation text: also read by AI pipelines, never seen on the page.
  const meta = [];
  for (const m of dicts.matchAll(/\/(Title|Subject|Keywords|Author|Creator|Producer|Contents|TU|TM)\s*(\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)|<[0-9A-Fa-f\s]+>)/g)) {
    const raw = m[2].startsWith('(') ? readLiteral(m[2], 0).value : readHex(m[2], 0).value;
    const v = pdfTextString(raw).trim();
    if (v) meta.push(`${m[1]}: ${v}`);
  }
  for (const o of objects.values()) {
    if (/\/Type\s*\/Metadata/.test(o.dict)) {
      const d = getDecoded(o, budget, stats);
      if (d) {
        const x = latin1(d).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (x) meta.push(`XMP: ${x.slice(0, 4000)}`);
      }
    }
  }

  return { findings, stats, text: { visible, hidden, metadata: meta.join('\n') } };
}
