// api/claim-premium.js
// ══════════════════════════════════════════════════════════════════════════════
// CLAIM PREMIUM — User enters their payment email on a new device
// to restore unlimited access without paying again.
// ══════════════════════════════════════════════════════════════════════════════

import { isPremiumByEmail, activatePremium } from '../lib/usageLimit.js';
import { rateLimit } from '../lib/rateLimit.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    // Rate limit — prevent email enumeration attacks
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   5,
        maxPerHour:     20,
        maxDailyGlobal: 200,
        endpoint:       'claim-premium',
    });
    if (!allowed) return;

    const { email, sessionId } = req.body;

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ ok: false, error: 'Email is required.' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ ok: false, error: 'sessionId is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ ok: false, error: 'Invalid email format.' });
    }

    try {
        const premium = await isPremiumByEmail(cleanEmail);

        if (!premium) {
            // Don't reveal whether email exists — just say not found
            return res.status(404).json({
                ok:    false,
                error: 'No active premium found for that email. Check your payment confirmation email.',
            });
        }

        // Link this device's session to their premium account
        await activatePremium(sessionId, 1);

        console.log(`[CLAIM] Premium restored for email: ${cleanEmail} → session: ${sessionId}`);

        return res.status(200).json({
            ok:      true,
            message: 'Premium restored! You now have unlimited access on this device.',
        });

    } catch (err) {
        console.error('[CLAIM] Error:', err);
        return res.status(500).json({ ok: false, error: 'Server error — please try again.' });
    }
}
