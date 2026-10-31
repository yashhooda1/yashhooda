// api/docshield.js — ES Module ("type":"module" in package.json)
// ══════════════════════════════════════════════════════════════════════════════
// DOCSHIELD — pre-ingestion security scan for documents headed to an LLM.
//
//   POST /api/docshield
//     { fileName, mimeType, data: <base64> }   scan an upload (≤ 2 MB)
//     { text }                                 scan pasted text (≤ 200k chars)
//     { sample: "<corpus id>" }                scan a built-in demo document
//     + format?: "sarif"                       also return SARIF 2.1.0
//   → docshield/report@1 { verdict, score, counts, findings[], frameworks, file, stats, limitations }
//
// Gating (site security rules):
//   • gate(): origin check + kill switch "docshield". auth 'none' — no paid API
//     is called; the engine is deterministic, in-process and free to run.
//   • rateLimit(): per-IP minute/hour + global daily cap
//   • size checked on the base64 length BEFORE decoding
//   • nothing is stored; logs carry only a hash prefix, size, type and verdict
// Kill switch: SET killswitch:docshield on   (or DOCSHIELD_OFF=1)
// ══════════════════════════════════════════════════════════════════════════════
import { gate }      from '../lib/gateway.js';
import { rateLimit } from '../lib/rateLimit.js';
import { scanBuffer, scanText, toSarif } from '../lib/docshield/index.js';
import { getCase, SAMPLE_IDS } from '../lib/docshield/fixtures.js';

export const maxDuration = 15;

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_B64 = Math.ceil(MAX_BYTES / 3) * 4 + 4;
const MAX_TEXT = 200_000;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const clean = s => String(s || '').replace(/[\x00-\x1f]/g, '').slice(0, 200);

export default async function handler(req, res) {
    const g = await gate(req, res, { endpoint: 'docshield', methods: ['POST'], auth: 'none' });
    if (!g.ok) return;

    const allowed = await rateLimit(req, res, { endpoint: 'docshield', maxPerMinute: 8, maxPerHour: 60, maxDailyGlobal: 3000 });
    if (!allowed) return;

    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    let report;

    try {
        if (body.sample) {
            const c = SAMPLE_IDS.includes(body.sample) ? getCase(body.sample) : null;
            if (!c) return res.status(400).json({ error: 'bad_sample', message: `Unknown sample. Try one of: ${SAMPLE_IDS.join(', ')}` });
            const { buf, fileName, mime } = c.build();
            report = scanBuffer(buf, { fileName, declaredMime: mime });
            report.sample = { id: c.id, title: c.title, label: c.label };
        } else if (typeof body.data === 'string') {
            const b64 = body.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
            if (b64.length > MAX_B64) return res.status(413).json({ error: 'too_large', message: 'Files up to 2 MB, please.' });
            if (!B64_RE.test(b64)) return res.status(400).json({ error: 'bad_data', message: 'File data must be base64.' });
            const buf = Buffer.from(b64, 'base64');
            if (!buf.length) return res.status(400).json({ error: 'empty', message: 'That file is empty.' });
            report = scanBuffer(buf, { fileName: clean(body.fileName) || 'upload', declaredMime: clean(body.mimeType) });
        } else if (typeof body.text === 'string') {
            if (!body.text.trim()) return res.status(400).json({ error: 'empty', message: 'Paste some text first.' });
            if (body.text.length > MAX_TEXT) return res.status(413).json({ error: 'too_large', message: 'Text up to 200,000 characters, please.' });
            report = scanText(body.text);
        } else {
            return res.status(400).json({ error: 'bad_request', message: 'Send { data, fileName, mimeType }, { text } or { sample }.' });
        }
    } catch (e) {
        console.error('[docshield] scan failed:', e.message);
        return res.status(500).json({ error: 'scan_failed', message: 'The scanner hit an unexpected error on this input.' });
    }

    console.log(`[docshield] ${report.file?.sha256?.slice(0, 12)} ${report.file?.type} ${report.file?.size}B → ${report.verdict} ${report.score} ip=${g.ip}`);
    if (body.format === 'sarif') report.sarif = toSarif([{ report, uri: report.file?.name }]);
    return res.status(200).json(report);
}
