// api/auth/login.js
// ══════════════════════════════════════════════════════════════════════════════
// LOGIN — verifies email + password, issues JWT
// Hardened: rejects banned emails and banned IPs before issuing any token
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }                                           from '@upstash/redis';
import { comparePassword, validateEmail, signToken, isAdminEmail } from '../../lib/auth.js';
import { rateLimit }                                       from '../../lib/rateLimit.js';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    // ── ABUSE TRACE LOG ───────────────────────────────────────────────────────
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    console.warn(`[TRACE] ip=${ip} ua="${req.headers['user-agent'] || ''}" path=${req.url || ''}`);

    // ── HARD IP BAN CHECK ─────────────────────────────────────────────────────
    try {
        const ipBanned = await redis.sismember('banned:ips', ip);
        if (ipBanned === 1) {
            return res.status(403).json({ error: 'Access denied.' });
        }
    } catch { /* fail open on redis hiccup */ }

    // Rate limit — prevent brute force
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   5,
        maxPerHour:     20,
        maxDailyGlobal: 200,
        endpoint:       'auth-login',
    });
    if (!allowed) return;

    const { email, password } = req.body || {};

    if (!email || !validateEmail(email)) {
        return res.status(400).json({ error: 'Valid email is required.' });
    }
    if (!password) {
        return res.status(400).json({ error: 'Password is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // ── BANNED EMAIL CHECK — before any password work or token issuance ────────
    try {
        const emailBanned = await redis.sismember('banned:emails', cleanEmail);
        if (emailBanned === 1) {
            console.warn(`[LOGIN] Blocked banned email: ${cleanEmail} from IP: ${ip}`);
            return res.status(403).json({ error: 'account_suspended', message: 'This account has been suspended.' });
        }
    } catch { /* fail open on redis hiccup */ }

    try {
        // ── Look up user ──────────────────────────────────────────────────────
        const raw = await redis.get(`user:${cleanEmail}`);
        if (!raw) {
            // Timing-safe: always run bcrypt even if user not found
            await comparePassword(password, '$2a$12$invalidhashfortimingsafety000000000000000000000');
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = typeof raw === 'string' ? JSON.parse(raw) : raw;

        // ── Verify password ───────────────────────────────────────────────────
        const match = await comparePassword(password, user.passwordHash);
        if (!match) {
            console.warn(`[LOGIN] Failed attempt for ${cleanEmail} from IP: ${ip}`);
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // ── Check premium status ──────────────────────────────────────────────
        const premiumRaw = await redis.get(`premium:email:${cleanEmail}`);
        const isPremium  = premiumRaw === 'active';
        const plan       = isPremium ? 'premium' : (isAdminEmail(cleanEmail) ? 'admin' : 'free');

        // ── Issue JWT ─────────────────────────────────────────────────────────
        const token = signToken({
            email:    cleanEmail,
            name:     user.name,
            verified: user.verified,
            plan,
        });

        // ── Update last login ─────────────────────────────────────────────────
        user.lastLoginAt = new Date().toISOString();
        user.plan        = plan;
        await redis.set(`user:${cleanEmail}`, JSON.stringify(user));

        console.log(`[LOGIN] Success — ${cleanEmail} | plan: ${plan}`);

        return res.status(200).json({
            ok:    true,
            token,
            user: {
                email:    cleanEmail,
                name:     user.name,
                verified: user.verified,
                plan,
            },
        });

    } catch (err) {
        console.error('[LOGIN] Error:', err);
        return res.status(500).json({ error: 'Login failed — please try again.' });
    }
}
