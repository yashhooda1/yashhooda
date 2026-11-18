// api/hurricanes.js — ES Module ("type":"module" in package.json)
// Parallels api/climate.js: serves public_data_hurricanes_gold.json with a
// last-known-good SEED so the panel renders before the first pipeline run.
import { readFileSync } from 'fs';
import { join } from 'path';

const SEED = {
  // Last-known-good values from a live pipeline run (Nov 2026), used only if
  // the gold file is missing. Counts follow NHC convention (see climatepulse).
  generated_at: "2026-11-18T00:00:00Z",
  source_file: "seed (replaced by pipeline)",
  reanalysed_through: 2025,
  preliminary_years: [],
  corr_window_start: 1950,
  normals: { window: [1991, 2020], named: 14.4, hurricanes: 7.2, major: 3.2, ace: 122.5 },
  correlations: {
    ace_vs_tna_sst:       { r: 0.466, n: 76, window: [1950, 2025] },
    major_vs_tna_sst:     { r: 0.408, n: 76, window: [1950, 2025] },
    ri_storms_vs_tna_sst: { r: 0.299, n: 76, window: [1950, 2025] },
    ace_vs_global_temp:   { r: 0.285, n: 76, window: [1950, 2025] }
  },
  caveat: "Correlation reflects association, not attribution. Annual Atlantic activity is strongly modulated by ENSO and the AMO; formal attribution needs counterfactual potential-intensity modeling.",
  featured: [],
  series: [
    {year:2010,named:19,hurricanes:12,major:5,ace:165,ri_storms:9,tna_sst_aso:0.45,global_temp:0.72},
    {year:2011,named:19,hurricanes:7,major:4,ace:126,ri_storms:4,tna_sst_aso:0.053,global_temp:0.61},
    {year:2012,named:19,hurricanes:10,major:2,ace:133,ri_storms:5,tna_sst_aso:0.293,global_temp:0.64},
    {year:2013,named:14,hurricanes:2,major:0,ace:36,ri_storms:0,tna_sst_aso:0.227,global_temp:0.67},
    {year:2014,named:8,hurricanes:6,major:2,ace:67,ri_storms:2,tna_sst_aso:0.053,global_temp:0.75},
    {year:2015,named:11,hurricanes:4,major:2,ace:63,ri_storms:3,tna_sst_aso:0.317,global_temp:0.9},
    {year:2016,named:15,hurricanes:7,major:4,ace:141,ri_storms:5,tna_sst_aso:0.093,global_temp:1.01},
    {year:2017,named:17,hurricanes:10,major:6,ace:225,ri_storms:8,tna_sst_aso:0.17,global_temp:0.91},
    {year:2018,named:15,hurricanes:8,major:2,ace:133,ri_storms:5,tna_sst_aso:-0.163,global_temp:0.85},
    {year:2019,named:18,hurricanes:6,major:3,ace:132,ri_storms:3,tna_sst_aso:0.1,global_temp:0.98},
    {year:2020,named:30,hurricanes:14,major:7,ace:180,ri_storms:8,tna_sst_aso:0.197,global_temp:1.01},
    {year:2021,named:21,hurricanes:7,major:4,ace:146,ri_storms:5,tna_sst_aso:0.04,global_temp:0.85},
    {year:2022,named:14,hurricanes:8,major:2,ace:95,ri_storms:3,tna_sst_aso:0.157,global_temp:0.89},
    {year:2023,named:20,hurricanes:7,major:3,ace:148,ri_storms:4,tna_sst_aso:0.99,global_temp:1.17},
    {year:2024,named:18,hurricanes:11,major:5,ace:162,ri_storms:9,tna_sst_aso:0.687,global_temp:1.28},
    {year:2025,named:13,hurricanes:5,major:4,ace:131,ri_storms:4,tna_sst_aso:0.36,global_temp:1.19}
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
