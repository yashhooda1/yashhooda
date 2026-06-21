// api/stripe-checkout.js
// ══════════════════════════════════════════════════════════════════════════════
// STRIPE CHECKOUT — Creates a payment session for premium access
// Plans:
//   - pro:       $20/month  — unlimited messages
//   - supporter: $50/3 months — unlimited messages + supporter status
// ══════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
    pro: {
        name:        'Pro — Unlimited AI Chat',
        description: '1 month of unlimited access to Yash\'s AI Assistant across all models',
        price:       2000,  // $20.00 in cents
        months:      1,
    },
    supporter: {
        name:        'Supporter — 3 Months Unlimited',
        description: '3 months of unlimited access + supporter status on yashhooda.ai',
        price:       5000,  // $50.00 in cents
        months:      3,
    },
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    const { plan, sessionId } = req.body;

    if (!plan || !PLANS[plan]) {
        return res.status(400).json({ error: 'Invalid plan. Choose: pro or supporter' });
    }
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    const selectedPlan = PLANS[plan];

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency:     'usd',
                    product_data: {
                        name:        selectedPlan.name,
                        description: selectedPlan.description,
                        images:      ['https://yashhooda.ai/images/og-image.png'],
                    },
                    unit_amount: selectedPlan.price,
                },
                quantity: 1,
            }],
            mode:     'payment',
            metadata: {
                sessionId,
                plan,
                months: selectedPlan.months.toString(),
            },
            success_url: `https://yashhooda.ai/?payment=success&plan=${plan}`,
            cancel_url:  `https://yashhooda.ai/?payment=cancelled`,
        });

        return res.status(200).json({ url: session.url });

    } catch (err) {
        console.error('[STRIPE] Checkout error:', err);
        return res.status(500).json({ error: 'Failed to create checkout session' });
    }
}
