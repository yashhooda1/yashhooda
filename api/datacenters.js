// api/datacenters.js — ES Module ("type":"module" in package.json)
// Data centers: growth & AI demand, U.S. hotspots, and environmental footprint
// (water + energy per query + the efficiency paradox). Curated reference dataset
// (IEA Energy & AI 2025, LBNL 2024, CBRE, company sustainability reports).
// SEED is the data; optional public_data_datacenters_gold.json at repo root overrides it.
import { readFileSync } from 'fs';
import { join } from 'path';

const SEED = {
  "generated_at": "2026-07-01T00:00:00Z",
  "source": "IEA Energy & AI (2025) \u00b7 LBNL 2024 \u00b7 CBRE market data \u00b7 company sustainability reports \u00b7 UC Riverside/WaPo",
  "demand": {
    "unit": "TWh/yr",
    "latest_obs_year": 2024,
    "latest_obs_twh": 415,
    "share_global_2024_pct": 1.5,
    "share_global_2030_pct": 3.0,
    "growth_rate_pct": 15,
    "us_share_2024_pct": 45,
    "china_share_2024_pct": 25,
    "europe_share_2024_pct": 15,
    "series": [
      {
        "year": 2020,
        "twh": 270,
        "kind": "observed"
      },
      {
        "year": 2021,
        "twh": 298,
        "kind": "observed"
      },
      {
        "year": 2022,
        "twh": 325,
        "kind": "observed"
      },
      {
        "year": 2023,
        "twh": 361,
        "kind": "observed"
      },
      {
        "year": 2024,
        "twh": 415,
        "kind": "observed"
      },
      {
        "year": 2025,
        "twh": 485,
        "kind": "projected"
      },
      {
        "year": 2026,
        "twh": 560,
        "kind": "projected"
      },
      {
        "year": 2027,
        "twh": 655,
        "kind": "projected"
      },
      {
        "year": 2028,
        "twh": 760,
        "kind": "projected"
      },
      {
        "year": 2029,
        "twh": 855,
        "kind": "projected"
      },
      {
        "year": 2030,
        "twh": 945,
        "kind": "projected"
      },
      {
        "year": 2035,
        "twh": 1200,
        "kind": "projected"
      }
    ],
    "ai_share_now_pct": 10,
    "ai_share_2030_pct": 45,
    "us_dc_twh_2023": 176,
    "us_dc_share_2023_pct": 4.4,
    "us_dc_2028_range_pct": [6.7, 12]
  },
  "markets": [
    {
      "name": "Northern Virginia",
      "metro": "Ashburn / \"Data Center Alley\"",
      "lat": 39.04,
      "lon": -77.49,
      "mw": 4040,
      "note": "World's largest market \u2014 ~50% of U.S. data centers are in Virginia, using ~26% of the state's electricity."
    },
    {
      "name": "Dallas\u2013Fort Worth",
      "metro": "Texas",
      "lat": 32.9,
      "lon": -97.04,
      "mw": 1650,
      "note": "Tripled since 2020 on cheap ERCOT power (~$0.05/kWh) and fast build timelines."
    },
    {
      "name": "Phoenix",
      "metro": "Arizona",
      "lat": 33.45,
      "lon": -112.07,
      "mw": 1380,
      "note": "Booming in the desert \u2014 water-scarce, so new builds lean on ~95% closed-loop cooling."
    },
    {
      "name": "Atlanta",
      "metro": "Georgia",
      "lat": 33.75,
      "lon": -84.39,
      "mw": 1280,
      "note": "Fastest-growing major market; all four hyperscalers are building here."
    },
    {
      "name": "Chicago",
      "metro": "Illinois",
      "lat": 41.85,
      "lon": -87.65,
      "mw": 1120,
      "note": "Central connectivity hub for national network traffic."
    },
    {
      "name": "Silicon Valley",
      "metro": "Santa Clara, CA",
      "lat": 37.35,
      "lon": -121.95,
      "mw": 900,
      "note": "Legacy hub; power-constrained and the priciest U.S. market."
    },
    {
      "name": "New York / NJ",
      "metro": "Tri-State",
      "lat": 40.79,
      "lon": -74.07,
      "mw": 700,
      "note": "Finance-driven, low-latency colocation."
    },
    {
      "name": "Hillsboro",
      "metro": "Portland, OR",
      "lat": 45.52,
      "lon": -122.99,
      "mw": 500,
      "note": "Green outlier \u2014 hydro power and a cool climate cut both energy and water use."
    }
  ],
  "water": {
    "hyperscalers_2023_billion_gal": [
      {
        "name": "Google",
        "gal": 6.4
      },
      {
        "name": "Microsoft",
        "gal": 1.7
      },
      {
        "name": "Meta",
        "gal": 0.8
      }
    ],
    "us_direct_2023_billion_gal": 17,
    "us_indirect_2023_billion_gal": 211,
    "context_liters": [
      {
        "label": "Google search",
        "l": 0.0005
      },
      {
        "label": "AI prompt (~100 words)",
        "l": 0.5
      },
      {
        "label": "Cup of coffee",
        "l": 140
      },
      {
        "label": "One hamburger",
        "l": 1650
      },
      {
        "label": "Cotton T-shirt",
        "l": 2650
      },
      {
        "label": "Pair of jeans",
        "l": 7500
      }
    ]
  },
  "energy": {
    "per_query_wh": [
      {
        "label": "Google search",
        "lo": 0.3,
        "hi": 0.3,
        "note": "Conventional web search (~2009 est.)."
      },
      {
        "label": "LLM text query (2025 median)",
        "lo": 0.24,
        "hi": 0.3,
        "note": "Newer measurements; much higher for long reasoning."
      },
      {
        "label": "ChatGPT query (2024 est.)",
        "lo": 2.9,
        "hi": 2.9,
        "note": "Widely-cited 2024 figure \u2014 ~10\u00d7 a search."
      },
      {
        "label": "AI image generation",
        "lo": 2,
        "hi": 5,
        "note": "Varies with model and resolution."
      },
      {
        "label": "5-sec AI video",
        "lo": 700,
        "hi": 1200,
        "note": "MIT: ~like running a microwave for an hour."
      }
    ],
    "pue_industry": 1.56,
    "pue_hyperscale": 1.1,
    "google_emissions_since_2019_pct": 51,
    "google_absolute_2024_pct": 27,
    "google_intensity_2024_pct": -12,
    "fossil_share_us_pct": 56,
    "bigtech_ppa_2024_pct": 43
  },
  "context": "Data centers are ~1.5% of global electricity (2024), set to reach ~3% by 2030 \u2014 AI is the main driver. Per-query water and energy figures are genuinely contested and span orders of magnitude; at the individual level an AI prompt is tiny next to everyday items (a burger is ~1,650 L of water), but the aggregate and its geographic concentration are what strain local grids and watersheds."
};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let payload = SEED;
  try {
    const p = join(process.cwd(), 'public_data_datacenters_gold.json');
    const fresh = JSON.parse(readFileSync(p, 'utf-8'));
    if (fresh && fresh.demand && Array.isArray(fresh.markets)) payload = fresh;
  } catch (_) {}

  // live U.S.-grid denominator (EIA sub-feed); optional — attached if present
  try {
    const gp = join(process.cwd(), 'public_data_us_grid_gold.json');
    const grid = JSON.parse(readFileSync(gp, 'utf-8'));
    if (grid && grid.us_total_twh) payload = { ...payload, us_grid: grid };
  } catch (_) {}

  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
  return res.status(200).json(payload);
}
