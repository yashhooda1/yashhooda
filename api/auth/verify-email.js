// api/auth/verify-email.js
// ══════════════════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION — called when user clicks the link in their email
// Redirects to yashhooda.ai with a success/error param
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();

    const { token } = req.query;
    if (!token) {
        return res.redirect('https://yashhooda.ai/?auth=verify-failed');
    }

    try {
        // ── Look up token ─────────────────────────────────────────────────────
        const email = await redis.get(`verify:${token}`);
        if (!email) {
            return res.redirect('https://yashhooda.ai/?auth=verify-expired');
        }

        // ── Mark user as verified ─────────────────────────────────────────────
        const raw = await redis.get(`user:${email}`);
        if (!raw) {
            return res.redirect('https://yashhooda.ai/?auth=verify-failed');
        }

        const user      = typeof raw === 'string' ? JSON.parse(raw) : raw;
        user.verified   = true;
        user.verifiedAt = new Date().toISOString();
        await redis.set(`user:${email}`, JSON.stringify(user));

        // ── Delete the used token ─────────────────────────────────────────────
        await redis.del(`verify:${token}`);

        console.log(`[VERIFY] Email verified: ${email}`);

        // ── Redirect back to site with success flag ───────────────────────────
        return res.redirect('https://yashhooda.ai/?auth=verified');

    } catch (err) {
        console.error('[VERIFY] Error:', err);
        return res.redirect('https://yashhooda.ai/?auth=verify-failed');
    }
}
