// api/agent-context.js — ES Module ("type":"module" in package.json)
// Serves the AI agent's live "This Week" context (Strava running + GitHub coding),
// refreshed weekly by climatepulse/scripts/agent_context_pipeline.py.
// SEED is the last-known snapshot; agent_context_gold.json at repo root overrides it.
import { readFileSync } from 'fs';
import { join } from 'path';

const SEED = {"generated_at":"2026-07-09T21:07:30Z","source":"Strava API (activities) · GitHub public events","running":{"week_miles":46.8,"week_runs":8,"recent":[{"date":"2026-07-08","name":"7 w/FF Sugar Land after work","miles":7.0,"pace":"7:33"},{"date":"2026-07-07","name":"C/D","miles":2.0,"pace":"8:41"},{"date":"2026-07-07","name":"Mixed Threshold repeats w/jog in b/w","miles":4.4,"pace":"6:44"},{"date":"2026-07-07","name":"W/U","miles":2.0,"pace":"7:46"},{"date":"2026-07-06","name":"Let's go Belgium 🇧🇪","miles":5.1,"pace":"8:02"}],"longest_run_miles":7.0,"days_to_boulderthon":79,"days_to_houston":191,"summary":"46.8 mi over the last 7 days across 8 run(s); longest 7.0 mi @ 7:33/mi. 79 days to the Boulderthon marathon (Sep 27, 2026)."},"coding":{"week_commits":97,"active_repos":[{"name":"yashhooda","commits":66,"language":"JavaScript"},{"name":"climatepulse","commits":22,"language":"Python"},{"name":"hoodaroutes","commits":7,"language":"HTML"},{"name":"mcp-garmin","commits":2,"language":"Python"}],"current_focus":"yashhooda, climatepulse, hoodaroutes","summary":"97 commit(s) this week across 4 repo(s) (HTML, JavaScript, Python); most active: yashhooda, climatepulse, hoodaroutes."}};

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
  } catch (_) {}

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json(payload);
}
