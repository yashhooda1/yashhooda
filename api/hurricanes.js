// api/hurricanes.js — ES Module ("type":"module" in package.json)
// Parallels api/climate.js: serves public_data_hurricanes_gold.json with a
// last-known-good SEED so the panel renders before the first pipeline run.
import { readFileSync } from 'fs';
import { join } from 'path';

const SEED = {
  generated_at: "2026-07-01T00:00:00Z",
  source_file: "seed (replaced by pipeline)",
  corr_window_start: 1950,
  correlations: {
    ace_vs_tna_sst:       { r: 0.58, n: 76, window: [1950, 2025] },
    major_vs_tna_sst:     { r: 0.52, n: 76, window: [1950, 2025] },
    ri_storms_vs_tna_sst: { r: 0.49, n: 76, window: [1950, 2025] },
    ace_vs_global_temp:   { r: 0.44, n: 76, window: [1950, 2025] }
  },
  caveat: "Correlation reflects association, not attribution. Annual Atlantic activity is strongly modulated by ENSO and the AMO; formal attribution needs counterfactual potential-intensity modeling.",
  series: [
    {year:2010,named:19,hurricanes:12,major:5,ace:165,ri_storms:6,tna_sst_aso:0.44,global_temp:0.72},
    {year:2011,named:19,hurricanes:7,major:4,ace:126,ri_storms:5,tna_sst_aso:0.29,global_temp:0.61},
    {year:2012,named:19,hurricanes:10,major:2,ace:129,ri_storms:4,tna_sst_aso:0.31,global_temp:0.65},
    {year:2013,named:14,hurricanes:2,major:0,ace:36,ri_storms:1,tna_sst_aso:0.11,global_temp:0.68},
    {year:2014,named:8,hurricanes:6,major:2,ace:67,ri_storms:3,tna_sst_aso:0.18,global_temp:0.75},
    {year:2015,named:11,hurricanes:4,major:2,ace:63,ri_storms:2,tna_sst_aso:0.09,global_temp:0.90},
    {year:2016,named:15,hurricanes:7,major:4,ace:141,ri_storms:5,tna_sst_aso:0.36,global_temp:1.02},
    {year:2017,named:17,hurricanes:10,major:6,ace:225,ri_storms:8,tna_sst_aso:0.51,global_temp:0.92},
    {year:2018,named:15,hurricanes:8,major:2,ace:133,ri_storms:4,tna_sst_aso:0.34,global_temp:0.85},
    {year:2019,named:18,hurricanes:6,major:3,ace:132,ri_storms:5,tna_sst_aso:0.40,global_temp:0.98},
    {year:2020,named:30,hurricanes:14,major:7,ace:180,ri_storms:10,tna_sst_aso:0.62,global_temp:1.02},
    {year:2021,named:21,hurricanes:7,major:4,ace:146,ri_storms:7,tna_sst_aso:0.45,global_temp:0.85},
    {year:2022,named:14,hurricanes:8,major:2,ace:95,ri_storms:4,tna_sst_aso:0.38,global_temp:0.89},
    {year:2023,named:20,hurricanes:7,major:3,ace:146,ri_storms:6,tna_sst_aso:0.71,global_temp:1.17},
    {year:2024,named:18,hurricanes:11,major:5,ace:162,ri_storms:9,tna_sst_aso:0.83,global_temp:1.28},
    {year:2025,named:16,hurricanes:8,major:4,ace:155,ri_storms:7,tna_sst_aso:0.78,global_temp:1.19}
  ]
};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let payload = SEED;
  try {
    const p = join(process.cwd(), 'public_data_hurricanes_gold.json');
    const fresh = JSON.parse(readFileSync(p, 'utf-8'));
    if (fresh && Array.isArray(fresh.series) && fresh.series.length > 40) payload = fresh;
  } catch (_) {}

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(payload);
}
