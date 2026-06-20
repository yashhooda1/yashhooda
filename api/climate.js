// api/climate.js
// Serves pre-computed ClimatePulse gold layer JSON.
// File is refreshed weekly by GitHub Actions (scripts/climate_pipeline.py)
// and committed to public/data/climate_gold.json → Vercel auto-deploys.

import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
    // CORS — same pattern as your other API routes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        // Reads from public/data/climate_gold.json at build time
        const filePath = join(process.cwd(), 'public', 'data', 'climate_gold.json');
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        // Cache for 1 hour on CDN, 10 min stale-while-revalidate
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
        res.status(200).json(data);
    } catch (err) {
        console.error('[climate] Failed to read gold JSON:', err.message);
        res.status(500).json({ error: 'Climate data unavailable', detail: err.message });
    }
}
