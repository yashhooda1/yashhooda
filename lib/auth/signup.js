// api/auth/signup.js
// ══════════════════════════════════════════════════════════════════════════════
// SIGNUP — creates account, sends verification email via Resend
// Hardened: disposable-domain block + per-IP signup cap + email banlist
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }                                    from '@upstash/redis';
import { hashPassword, validateEmail, validatePassword, signToken, isAdminEmail } from '../../lib/auth.js';
import { rateLimit }                                from '../../lib/rateLimit.js';
import { checkSignupIp } from '../../lib/ipReputation.js';
import crypto                                       from 'crypto';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Disposable / throwaway email domains (extend anytime) ─────────────────────
const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','guerrillamail.info','grr.la',
    '10minutemail.com','10minutemail.net','tempmail.com','temp-mail.org',
    'throwawaymail.com','yopmail.com','sharklasers.com','trashmail.com',
    'getnada.com','nada.email','dispostable.com','fakeinbox.com','maildrop.cc',
    'mailnesia.com','mintemail.com','mohmal.com','emailondeck.com','spam4.me',
    'tempr.email','tmpmail.org','tmpmail.net','mailcatch.com','inboxbear.com',
    'tempmailo.com','luxusmail.org','burnermail.io','mailpoof.com','moakt.com',
    'harakirimail.com','anonbox.net','spambog.com','byom.de','tempinbox.com',
]);

// ── Max accounts a single IP may create per day ───────────────────────────────
const MAX_SIGNUPS_PER_IP_PER_DAY = 3;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    // Rate limit — 5 signups per hour per IP (burst protection)
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   3,
        maxPerHour:     5,
        maxDailyGlobal: 100,
        endpoint:       'auth-signup',
    });
    if (!allowed) return;

    // ── Resolve client IP ─────────────────────────────────────────────────────
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

    // ── Hard IP ban check ─────────────────────────────────────────────────────
    try {
        const ipBanned = await redis.sismember('banned:ips', ip);
        if (ipBanned === 1) {
            return res.status(403).json({ error: 'Account creation is not available.' });
        }
    } catch { /* fail open on redis hiccup */ }

    const { email, password, name } = req.body || {};

    // ── Validate inputs ───────────────────────────────────────────────────────
    if (!email || !validateEmail(email)) {
        return res.status(400).json({ error: 'Valid email address is required.' });
    }
    const cleanEmail = email.toLowerCase().trim();
    const domain     = cleanEmail.split('@')[1] || '';

    // ── Block disposable / throwaway domains ──────────────────────────────────
    if (DISPOSABLE_DOMAINS.has(domain)) {
        return res.status(403).json({ error: 'Disposable email addresses are not allowed. Please use a permanent email.' });
    }

    // ── Block already-banned emails (exact troll addresses) ───────────────────
    try {
        const emailBanned = await redis.sismember('banned:emails', cleanEmail);
        if (emailBanned === 1) {
            return res.status(403).json({ error: 'This email is not permitted to create an account.' });
        }
    } catch { /* fail open */ }

    const passwordErr = validatePassword(password);
    if (passwordErr) return res.status(400).json({ error: passwordErr });

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    }
    const cleanName = name.trim().slice(0, 60);

    try {
        // ── Per-IP daily signup cap (the real anti-troll lever) ───────────────
        // Admin is exempt so you can always make/test accounts.
        if (!isAdminEmail(cleanEmail)) {
            const ipKey = `signups:ip:${ip}:${new Date().toISOString().slice(0, 10)}`;
            const ipCount = await redis.incr(ipKey);
            if (ipCount === 1) await redis.expire(ipKey, 60 * 60 * 24);
            if (ipCount > MAX_SIGNUPS_PER_IP_PER_DAY) {
                console.warn(`[SIGNUP] IP ${ip} exceeded daily signup cap (${ipCount})`);
                return res.status(429).json({ error: 'Too many accounts created from this network today. Please try again tomorrow.' });
            }
        }

        // after you have `ip` and confirmed it's not the admin:
        const ipCheck = await checkSignupIp(ip);
        if (ipCheck.blocked) {
            console.warn(`[SIGNUP-BLOCK] ip=${ip} reason=${ipCheck.reason}`);
            return res.status(403).json({
                error: 'signup_blocked',
                message: 'Sign-ups from VPNs, proxies, and hosting providers are not allowed. Please use a normal connection.',
            });
        }

        // ── Check if email already exists ─────────────────────────────────────
        const existing = await redis.get(`user:${cleanEmail}`);
        if (existing) {
            return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
        }

        // ── Hash password ─────────────────────────────────────────────────────
        const passwordHash = await hashPassword(password);

        // ── Generate email verification token ─────────────────────────────────
        const verifyToken = crypto.randomBytes(32).toString('hex');

        // ── Store user in Redis ───────────────────────────────────────────────
        const user = {
            email:         cleanEmail,
            name:          cleanName,
            passwordHash,
            verified:      isAdminEmail(cleanEmail), // admin pre-verified
            createdAt:     new Date().toISOString(),
            signupIp:      ip,                        // keep for abuse tracing
            plan:          'free',
        };
        await redis.set(`user:${cleanEmail}`, JSON.stringify(user));

        // ── Store verify token (expires in 24h) ───────────────────────────────
        if (!isAdminEmail(cleanEmail)) {
            await redis.set(`verify:${verifyToken}`, cleanEmail, { ex: 60 * 60 * 24 });

            // ── Send verification email via Resend ────────────────────────────
            await fetch('https://api.resend.com/emails', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                },
                body: JSON.stringify({
                    from:    'Yash Hooda AI <noreply@yashhooda.ai>',
                    to:      cleanEmail,
                    subject: 'Verify your email — yashhooda.ai',
                    html: `
                        <div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0d1117;color:#e0e0e0;padding:2rem;border-radius:12px;border:1px solid rgba(76,175,80,0.3);">
                            <h2 style="color:#4caf50;font-size:1.1rem;margin-bottom:1rem;">Welcome to yashhooda.ai, ${cleanName}! 👋</h2>
                            <p style="color:#9ca3af;font-size:0.9rem;line-height:1.6;">Click the button below to verify your email and activate your account.</p>
                            <a href="https://yashhooda.ai/api/auth/verify-email?token=${verifyToken}"
                               style="display:inline-block;background:#4caf50;color:#000;font-weight:700;padding:0.75rem 1.5rem;border-radius:7px;text-decoration:none;margin:1.5rem 0;font-size:0.9rem;">
                               ✅ Verify Email
                            </a>
                            <p style="color:#4b5563;font-size:0.75rem;">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
                        </div>
                    `,
                }),
            });
        }

        // ── Issue JWT (so they can log in immediately, but usage gated until verified) ──
        const token = signToken({
            email:    cleanEmail,
            name:     cleanName,
            verified: user.verified,
            plan:     'free',
        });

        return res.status(201).json({
            ok:       true,
            token,
            user: {
                email:    cleanEmail,
                name:     cleanName,
                verified: user.verified,
                plan:     'free',
            },
            message: isAdminEmail(cleanEmail)
                ? 'Admin account ready.'
                : 'Account created! Check your email to verify your account.',
        });

    } catch (err) {
        console.error('[SIGNUP] Error:', err);
        return res.status(500).json({ error: 'Signup failed — please try again.' });
    }
}
