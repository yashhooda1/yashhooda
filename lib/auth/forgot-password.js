// api/auth/forgot-password.js
// ══════════════════════════════════════════════════════════════════════════════
// FORGOT PASSWORD — sends reset link via Resend
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }       from '@upstash/redis';
import { validateEmail } from '../../lib/auth.js';
import { rateLimit }   from '../../lib/rateLimit.js';
import crypto          from 'crypto';

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
        maxPerHour:     5,
        maxDailyGlobal: 50,
        endpoint:       'auth-forgot',
    });
    if (!allowed) return;

    const { email } = req.body || {};
    if (!email || !validateEmail(email)) {
        return res.status(400).json({ error: 'Valid email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Always return success to prevent email enumeration
    const successResponse = { ok: true, message: 'If that email exists, a reset link has been sent.' };

    try {
        const raw = await redis.get(`user:${cleanEmail}`);
        if (!raw) return res.status(200).json(successResponse);

        // Generate reset token (expires in 1 hour)
        const resetToken = crypto.randomBytes(32).toString('hex');
        await redis.set(`reset:${resetToken}`, cleanEmail, { ex: 60 * 60 });

        // Send email via Resend
        await fetch('https://api.resend.com/emails', {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
                from:    'Yash Hooda AI <noreply@yashhooda.ai>',
                to:      cleanEmail,
                subject: 'Reset your password — yashhooda.ai',
                html: `
                    <div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0d1117;color:#e0e0e0;padding:2rem;border-radius:12px;border:1px solid rgba(76,175,80,0.3);">
                        <h2 style="color:#4caf50;font-size:1.1rem;margin-bottom:1rem;">Password Reset Request</h2>
                        <p style="color:#9ca3af;font-size:0.9rem;line-height:1.6;">Click the button below to reset your password. This link expires in 1 hour.</p>
                        <a href="https://yashhooda.ai/?reset=${resetToken}"
                           style="display:inline-block;background:#4caf50;color:#000;font-weight:700;padding:0.75rem 1.5rem;border-radius:7px;text-decoration:none;margin:1.5rem 0;font-size:0.9rem;">
                           🔑 Reset Password
                        </a>
                        <p style="color:#4b5563;font-size:0.75rem;">If you didn't request this, ignore this email. Your password won't change.</p>
                    </div>
                `,
            }),
        });

        console.log(`[FORGOT] Reset email sent to: ${cleanEmail}`);
        return res.status(200).json(successResponse);

    } catch (err) {
        console.error('[FORGOT] Error:', err);
        return res.status(200).json(successResponse); // always succeed to prevent enumeration
    }
}
