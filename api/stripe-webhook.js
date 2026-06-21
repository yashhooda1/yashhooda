// api/stripe-webhook.js
// ══════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK — Activates premium when payment is confirmed
// Set this URL in Stripe Dashboard → Webhooks:
//   https://yashhooda.ai/api/stripe-webhook
// Events to listen for: checkout.session.completed
// ══════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { activatePremium } from '../lib/usageLimit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = {
    api: {
        bodyParser: false, // Required — Stripe needs raw body for signature verification
    },
};

// Read raw body for Stripe signature verification
async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end',  () => resolve(Buffer.from(data)));
        req.on('error', reject);
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const sig        = req.headers['stripe-signature'];
    const webhookKey = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        const rawBody = await getRawBody(req);
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookKey);
    } catch (err) {
        console.error('[STRIPE WEBHOOK] Signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    // ── PAYMENT CONFIRMED ────────────────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
        const session   = event.data.object;
        const sessionId = session.metadata?.sessionId;
        const months    = parseInt(session.metadata?.months || '1', 10);
        const plan      = session.metadata?.plan;

        if (!sessionId) {
            console.error('[STRIPE WEBHOOK] No sessionId in metadata');
            return res.status(200).end(); // Return 200 to stop Stripe retrying
        }

        try {
            await activatePremium(sessionId, months);
            console.log(`[STRIPE] Premium activated — session: ${sessionId} | plan: ${plan} | months: ${months}`);
        } catch (err) {
            console.error('[STRIPE] Failed to activate premium:', err.message);
        }
    }

    return res.status(200).json({ received: true });
}
