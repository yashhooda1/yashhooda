// api/apple-lab.js — ES Module ("type":"module" in package.json)
// Apple Silicon Lab: one endpoint for both dashboards in the #apple-lab section.
//
//   bench  <- public_data_apple_bench_gold.json  (apple/benchlab/bench.py, run on the Mac)
//   runos  <- public_data_runos_gold.json        (apple/runos/runos.py, from a Health export)
//
// Unlike /api/climate there is deliberately no SEED fallback. These numbers
// only exist once they have been measured on the real machine, so a missing or
// unreadable file is reported as "awaiting_first_run" and the page shows an
// empty state. Invented benchmark figures would be worse than none.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Literal paths at module scope so Vercel's tracer bundles the JSON (same
// reason as api/climate.js).
const BENCH_PATH = fileURLToPath(new URL('../public_data_apple_bench_gold.json', import.meta.url));
const RUNOS_PATH = fileURLToPath(new URL('../public_data_runos_gold.json', import.meta.url));

function load(path, name) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data && typeof data === 'object' && data.status) return data;
    console.error(`[apple-lab] ${name}: parsed but has no status field`);
  } catch (e) {
    console.error(`[apple-lab] ${name}: ${e.message}`);
  }
  return { status: 'awaiting_first_run' };
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const bench = load(BENCH_PATH, 'bench');
  const runos = load(RUNOS_PATH, 'runos');
  res.setHeader('X-AppleLab-Bench', bench.status);
  res.setHeader('X-AppleLab-RunOS', runos.status);
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ bench, runos });
}
