// api/admin-verify.js
// ══════════════════════════════════════════════════════════════════════════════
// ADMIN PASSWORD VERIFICATION — server-side only
// Never exposes the password to the client.
// Uses timing-safe comparison to prevent timing attacks.
// ══════════════════════════════════════════════════════════════════════════════

import crypto      from 'crypto';
import { rateLimit } from '../lib/rateLimit.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).end();

    // Strict rate limit — prevent brute force
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   3,   // only 3 attempts per minute
        maxPerHour:     10,  // 10 per hour
        maxDailyGlobal: 50,  // 50 globally per day
        endpoint:       'admin-verify',
    });
    if (!allowed) return;

    const { password, sessionId = 'admin' } = req.body;

    if (!password || typeof password !== 'string') {
        return res.status(400).json({ ok: false });
    }

    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        console.error('[ADMIN] ADMIN_PASSWORD env var not set!');
        return res.status(500).json({ ok: false });
    }

    // Timing-safe comparison — prevents timing attacks
    let match = false;
    try {
        match = crypto.timingSafeEqual(
            Buffer.from(password.padEnd(64)),
            Buffer.from(adminPassword.padEnd(64))
        ) && password.length === adminPassword.length;
    } catch {
        match = false;
    }

    if (!match) {
        // Log failed attempt with IP
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
        console.warn(`[ADMIN] Failed login attempt from IP: ${ip}`);
        // Deliberate delay to slow brute force even further
        await new Promise(r => setTimeout(r, 1000));
        return res.status(401).json({ ok: false });
    }

    console.log(`[ADMIN] Successful admin login — session: ${sessionId}`);
    return res.status(200).json({ ok: true });
}
