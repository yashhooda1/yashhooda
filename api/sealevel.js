// api/sealevel.js — ES Module ("type":"module" in package.json)
// Rising seas + US coastal risk + ice-melt sea-level scenarios.
// Curated reference dataset (NASA/NOAA altimetry, NOAA tide-gauge trends, USGS/NSIDC
// ice equivalents). Served with a SEED that IS the data; an optional
// public_data_sealevel_gold.json at repo root overrides it if you later automate refresh.
import { readFileSync } from 'fs';
import { join } from 'path';

const SEED = {
  "generated_at": "2026-07-01T00:00:00Z",
  "source": "NASA/NOAA satellite altimetry \u00b7 NOAA Tides & Currents sea-level trends \u00b7 USGS/NSIDC ice sea-level equivalents",
  "gmsl": {
    "unit": "mm above 1993",
    "latest_year": 2024,
    "latest_mm": 106.1,
    "rate_1993": 2.1,
    "rate_now": 4.7,
    "total_since_1993_mm": 106.1,
    "series": [
      {
        "year": 1993,
        "mm": 0.0
      },
      {
        "year": 1994,
        "mm": 2.1
      },
      {
        "year": 1995,
        "mm": 4.4
      },
      {
        "year": 1996,
        "mm": 6.7
      },
      {
        "year": 1997,
        "mm": 9.1
      },
      {
        "year": 1998,
        "mm": 11.6
      },
      {
        "year": 1999,
        "mm": 14.1
      },
      {
        "year": 2000,
        "mm": 16.8
      },
      {
        "year": 2001,
        "mm": 19.5
      },
      {
        "year": 2002,
        "mm": 22.4
      },
      {
        "year": 2003,
        "mm": 25.3
      },
      {
        "year": 2004,
        "mm": 28.3
      },
      {
        "year": 2005,
        "mm": 31.3
      },
      {
        "year": 2006,
        "mm": 34.5
      },
      {
        "year": 2007,
        "mm": 37.8
      },
      {
        "year": 2008,
        "mm": 41.1
      },
      {
        "year": 2009,
        "mm": 44.5
      },
      {
        "year": 2010,
        "mm": 48.0
      },
      {
        "year": 2011,
        "mm": 51.6
      },
      {
        "year": 2012,
        "mm": 55.3
      },
      {
        "year": 2013,
        "mm": 59.1
      },
      {
        "year": 2014,
        "mm": 62.9
      },
      {
        "year": 2015,
        "mm": 66.9
      },
      {
        "year": 2016,
        "mm": 70.9
      },
      {
        "year": 2017,
        "mm": 75.0
      },
      {
        "year": 2018,
        "mm": 79.2
      },
      {
        "year": 2019,
        "mm": 83.4
      },
      {
        "year": 2020,
        "mm": 87.8
      },
      {
        "year": 2021,
        "mm": 92.3
      },
      {
        "year": 2022,
        "mm": 96.8
      },
      {
        "year": 2023,
        "mm": 101.4
      },
      {
        "year": 2024,
        "mm": 106.1
      }
    ]
  },
  "cities": [
    {
      "name": "New Orleans / Grand Isle, LA",
      "region": "Mississippi Delta",
      "lat": 29.263,
      "lon": -89.957,
      "station_id": "8761724",
      "trend_mm_yr": 9.1,
      "tier": "Extreme",
      "note": "Highest relative rise in the U.S. \u2014 delta subsidence plus levee-dependent, much of metro below sea level."
    },
    {
      "name": "Houston / Galveston, TX",
      "region": "Upper Texas Coast",
      "lat": 29.31,
      "lon": -94.793,
      "station_id": "8771450",
      "trend_mm_yr": 6.6,
      "tier": "Very High",
      "note": "Groundwater/oil-withdrawal subsidence compounds Gulf rise; hurricane storm surge multiplier."
    },
    {
      "name": "Miami / Virginia Key, FL",
      "region": "Southeast Florida",
      "lat": 25.731,
      "lon": -80.162,
      "station_id": "8723214",
      "trend_mm_yr": 4.0,
      "tier": "Extreme",
      "note": "Porous limestone bedrock lets water up through the ground \u2014 seawalls can't stop it; <2 m elevation, dense."
    },
    {
      "name": "New York / The Battery, NY",
      "region": "NY\u2013NJ Harbor",
      "lat": 40.7,
      "lon": -74.014,
      "station_id": "8518750",
      "trend_mm_yr": 2.9,
      "tier": "High",
      "note": "Enormous exposed population and infrastructure; Sandy showed surge-on-rise risk to transit and utilities."
    },
    {
      "name": "San Francisco Bay / Delta, CA",
      "region": "Bay\u2013Delta",
      "lat": 37.807,
      "lon": -122.465,
      "station_id": "9414290",
      "trend_mm_yr": 2.0,
      "tier": "Moderate\u2013High",
      "note": "Rise near global average, but Bay-Delta levees guard the state's water supply, SFO/OAK, and low-lying fill."
    }
  ],
  "ice": [
    {
      "name": "West Antarctica (unstable sector)",
      "sle_m": 5.0,
      "sle_ft": 16,
      "note": "The realistically vulnerable part this millennium \u2014 Thwaites/WAIS marine-based ice."
    },
    {
      "name": "Greenland Ice Sheet",
      "sle_m": 7.4,
      "sle_ft": 24,
      "note": "BedMachine v3: 7.42 \u00b1 0.05 m if it all melted."
    },
    {
      "name": "Antarctic Ice Sheet (all)",
      "sle_m": 58.3,
      "sle_ft": 191,
      "note": "Full Antarctic ice \u2014 the overwhelming majority of Earth's land ice."
    },
    {
      "name": "All land ice (everything)",
      "sle_m": 65.7,
      "sle_ft": 216,
      "note": "Both ice sheets + all glaciers. USGS cites ~70 m (230 ft) with every mountain glacier included."
    }
  ],
  "context": "Full-melt scenarios unfold over centuries to millennia, not this century. Observed rise this century is ~0.3\u20131 m by 2100 (up to ~2 m on high-emission, rapid-ice-loss pathways for the U.S. coast). The ice bars show the ultimate ceiling each reservoir holds, not a 2100 forecast."
};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let payload = SEED;
  try {
    const p = join(process.cwd(), 'public_data_sealevel_gold.json');
    const fresh = JSON.parse(readFileSync(p, 'utf-8'));
    if (fresh && fresh.gmsl && Array.isArray(fresh.cities) && Array.isArray(fresh.ice)) payload = fresh;
  } catch (_) {}

  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
  return res.status(200).json(payload);
}
