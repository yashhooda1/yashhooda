// api/stripe-webhook.js
// ══════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK — Activates premium when payment confirmed
// Stores premium against BOTH email (cross-device) and sessionId (current device)
// Webhook URL to set in Stripe Dashboard:
//   https://yashhooda.ai/api/stripe-webhook
// Events: checkout.session.completed
// ══════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { activatePremium, activatePremiumByEmail } from '../lib/usageLimit.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = {
    api: { bodyParser: false }, // Required for Stripe signature verification
};

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
        console.error('[STRIPE WEBHOOK] Signature failed:', err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    if (event.type === 'checkout.session.completed') {
        const session   = event.data.object;
        const email     = session.customer_details?.email?.toLowerCase().trim();
        const sessionId = session.metadata?.sessionId;
        const months    = parseInt(session.metadata?.months || '1', 10);
        const plan      = session.metadata?.plan;

        console.log(`[STRIPE] Payment confirmed — email: ${email} | plan: ${plan} | months: ${months}`);

        // Activate against email (works on any device)
        if (email) {
            await activatePremiumByEmail(email, months);
            console.log(`[STRIPE] Premium activated for email: ${email}`);
        }

        // Also activate against current session (instant access on this device)
        if (sessionId) {
            await activatePremium(sessionId, months);
            console.log(`[STRIPE] Premium activated for session: ${sessionId}`);
        }
    }

    return res.status(200).json({ received: true });
}
