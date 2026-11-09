# US elections pipeline

Builds the data behind the **US Elections 2016–2026** dashboard (`/#elections`):
nationwide, statewide and county results for six elections, with swing and
demographic factors. Python 3.9+ standard library only.

```
fetch_bronze.sh ─► .elex-bronze/ (raw, git-ignored)
                       │
build.py ──────────────┼─► data/elections/silver/county_results.csv   one row per county × election
                       └─► data/elections/gold/national.json          states + national totals, metadata
                           data/elections/gold/counties.json          per-county [dem, rep, total] + ACS demographics
build.py --check ─────────► compares gold with checks.csv (certified totals, ±1.5%)
```

```bash
bash pipelines/elections/fetch_bronze.sh        # ~350 MB, public GitHub sources only
python3 pipelines/elections/build.py --check    # ~2 min; exits 1 if a certified check fails
python3 pipelines/elections/build.py --check-only   # gate the committed gold, no rebuild
```

`.github/workflows/elections.yml` runs `--check-only` on every PR that touches the
pipeline or data, and a manual **Run workflow** fetches, rebuilds, gates and opens a
data-refresh PR.

## Sources

| Election | Race used | Source |
|---|---|---|
| 2016 | President | MEDSL `election-context-2018.csv` (certified county totals); Alaska from the state canvass (`manual/statewide_overrides.csv`) |
| 2018 | Senate → governor → House | MEDSL `2018-elections-official` precinct files; Indiana from OpenElections |
| 2020, 2024 | President | `tonmcg/US_County_Level_Election_Results_08-24` |
| 2022 | Senate → governor → House | MEDSL `2022-elections-official` precinct files; Indiana statewide from the state canvass |
| 2026 | Senate → governor | `manual/2026_statewide.csv` (unofficial) + optional county files (below) |

Demographics: ACS 2012–2016 5-year county estimates from the same MEDSL context file.

The 2016 tonmcg file is **not** used: it is an election-night scrape that is short
by ~2 million votes in slow-counting states (CA, AZ, WA, UT, OR).

## Cleaning rules (all in `build.py`)

- **Midterm race:** US Senate (regular before special), else governor, else all US
  House races summed. A race counts only if a Democrat and a Republican each got
  15%+ statewide (so VT/ME 2018 and CA 2018 fall through to governor).
- **Duplicate vote modes:** when a precinct reports a candidate's TOTAL row *and* an
  early / election-day / mail breakdown, TOTAL is dropped. Done per candidate so
  write-in rows (WA uses mode `WRITE-IN`) don't trigger it.
- **Fusion voting:** votes on minor-party lines (NY Conservative, Working Families…)
  go to the candidate's major party.
- **Non-votes:** undervotes, overvotes, "ballots cast", "cast votes" etc. are dropped.
- **Party fixes:** blank or wrong labels in MEDSL corrected by hand (`PARTY_FIXES`).
- **Geography:** Alaska (state-house districts) and Connecticut 2024 (planning
  regions) don't map to county shapes and are flagged `statewide_fill`; DC 2024
  wards are summed; Shannon County SD → Oglala Lakota (46102).

## Adding 2026 county results

1. Save the certified (or latest unofficial) county export as
   `data/elections/bronze/2026/<ST>.csv`, for example `TX.csv`:

   ```csv
   state,county,race,dem_votes,rep_votes,total_votes
   TX,Harris,senate,900000,500000,1420000
   ```

   `fips` can replace `state,county`. `race` is `senate`, `governor` or `house`.
   County names are matched with or without "County".
2. Update `manual/2026_statewide.csv` with the latest statewide totals and status.
3. Run `build.py --check` (or the workflow). A state whose file covers under 95% of
   its counties keeps its statewide total and stays hatched on the map.
