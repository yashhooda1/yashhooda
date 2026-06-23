// api/auth/signup.js
// ══════════════════════════════════════════════════════════════════════════════
// SIGNUP — creates account, sends verification email via Resend
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }                                    from '@upstash/redis';
import { hashPassword, validateEmail, validatePassword, signToken, isAdminEmail } from '../../lib/auth.js';
import { rateLimit }                                from '../../lib/rateLimit.js';
import crypto                                       from 'crypto';

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

    // Rate limit — 5 signups per hour per IP
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   3,
        maxPerHour:     5,
        maxDailyGlobal: 100,
        endpoint:       'auth-signup',
    });
    if (!allowed) return;

    const { email, password, name } = req.body || {};

    // ── Validate inputs ───────────────────────────────────────────────────────
    if (!email || !validateEmail(email)) {
        return res.status(400).json({ error: 'Valid email address is required.' });
    }
    const cleanEmail = email.toLowerCase().trim();
    const passwordErr = validatePassword(password);
    if (passwordErr) return res.status(400).json({ error: passwordErr });

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    }
    const cleanName = name.trim().slice(0, 60);

    try {
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
