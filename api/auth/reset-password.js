// api/auth/reset-password.js
// ══════════════════════════════════════════════════════════════════════════════
// RESET PASSWORD — verifies reset token, sets new password
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }                                from '@upstash/redis';
import { hashPassword, validatePassword }       from '../../lib/auth.js';
import { rateLimit }                            from '../../lib/rateLimit.js';

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

    const allowed = await rateLimit(req, res, {
        maxPerMinute:   3,
        maxPerHour:     10,
        maxDailyGlobal: 50,
        endpoint:       'auth-reset',
    });
    if (!allowed) return;

    const { token, newPassword } = req.body || {};

    if (!token)       return res.status(400).json({ error: 'Reset token is required.' });
    if (!newPassword) return res.status(400).json({ error: 'New password is required.' });

    const passwordErr = validatePassword(newPassword);
    if (passwordErr) return res.status(400).json({ error: passwordErr });

    try {
        // ── Verify reset token ────────────────────────────────────────────────
        const email = await redis.get(`reset:${token}`);
        if (!email) {
            return res.status(400).json({ error: 'Reset link has expired or is invalid. Request a new one.' });
        }

        // ── Get user ──────────────────────────────────────────────────────────
        const raw = await redis.get(`user:${email}`);
        if (!raw) return res.status(400).json({ error: 'User not found.' });

        const user = typeof raw === 'string' ? JSON.parse(raw) : raw;

        // ── Hash and save new password ────────────────────────────────────────
        user.passwordHash      = await hashPassword(newPassword);
        user.passwordChangedAt = new Date().toISOString();
        await redis.set(`user:${email}`, JSON.stringify(user));

        // ── Delete used token ─────────────────────────────────────────────────
        await redis.delete(`reset:${token}`);

        console.log(`[RESET] Password reset for: ${email}`);

        return res.status(200).json({
            ok:      true,
            message: 'Password reset successfully. You can now log in.',
        });

    } catch (err) {
        console.error('[RESET] Error:', err);
        return res.status(500).json({ error: 'Password reset failed — please try again.' });
    }
}
