// api/agent-context.js — ES Module ("type":"module" in package.json)
// Serves the AI agent's live "This Week" context (Strava running + GitHub coding),
// refreshed weekly by climatepulse/scripts/agent_context_pipeline.py.
// SEED is the last-known snapshot; agent_context_gold.json at repo root overrides it.
import { readFileSync } from 'fs';
import { join } from 'path';

const SEED = {"generated_at":"2026-09-07T09:56:36Z","source":"Strava API (activities) \u00b7 GitHub public events","window":{"label":"last week","start":"2026-08-31","end":"2026-09-06","timezone":"America/Chicago"},"running":{"week_miles":40.7,"week_runs":9,"recent":[{"date":"2026-09-06","name":"5 on Treadmill","miles":5.0,"pace":"7:58"},{"date":"2026-09-06","name":"8m w/Thais","miles":8.0,"pace":"8:28"},{"date":"2026-09-05","name":"Everyone please pray for my friend Grayson \ud83d\ude4f","miles":6.0,"pace":"7:48"},{"date":"2026-09-05","name":"C/D","miles":3.3,"pace":"7:34"},{"date":"2026-09-04","name":"W/U","miles":3.0,"pace":"7:33"}],"longest_run_miles":8.0,"days_to_chevron_houston_marathon":131,"days_to_chevron":131,"days_to_houston":131,"week_start":"2026-08-31","week_end":"2026-09-06","summary":"40.7 mi last week (Aug 31-Sep 6) across 9 run(s); longest 8.0 mi @ 8:28/mi. 131 days to the Chevron Houston marathon (Jan 17, 2027)."},"coding":{"week_commits":39,"active_repos":[{"name":"yashhooda","commits":31,"language":"HTML"},{"name":"climatepulse","commits":5,"language":"Python"},{"name":"metar-stream","commits":3,"language":"Python"}],"current_focus":"yashhooda, climatepulse, metar-stream","summary":"39 commit(s) last week across 3 repo(s) (HTML, Python); most active: yashhooda, climatepulse, metar-stream."}};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let payload = SEED;
  try {
    const p = join(process.cwd(), 'agent_context_gold.json');
    const fresh = JSON.parse(readFileSync(p, 'utf-8'));
    if (fresh && fresh.running && fresh.coding) payload = fresh;
  } catch (err) {
    console.warn('[agent-context] gold JSON unavailable, serving SEED:', err.message);
  }

  // Flag stale snapshots so the UI and the agent can hedge instead of
  // presenting months-old numbers as current.
  const ageDays = payload.generated_at
    ? (Date.now() - new Date(payload.generated_at).getTime()) / 86400000
    : null;
  const out = {
    ...payload,
    is_seed: payload === SEED,
    stale: ageDays == null || ageDays > 10,
  };

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json(out);
}
