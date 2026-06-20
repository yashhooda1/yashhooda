"""
ClimatePulse  ·  Bronze → Silver → Gold pipeline
Runs weekly via GitHub Actions. Writes public/data/climate_gold.json.

Stations:
  USW00012960 — Houston Intercontinental (IAH)
  USW00014734 — Newark Liberty (EWR)

Env var required:
  NOAA_TOKEN — free token from https://www.ncdc.noaa.gov/cdo-web/token
"""

import os, json, requests
import pandas as pd
import numpy as np
from datetime import date, datetime
from pathlib import Path
from sklearn.linear_model import LinearRegression

# ── Config ──────────────────────────────────────────────────────────────────
STATIONS   = { 'USW00012960': 'IAH', 'USW00014734': 'EWR' }
START_YEAR = 1970
END_YEAR   = date.today().year - 1   # exclude partial current year
NOAA_TOKEN = os.environ.get('NOAA_TOKEN', '')
NOAA_BASE  = 'https://www.ncdc.noaa.gov/cdo-web/api/v2/data'
OUTPUT     = Path(__file__).parent.parent / 'public' / 'data' / 'climate_gold.json'

# ── Bronze ───────────────────────────────────────────────────────────────────
def fetch_year(station_id: str, year: int) -> list[dict]:
    """Fetch GHCND daily TMAX/TMIN for one station-year."""
    params = {
        'datasetid': 'GHCND', 'stationid': f'GHCND:{station_id}',
        'datatypeid': 'TMAX,TMIN', 'startdate': f'{year}-01-01',
        'enddate': f'{year}-12-31', 'units': 'standard', 'limit': 1000, 'offset': 1,
    }
    rows = []
    while True:
        r = requests.get(NOAA_BASE, headers={'token': NOAA_TOKEN}, params=params, timeout=30)
        if r.status_code == 429:
            import time; time.sleep(5); continue
        if r.status_code != 200: break
        body = r.json()
        rows.extend(body.get('results', []))
        rs = body.get('metadata', {}).get('resultset', {})
        if params['offset'] + rs.get('count', 0) > rs.get('count', 0): break
        params['offset'] += 1000
    return rows

def build_bronze(station_id: str) -> pd.DataFrame:
    rows = []
    for yr in range(START_YEAR, END_YEAR + 1):
        rows.extend(fetch_year(station_id, yr))
    df = pd.DataFrame(rows)
    df['date'] = pd.to_datetime(df['date'])
    df = df.pivot_table(index='date', columns='datatype', values='value', aggfunc='first').reset_index()
    df.columns.name = None
    # NOAA stores GHCND in tenths of degrees Celsius → convert to °F
    df = df.rename(columns={'TMAX': 'tmax_f', 'TMIN': 'tmin_f'})
    df['tmax_f'] = df['tmax_f'] / 10
    df['tmin_f'] = df['tmin_f'] / 10
    return df

# ── Silver ───────────────────────────────────────────────────────────────────
def build_silver(bronze: pd.DataFrame) -> pd.DataFrame:
    df = bronze.dropna(subset=['tmax_f', 'tmin_f']).copy()
    df['tmean_f']    = (df['tmax_f'] + df['tmin_f']) / 2
    df['year']       = df['date'].dt.year
    df['month']      = df['date'].dt.month
    df['is_80f_day'] = (df['tmax_f'] >= 80).astype(int)
    return df

# ── Gold ─────────────────────────────────────────────────────────────────────
def slope(years, vals):
    m = LinearRegression().fit(np.array(years).reshape(-1,1), np.array(vals))
    return round(float(m.coef_[0]) * 10, 3)   # per decade

def trendline(years, vals):
    m = LinearRegression().fit(np.array(years).reshape(-1,1), np.array(vals))
    return [round(float(m.predict([[y]])[0]), 2) for y in years]

def build_gold(silver: pd.DataFrame) -> dict:
    # Yearly
    yr = silver.groupby('year').agg(
        avg_tmean=('tmean_f','mean'), avg_tmax=('tmax_f','mean'),
        avg_tmin=('tmin_f','mean'), count_80f=('is_80f_day','sum')
    ).reset_index()
    yrs = yr['year'].tolist()
    yr['trend'] = trendline(yrs, yr['avg_tmean'].tolist())
    slope_annual = slope(yrs, yr['avg_tmean'].tolist())

    # Monthly climatology
    monthly = silver.groupby('month').agg(
        avg_tmax=('tmax_f','mean'), avg_tmin=('tmin_f','mean'), avg_tmean=('tmean_f','mean')
    ).reset_index()

    # Winter (Dec/Jan/Feb) nighttime lows
    win = silver[silver['month'].isin([12,1,2])].groupby('year').agg(
        avg_tmin=('tmin_f','mean')
    ).reset_index()
    wyrs = win['year'].tolist()
    win['trend'] = trendline(wyrs, win['avg_tmin'].tolist())
    slope_winter = slope(wyrs, win['avg_tmin'].tolist())

    # Feb–Mar 80°F heat shift
    fm  = silver[silver['month'].isin([2,3])].groupby('year').agg(
        count_80f=('is_80f_day','sum')
    ).reset_index()
    slope_80f_febmar = slope(fm['year'].tolist(), fm['count_80f'].tolist())

    def to_rec(df): return json.loads(df.to_json(orient='records', double_precision=2))

    return {
        'slope_annual':     slope_annual,
        'slope_winter':     slope_winter,
        'slope_80f_febmar': slope_80f_febmar,
        'yearly':           to_rec(yr),
        'monthly':          to_rec(monthly),
        'winter':           to_rec(win),
        'heat_febmar':      to_rec(fm[['year','count_80f']]),
    }

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    if not NOAA_TOKEN:
        raise EnvironmentError(
            'NOAA_TOKEN not set.\n'
            'Get a free token at https://www.ncdc.noaa.gov/cdo-web/token\n'
            'Then add it as a GitHub Actions secret named NOAA_TOKEN.'
        )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    result = {}
    for sid, label in STATIONS.items():
        print(f'[{label}] Fetching bronze ({START_YEAR}–{END_YEAR})…')
        bronze = build_bronze(sid)
        silver = build_silver(bronze)
        gold   = build_gold(silver)
        gold['station'] = sid
        result[label]   = gold
        print(f'[{label}] annual={gold["slope_annual"]}°F/dec  winter={gold["slope_winter"]}°F/dec')
    result['generated_at'] = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    with open(OUTPUT, 'w') as f:
        json.dump(result, f, separators=(',', ':'))
    print(f'\nWrote {OUTPUT}  ({OUTPUT.stat().st_size:,} bytes)')

if __name__ == '__main__':
    main()
