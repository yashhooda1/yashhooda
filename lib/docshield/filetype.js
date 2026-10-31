// lib/docshield/filetype.js — trust the bytes, not the label.
// Sniffs magic numbers, compares them with the declared MIME type and file
// extension, and looks for a second format hidden inside the first (polyglots).

const SIGS = [
  { type: 'pdf',  mime: 'application/pdf', test: b => indexOfAscii(b, '%PDF-', 0, 1024) >= 0 },
  { type: 'zip',  mime: 'application/zip', test: b => starts(b, [0x50, 0x4b, 0x03, 0x04]) },
  { type: 'pe',   mime: 'application/x-msdownload', exec: true, test: b => starts(b, [0x4d, 0x5a]) },
  { type: 'elf',  mime: 'application/x-elf', exec: true, test: b => starts(b, [0x7f, 0x45, 0x4c, 0x46]) },
  { type: 'macho', mime: 'application/x-mach-binary', exec: true,
    test: b => [[0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some(s => starts(b, s)) },
  { type: 'png',  mime: 'image/png',  test: b => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'jpeg', mime: 'image/jpeg', test: b => starts(b, [0xff, 0xd8, 0xff]) },
  { type: 'gif',  mime: 'image/gif',  test: b => indexOfAscii(b, 'GIF8', 0, 4) === 0 },
  { type: 'webp', mime: 'image/webp', test: b => indexOfAscii(b, 'RIFF', 0, 4) === 0 && indexOfAscii(b, 'WEBP', 8, 12) === 8 },
  { type: 'ole',  mime: 'application/x-ole-storage', test: b => starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  { type: 'rtf',  mime: 'application/rtf', test: b => indexOfAscii(b, '{\\rtf', 0, 5) === 0 },
  { type: 'script', mime: 'text/x-script', exec: true, test: b => indexOfAscii(b, '#!', 0, 2) === 0 },
];

const EXT_TYPE = {
  pdf: 'pdf', zip: 'zip', png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp',
  txt: 'text', csv: 'text', md: 'text', json: 'text', xml: 'text', log: 'text',
  html: 'html', htm: 'html', svg: 'svg', rtf: 'rtf', doc: 'ole', xls: 'ole', ppt: 'ole',
  docx: 'zip', xlsx: 'zip', pptx: 'zip',
};
const MIME_TYPE = {
  'application/pdf': 'pdf', 'application/zip': 'zip', 'image/png': 'png', 'image/jpeg': 'jpeg',
  'image/gif': 'gif', 'image/webp': 'webp', 'text/plain': 'text', 'text/csv': 'text',
  'text/markdown': 'text', 'application/json': 'text', 'text/html': 'html', 'image/svg+xml': 'svg',
  'application/rtf': 'rtf',
};
const EXEC_EXT = new Set(['exe', 'dll', 'scr', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf',
  'hta', 'msi', 'jar', 'lnk', 'sh', 'app', 'dmg', 'pkg', 'apk', 'iso', 'cpl', 'reg']);
const BIDI_RE = /[‪-‮⁦-⁩]/;

function starts(b, sig) { if (b.length < sig.length) return false; for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false; return true; }
function indexOfAscii(b, s, from = 0, to = b.length) {
  const end = Math.min(to, b.length) - s.length;
  outer: for (let i = from; i <= end; i++) { for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer; return i; }
  return -1;
}

export function looksLikeText(buf) {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return true;
  let ctrl = 0;
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) ctrl++; }
  if (ctrl / n > 0.02) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n - (n === 8192 ? 4 : 0))); return true; } catch { return false; }
}

export function sniff(buf) {
  for (const s of SIGS) if (s.test(buf)) return { type: s.type, mime: s.mime, exec: !!s.exec };
  if (looksLikeText(buf)) {
    const head = new TextDecoder().decode(buf.subarray(0, 512)).trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { type: 'svg', mime: 'image/svg+xml', exec: false };
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<script[\s>]/.test(head)) return { type: 'html', mime: 'text/html', exec: false };
    return { type: 'text', mime: 'text/plain', exec: false };
  }
  return { type: 'unknown', mime: 'application/octet-stream', exec: false };
}

/** Returns { sniffed, findings[] }. */
export function checkFileType(buf, { fileName = '', declaredMime = '' } = {}) {
  const findings = [];
  const sniffed = sniff(buf);
  const name = String(fileName || '');
  const parts = name.toLowerCase().split('.');
  const ext = parts.length > 1 ? parts.pop() : '';
  const declared = String(declaredMime || '').toLowerCase().split(';')[0].trim();

  if (sniffed.exec) {
    findings.push({ rule: 'DS-FT-002', detail: `Bytes are a ${sniffed.type.toUpperCase()} executable/script${name ? ` but the file is named "${name}"` : ''}.` });
  }

  const extType = EXT_TYPE[ext], mimeType = MIME_TYPE[declared];
  const mismatch = [];
  if (extType && extType !== sniffed.type && !(extType === 'text' && sniffed.type === 'text')) mismatch.push(`extension .${ext}`);
  if (mimeType && mimeType !== sniffed.type) mismatch.push(`declared type ${declared}`);
  if (mismatch.length && !sniffed.exec) {
    findings.push({ rule: 'DS-FT-001', detail: `Content is ${sniffed.type} but ${mismatch.join(' and ')} say otherwise.` });
  }

  // Double extension (invoice.pdf.exe) or an executable final extension; RTL override in the name.
  if (EXEC_EXT.has(ext) && parts.length >= 2 && EXT_TYPE[parts[parts.length - 1]]) {
    findings.push({ rule: 'DS-FT-004', detail: `Filename "${name}" hides an executable .${ext} behind a document extension.` });
  } else if (BIDI_RE.test(name)) {
    findings.push({ rule: 'DS-FT-004', detail: 'Filename contains a right-to-left override character that can disguise the real extension.' });
  }

  if (sniffed.type === 'html' || sniffed.type === 'svg') {
    findings.push({ rule: 'DS-FT-005', detail: `${sniffed.type.toUpperCase()} can carry script that runs when the file is rendered.` });
  }

  // Polyglots: a PDF whose header is not at byte 0, or another format's magic after %%EOF.
  if (sniffed.type === 'pdf') {
    const at = indexOfAscii(buf, '%PDF-', 0, 1024);
    if (at > 0) findings.push({ rule: 'DS-FT-003', detail: `PDF header starts at byte ${at}, not 0 — the leading bytes can be read as another format.` });
    const eof = lastIndexOfAscii(buf, '%%EOF');
    if (eof >= 0) {
      const tail = buf.subarray(eof + 5);
      const inner = tail.length > 16 ? embeddedMagic(tail) : null;
      if (inner) findings.push({ rule: 'DS-FT-003', detail: `${tail.length} bytes after the final %%EOF contain ${inner} data.` });
    }
  }
  return { sniffed, ext, findings };
}

function lastIndexOfAscii(b, s) {
  for (let i = b.length - s.length; i >= 0; i--) { let ok = true; for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) { ok = false; break; } if (ok) return i; }
  return -1;
}
function embeddedMagic(tail) {
  if (indexOfAscii(tail, 'PK\u0003\u0004') >= 0) return 'ZIP';
  const mz = indexOfAscii(tail, 'MZ');
  if (mz >= 0 && indexOfAscii(tail, 'This program cannot be run', mz, mz + 512) >= 0) return 'Windows executable';
  if (indexOfAscii(tail, '\u007fELF') >= 0) return 'ELF executable';
  if (indexOfAscii(tail, '<script') >= 0 || indexOfAscii(tail, '<html') >= 0) return 'HTML/script';
  return null;
}

export { EXEC_EXT };
