// api/admin-export-chat.js
// ══════════════════════════════════════════════════════════════════════════════
// ADMIN-ONLY CHAT TRANSCRIPT EXPORT
// Returns a saved conversation as a plain-text transcript for download.
//
// Auth: requires the correct ADMIN_PASSWORD. General users cannot reach this —
// a wrong/missing password gets a generic 403 with no detail.
//
// POST { adminPassword, chatId, sessionId }  → { ok, filename, transcript }
//   - If chatId is provided, exports that saved chat.
//   - If messages[] is provided directly, exports those (current unsaved chat).
// ══════════════════════════════════════════════════════════════════════════════
 
import { Redis } from '@upstash/redis';
 
const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
 
const ALLOWED_ORIGINS = new Set([
    'https://yashhooda.ai',
    'https://www.yashhooda.ai',
    'https://yashhooda1.vercel.app',
]);
 
// Turn a messages array into a readable transcript.
function buildTranscript(meta, messages) {
    const lines = [];
    lines.push('═'.repeat(60));
    lines.push('  YASHHOODA.AI — CHAT TRANSCRIPT');
    lines.push('═'.repeat(60));
    if (meta.title)    lines.push(`Title:    ${meta.title}`);
    if (meta.savedAt)  lines.push(`Saved:    ${new Date(meta.savedAt).toLocaleString()}`);
    lines.push(`Exported: ${new Date().toLocaleString()}`);
    lines.push(`Messages: ${messages.length}`);
    lines.push('═'.repeat(60));
    lines.push('');
 
    messages.forEach((m, i) => {
        const role = m.role === 'user' ? 'USER'
                   : m.role === 'assistant' ? 'ASSISTANT'
                   : (m.role || 'SYSTEM').toUpperCase();
 
        // content can be a string or an array of blocks (image + text)
        let text;
        if (typeof m.content === 'string') {
            text = m.content;
        } else if (Array.isArray(m.content)) {
            text = m.content
                .map(b => b.type === 'text' ? b.text : `[${b.type || 'media'}]`)
                .join(' ');
        } else {
            text = String(m.content ?? '');
        }
 
        lines.push(`[${i + 1}] ${role}:`);
        lines.push(text);
        lines.push('');
        lines.push('-'.repeat(60));
        lines.push('');
    });
 
    lines.push('End of transcript.');
    return lines.join('\n');
}
 
function safeName(s) {
    return String(s || 'chat')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'chat';
}
 
export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
 
    const { adminPassword, chatId, sessionId, messages } = req.body || {};
 
    // ── ADMIN AUTH — the only gate that matters ───────────────────────────────
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured.' });
    if (!adminPassword || adminPassword !== expected) {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
        console.warn(`[ADMIN-EXPORT] unauthorized attempt ip=${ip}`);
        return res.status(403).json({ error: 'forbidden' });
    }
 
    try {
        let meta = {};
        let msgs = [];
 
        if (Array.isArray(messages) && messages.length) {
            // Export the messages passed directly (current in-memory chat)
            msgs = messages;
            meta = { title: 'Current conversation', savedAt: null };
        } else if (chatId) {
            // Look up a saved chat. Matches the key scheme used by /api/history.
            const raw = await redis.get(`chat:${sessionId}:${chatId}`)
                     ?? await redis.get(`history:${sessionId}:${chatId}`)
                     ?? await redis.get(chatId);
            if (!raw) return res.status(404).json({ error: 'Chat not found.' });
            const chat = typeof raw === 'string' ? JSON.parse(raw) : raw;
            msgs = chat.messages || [];
            meta = { title: chat.title, savedAt: chat.savedAt };
        } else {
            return res.status(400).json({ error: 'Provide chatId or messages[].' });
        }
 
        if (!msgs.length) return res.status(400).json({ error: 'No messages to export.' });
 
        const transcript = buildTranscript(meta, msgs);
        const filename   = `transcript-${safeName(meta.title)}-${new Date().toISOString().slice(0,10)}.txt`;
 
        return res.status(200).json({ ok: true, filename, transcript });
    } catch (err) {
        console.error('[ADMIN-EXPORT] error:', err.message);
        return res.status(500).json({ error: 'Export failed.' });
    }
}
