// api/co2.js — ES Module (package.json has "type":"module")
import { readFileSync } from 'fs';
import { join } from 'path';

// No SEED here, unlike api/climate.js. The climate dashboard must always render
// something, so it carries last-known-good data. This one shouldn't: seeding a
// TCRE figure means shipping a number that didn't come from the pipeline, which
// is exactly what ClimatePulse's design principles rule out. If the gold file is
// missing or malformed, return 503 and let the UI hide the section.
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const p = join(process.cwd(), 'public_data_co2_gold.json');
    const d = JSON.parse(readFileSync(p, 'utf-8'));

    // Emissions + effects are the hard requirement; concentration, global_temp
    // and the station join are all allowed to be null (pipeline fails soft).
    if (!d || !d.emissions || !Array.isArray(d.effects) || !d.effects.length) {
      throw new Error('co2 gold present but incomplete');
    }

    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
    return res.status(200).json(d);
  } catch (err) {
    // s-maxage is short here so a fixed pipeline run shows up quickly.
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(503).json({ error: 'co2 data unavailable' });
  }
}
