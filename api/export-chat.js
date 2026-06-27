// api/export-chat.js
// ══════════════════════════════════════════════════════════════════════════════
// CHAT TRANSCRIPT EXPORT — available to all users
// Returns a conversation as a plain-text transcript for download.
//
// Access model (NOT admin-gated):
//   • Current chat  → export the messages[] passed in the request (always allowed;
//                     the user already has them in front of them).
//   • Saved chat    → export by chatId, but ONLY if the requesting sessionId owns it.
//                     chatId is `${sessionId}:${timestamp}` and the saved record
//                     stores sessionId, so ownership is verified against that.
//   • Admin override → if the correct ADMIN_PASSWORD is supplied, ownership is
//                     skipped (so you can still export any chat).
//
// This is convenience-grade auth (sessionId lives in localStorage), which is the
// right tradeoff for letting visitors download their own transcripts.
//
// POST { sessionId, chatId?, messages?, adminPassword? } → { ok, filename, transcript }
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

function buildTranscript(meta, messages) {
    const lines = [];
    lines.push('═'.repeat(60));
    lines.push('  YASHHOODA.AI — CHAT TRANSCRIPT');
    lines.push('═'.repeat(60));
    if (meta.title)   lines.push(`Title:    ${meta.title}`);
    if (meta.savedAt) lines.push(`Saved:    ${new Date(meta.savedAt).toLocaleString()}`);
    lines.push(`Exported: ${new Date().toLocaleString()}`);
    lines.push(`Messages: ${messages.length}`);
    lines.push('═'.repeat(60));
    lines.push('');

    messages.forEach((m, i) => {
        const role = m.role === 'user' ? 'USER'
                   : m.role === 'assistant' ? 'ASSISTANT'
                   : (m.role || 'SYSTEM').toUpperCase();

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

    const { sessionId, chatId, messages, adminPassword } = req.body || {};

    const isAdmin = adminPassword && process.env.ADMIN_PASSWORD
                 && adminPassword === process.env.ADMIN_PASSWORD;

    try {
        let meta = {};
        let msgs = [];

        if (Array.isArray(messages) && messages.length) {
            // Current in-memory chat — user already has these, always allowed.
            msgs = messages;
            meta = { title: 'Current conversation', savedAt: null };
        } else if (chatId) {
            const raw = await redis.get(`saved_chat:${chatId}`);
            if (!raw) return res.status(404).json({ error: 'Chat not found.' });
            const chat = typeof raw === 'string' ? JSON.parse(raw) : raw;

            // ── OWNERSHIP CHECK ──
            // Anyone may export, but only their OWN saved chats (unless admin).
            if (!isAdmin && chat.sessionId !== sessionId) {
                return res.status(403).json({ error: 'forbidden' });
            }

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
        console.error('[EXPORT-CHAT] error:', err.message);
        return res.status(500).json({ error: 'Export failed.' });
    }
}
