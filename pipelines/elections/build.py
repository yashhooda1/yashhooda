#!/usr/bin/env python3
"""US elections pipeline: bronze -> silver -> gold for the #elections dashboard.

Bronze (raw, not committed; fetched by fetch_bronze.sh):
  tonmcg/US_County_Level_Election_Results_08-24  presidential county returns 2020/2024
  MEDSL/2018-elections-official                  precinct returns (US Senate, governor, US House)
  MEDSL/2022-elections-official                  precinct returns, one zip per state
  MEDSL/2018-elections-unoffical                 election-context-2018.csv (certified 2016 presidential
                                                 county returns + county ACS demographics)
  pipelines/elections/manual/statewide_overrides.csv  certified statewide rows a source is missing
  pipelines/elections/manual/2026_statewide.csv  hand-entered 2026 statewide totals, with source URLs
  data/elections/bronze/2026/<ST>.csv            optional 2026 county files (see README)

Silver (committed): data/elections/silver/county_results.csv
  one row per county x election: the race used for that state, D / R / other / total votes.

Gold (committed, served statically): data/elections/gold/national.json, counties.json

Python 3.9+ standard library only.

Midterm race rule, per state: US Senate (regular before special), else governor, else the
sum of all US House races. A race only counts if both a Democrat and a Republican got at
least 15% statewide; otherwise the next race down is used (e.g. VT/ME 2018 Senate had an
independent incumbent, CA 2018 Senate was D vs D, UT 2022 Senate was R vs independent).
"""
import csv, io, json, os, sys, zipfile, collections, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRONZE = os.environ.get('ELEX_BRONZE', os.path.join(ROOT, '.elex-bronze'))
OUT = os.path.join(ROOT, 'data', 'elections')
MANUAL = os.path.join(ROOT, 'pipelines', 'elections', 'manual')

STATES = {  # fips: (po, name)
    '01': ('AL', 'Alabama'), '02': ('AK', 'Alaska'), '04': ('AZ', 'Arizona'), '05': ('AR', 'Arkansas'),
    '06': ('CA', 'California'), '08': ('CO', 'Colorado'), '09': ('CT', 'Connecticut'), '10': ('DE', 'Delaware'),
    '11': ('DC', 'District of Columbia'), '12': ('FL', 'Florida'), '13': ('GA', 'Georgia'), '15': ('HI', 'Hawaii'),
    '16': ('ID', 'Idaho'), '17': ('IL', 'Illinois'), '18': ('IN', 'Indiana'), '19': ('IA', 'Iowa'),
    '20': ('KS', 'Kansas'), '21': ('KY', 'Kentucky'), '22': ('LA', 'Louisiana'), '23': ('ME', 'Maine'),
    '24': ('MD', 'Maryland'), '25': ('MA', 'Massachusetts'), '26': ('MI', 'Michigan'), '27': ('MN', 'Minnesota'),
    '28': ('MS', 'Mississippi'), '29': ('MO', 'Missouri'), '30': ('MT', 'Montana'), '31': ('NE', 'Nebraska'),
    '32': ('NV', 'Nevada'), '33': ('NH', 'New Hampshire'), '34': ('NJ', 'New Jersey'), '35': ('NM', 'New Mexico'),
    '36': ('NY', 'New York'), '37': ('NC', 'North Carolina'), '38': ('ND', 'North Dakota'), '39': ('OH', 'Ohio'),
    '40': ('OK', 'Oklahoma'), '41': ('OR', 'Oregon'), '42': ('PA', 'Pennsylvania'), '44': ('RI', 'Rhode Island'),
    '45': ('SC', 'South Carolina'), '46': ('SD', 'South Dakota'), '47': ('TN', 'Tennessee'), '48': ('TX', 'Texas'),
    '49': ('UT', 'Utah'), '50': ('VT', 'Vermont'), '51': ('VA', 'Virginia'), '53': ('WA', 'Washington'),
    '54': ('WV', 'West Virginia'), '55': ('WI', 'Wisconsin'), '56': ('WY', 'Wyoming'),
}
PO2FIPS = {po: f for f, (po, _) in STATES.items()}
NAME2FIPS = {n: f for f, (_, n) in STATES.items()}

ELECTIONS = [
    {'year': 2016, 'type': 'presidential'}, {'year': 2018, 'type': 'midterm'},
    {'year': 2020, 'type': 'presidential'}, {'year': 2022, 'type': 'midterm'},
    {'year': 2024, 'type': 'presidential'}, {'year': 2026, 'type': 'midterm'},
]
GOV_OFFICES = {'GOVERNOR', 'GOVERNOR/LIEUTENANT GOVERNOR', 'GOVERNOR AND LIEUTENANT GOVERNOR', 'GOVERNOR & LIEUTENANT GOVERNOR'}
# Alaska reports by state-house district, and Connecticut 2024 by planning region; neither maps to
# the county shapes, so those county maps are filled with the statewide result and flagged.
STATEWIDE_FILL = {('02', 2016), ('02', 2018), ('02', 2020), ('02', 2022), ('02', 2024), ('02', 2026), ('09', 2024)}


def num(x):
    try:
        return int(round(float(str(x).replace(',', ''))))
    except (TypeError, ValueError):
        return 0


# County FIPS changes, mapped onto the codes the map's county shapes use (us-atlas 3).
FIPS_RENAMES = {'46113': '46102'}  # Shannon County SD -> Oglala Lakota County (2015)


def load_overrides():
    out = {}
    with open(os.path.join(MANUAL, 'statewide_overrides.csv'), newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            out[(int(r['year']), PO2FIPS[r['state']])] = {'race': r['race'], 'd': num(r['dem_votes']), 'r': num(r['rep_votes']),
                                                          't': num(r['total_votes']), 'note': r['note'], 'source': r['source_url']}
    return out


# ── presidential (tonmcg) ──────────────────────────────────────────────────
def load_presidential_2016():
    """2016 comes from MEDSL's election-context file (certified county totals). The tonmcg 2016
    file is an election-night scrape that undercounts slow-counting states (CA, AZ, WA, UT, OR)."""
    out = {}
    with open(os.path.join(BRONZE, 'election-context-2018.csv'), newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            fips = str(r['fips']).zfill(5)
            fips = FIPS_RENAMES.get(fips, fips)
            if fips[:2] not in STATES:
                continue
            d, rep, o = num(r['clinton16']), num(r['trump16']), num(r['otherpres16'])
            out[fips] = (d, rep, d + rep + o, r['county'])
    with open(os.path.join(MANUAL, 'statewide_overrides.csv'), newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            if r['year'] == '2016' and r['race'] == 'president':
                st = PO2FIPS[r['state']]
                out[st + '000'] = (num(r['dem_votes']), num(r['rep_votes']), num(r['total_votes']), STATES[st][1])
    return out


def load_presidential(year):
    if year == 2016:
        return load_presidential_2016()
    path = os.path.join(BRONZE, 'tonmcg', f'{year}_US_County_Level_Presidential_Results.csv')
    out = {}
    with open(path, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            fips, st = r['county_fips'].zfill(5), NAME2FIPS.get(r['state_name'])
            if not st:
                continue
            d, rep, t = num(r['votes_dem']), num(r['votes_gop']), num(r['total_votes'])
            if st in ('02', '11'):  # Alaska reports state-house districts, DC (2024) wards -> one row
                key, nm = ('02000', 'Alaska') if st == '02' else ('11001', 'District of Columbia')
                pd, pr, pt, _ = out.get(key, (0, 0, 0, nm))
                out[key] = (pd + d, pr + rep, pt + t, nm)
                continue
            out[FIPS_RENAMES.get(fips, fips)] = (d, rep, t, r['county_name'])
    return out


# ── midterms (MEDSL precinct files) ────────────────────────────────────────
def iter_zip_rows(path):
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.lower().endswith('.csv'):
                continue
            with z.open(name) as f:
                yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8', errors='replace'))


def party_of(*labels):
    """Map MEDSL party labels to D / R / O. Checks the simplified label first, then the detailed one,
    so state affiliates (MN DFL, ND Dem-NPL) count as Democrats."""
    for p in labels:
        p = (p or '').upper()
        if not p:
            continue
        if 'DEMOCRAT' in p or p in ('DFL', 'DEM'):
            return 'D'
        if 'REPUBLICAN' in p or p in ('REP', 'GOP'):
            return 'R'
    return 'O'


# Source party labels that are blank or wrong in the MEDSL files, checked against state canvasses.
PARTY_FIXES = {
    ('2022', '35', 'MICHELLE LUJAN GRISHAM'): 'D', ('2022', '35', 'MARK V RONCHETTI'): 'R',  # NM gov: blank labels
    ('2022', '56', 'THERESA A LIVINGSTON'): 'D',  # WY gov: Democratic nominee labelled Libertarian
}
NOT_VOTES = {'UNDERVOTES', 'OVERVOTES', 'UNDER VOTES', 'OVER VOTES', 'UNDERVOTE', 'OVERVOTE', 'BLANK', 'BLANKS',
             'TOTAL VOTES', 'TOTAL', 'BALLOTS CAST', 'REGISTERED VOTERS', 'SPOILED', 'VOID', 'EXHAUSTED', 'CAST VOTES', 'REJECTED WRITE-INS',
             'TIMES CAST', 'TIMES BLANK VOTED', 'TIMES OVER VOTED', 'NO CANDIDATE'}


def is_true(x):
    return str(x).strip().upper() in ('TRUE', '1', 'T', 'YES')


def add_midterm_rows(rows, acc):
    """acc[(state, race, special)][county_fips] -> Counter(D,R,O), plus county names."""
    for r in rows:
        if (r.get('stage') or 'GEN').upper() != 'GEN':
            continue
        off = (r.get('office') or '').upper().strip()
        if off == 'US SENATE':
            race = 'senate'
        elif off in GOV_OFFICES:
            race = 'governor'
        elif off == 'US HOUSE':
            race = 'house'
        else:
            continue
        st = r.get('state_fips', '').zfill(2)
        if st not in STATES:
            continue
        cf = str(r.get('county_fips') or '').split('.')[0].zfill(5)
        if not cf.startswith(st) or cf == st + '000':
            cf = st + '000'
        if st == '02':
            cf = '02000'
        cf = FIPS_RENAMES.get(cf, cf)
        key = (st, race, is_true(r.get('special')))
        cand = (r.get('candidate') or '').strip().upper() or 'UNKNOWN'
        if cand in NOT_VOTES:
            continue
        mode = (r.get('mode') or 'TOTAL').upper()
        acc['votes'][key][cf][r.get('precinct') or ''][cand][mode] += num(r.get('votes'))
        p = PARTY_FIXES.get((str(r.get('year')), st, cand)) or party_of(r.get('party_simplified'), r.get('party_detailed'))
        acc['party'][(key, cand)][p] += num(r.get('votes'))
        acc['names'][cf] = (r.get('county_name') or '').title()


def collapse(acc):
    """Precinct -> county D/R/O.
    * Some states report a candidate's TOTAL row *and* a vote-method breakdown (early, election day,
      mail) in the same precinct; keep the breakdown, drop TOTAL, so nothing is counted twice.
    * Fusion voting (NY, CT…): a candidate's votes on minor-party lines go to their major party.
      A candidate is D or R if any D/R line carried their name; whichever line got more votes wins."""
    cparty = {}
    for kc, c in acc['party'].items():
        cparty[kc] = 'D' if c['D'] and c['D'] >= c['R'] else 'R' if c['R'] else 'O'
    out, dropped = {}, collections.Counter()
    for key, counties in acc['votes'].items():
        out[key] = {}
        for cf, precincts in counties.items():
            c = collections.Counter()
            for cands in precincts.values():
                for cand, modes in cands.items():
                    if 'TOTAL' in modes and len(modes) > 1:
                        dropped[key] += 1
                        modes = {m: v for m, v in modes.items() if m != 'TOTAL'}
                    c[cparty.get((key, cand), 'O')] += sum(modes.values())
            out[key][cf] = c
    return out, dropped


def pick_race(acc, st):
    for race in ('senate', 'governor', 'house'):
        for special in (False, True):
            counties = acc['votes'].get((st, race, special))
            if not counties:
                continue
            tot = collections.Counter()
            for c in counties.values():
                tot.update(c)
            t = sum(tot.values())
            if race == 'house' or (t and tot['D'] / t >= 0.15 and tot['R'] / t >= 0.15):
                return race, special, counties
    return None, None, {}


# States missing from a MEDSL release, filled from OpenElections county files (same race rule).
SUPPLEMENTS = {  # (year, state fips): (bronze file, office label, race)
    (2018, '18'): ('openelections/in-2018-general-county.csv', 'U.S. SENATE', 'senate'),
}


def load_supplement(year, st, county_fips_by_name):
    rel, office, race = SUPPLEMENTS[(year, st)]
    out = collections.defaultdict(collections.Counter)
    with open(os.path.join(BRONZE, rel), newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            if (r.get('office') or '').strip().upper() != office:
                continue
            cf = county_fips_by_name.get((st, norm_county(r['county'])))
            if cf:
                out[cf][party_of(r.get('party'))] += num(r.get('votes'))
    return {cf: (c['D'], c['R'], sum(c.values()), '', race, False) for cf, c in out.items()}


def norm_county(n):
    n = (n or '').upper().replace(' COUNTY', '').replace(' PARISH', '').replace('.', '').replace("'", '')
    return ' '.join(n.split())


def load_midterm(year, county_fips_by_name):
    dd = collections.defaultdict
    acc = {'votes': dd(lambda: dd(lambda: dd(lambda: dd(collections.Counter)))),
           'party': dd(collections.Counter), 'names': {}}
    base = os.path.join(BRONZE, f'MEDSL-{year}')
    if year == 2018:
        for part in ('SENATE/SENATE_precinct_general.zip', 'STATE/STATE_precinct_general.zip', 'HOUSE/HOUSE_precinct_general.zip'):
            add_midterm_rows(iter_zip_rows(os.path.join(base, part)), acc)
    else:
        d = os.path.join(base, 'individual_states')
        for fn in sorted(os.listdir(d)):
            if fn.endswith('.zip'):
                add_midterm_rows(iter_zip_rows(os.path.join(d, fn)), acc)
    acc['votes'], dropped = collapse(acc)
    if dropped:
        print(f'  {year}: dropped duplicate TOTAL rows in {sum(dropped.values())} precincts', file=sys.stderr)
    out = {}
    for st in STATES:
        race, special, counties = pick_race(acc, st)
        if not race:
            continue
        for cf, c in counties.items():
            out[cf] = (c['D'], c['R'], c['D'] + c['R'] + c['O'], acc['names'].get(cf, ''), race, special)
    for (y, st) in SUPPLEMENTS:
        if y == year and not any(cf[:2] == st for cf in out):
            out.update(load_supplement(year, st, county_fips_by_name))
            print(f'  {year}: {STATES[st][0]} filled from OpenElections', file=sys.stderr)
    return out


# ── 2026 (manual statewide + optional county drop-ins) ─────────────────────
def load_2026(county_fips_by_name):
    statewide, county = {}, {}
    p = os.path.join(MANUAL, '2026_statewide.csv')
    if os.path.exists(p):
        with open(p, newline='', encoding='utf-8') as f:
            for r in csv.DictReader(f):
                d, rep = num(r['dem_votes']), num(r['rep_votes'])
                statewide.setdefault(PO2FIPS[r['state']], []).append({
                    'race': r['race'], 'dem_candidate': r['dem_candidate'], 'rep_candidate': r['rep_candidate'],
                    'd': d, 'r': rep, 't': num(r['total_votes']) or d + rep,  # blank total -> two-party total
                    'status': r['status'], 'as_of': r['as_of'], 'source': r['source_url'],
                })
    # same priority as the midterm rule: Senate first, then governor
    order = {'senate': 0, 'governor': 1, 'house': 2}
    for st in statewide:
        statewide[st].sort(key=lambda s: order.get(s['race'], 9))
    d = os.path.join(OUT, 'bronze', '2026')
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if not fn.endswith('.csv'):
                continue
            with open(os.path.join(d, fn), newline='', encoding='utf-8') as f:
                for r in csv.DictReader(f):
                    cf = (r.get('fips') or '').strip().zfill(5) if (r.get('fips') or '').strip() else \
                        county_fips_by_name.get((PO2FIPS.get((r.get('state') or fn[:2]).upper(), ''), norm_county(r.get('county'))))
                    if not cf:
                        print(f'  warn 2026 {fn}: no FIPS for county {r.get("county")!r}', file=sys.stderr)
                        continue
                    d_, r_ = num(r['dem_votes']), num(r['rep_votes'])
                    county[cf] = (d_, r_, num(r.get('total_votes')) or d_ + r_, r.get('county', ''), r['race'], False)
    return statewide, county


# ── demographics (MEDSL election-context-2018, ACS 2012-2016 5-year) ──────
DEMO = [('hisp', 'hispanic_pct'), ('white', 'white_pct'), ('black', 'black_pct'), ('foreign', 'foreignborn_pct'),
        ('age65', 'age65andolder_pct'), ('inc', 'median_hh_inc'), ('unemp', 'clf_unemploy_pct'),
        ('lesscol', 'lesscollege_pct'), ('rural', 'rural_pct')]


def load_demographics():
    out = {}
    with open(os.path.join(BRONZE, 'election-context-2018.csv'), newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            fips = str(r['fips']).zfill(5)
            rec = {}
            for k, col in DEMO:
                try:
                    rec[k] = round(float(r[col]), 1) if k != 'inc' else int(float(r[col]))
                except (ValueError, TypeError):
                    pass
            if rec:
                rec['pop'] = num(r['total_population'])
                out[fips] = rec
    return out


# ── build ──────────────────────────────────────────────────────────────────
def main():
    silver_rows = []
    by_year = {}
    county_fips_by_name = {}
    for e in ELECTIONS:
        y = e['year']
        print(f'loading {y}…', file=sys.stderr)
        if e['type'] == 'presidential':
            data = {cf: v + ('president', False) for cf, v in load_presidential(y).items()}
            for cf, v in data.items():
                if cf[2:] != '000':
                    county_fips_by_name.setdefault((cf[:2], norm_county(v[3])), cf)
        elif y == 2026:
            sw26, data = load_2026(county_fips_by_name)
        else:
            data = load_midterm(y, county_fips_by_name)
        by_year[y] = data
        for cf, (d, r, t, name, race, special) in sorted(data.items()):
            silver_rows.append({'year': y, 'type': e['type'], 'race': race + ('_special' if special else ''),
                                'state_fips': cf[:2], 'state': STATES[cf[:2]][0], 'fips': cf, 'county': name,
                                'dem': d, 'rep': r, 'other': max(t - d - r, 0), 'total': t})

    os.makedirs(os.path.join(OUT, 'silver'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'gold'), exist_ok=True)
    with open(os.path.join(OUT, 'silver', 'county_results.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(silver_rows[0].keys()))
        w.writeheader()
        w.writerows(silver_rows)

    # state + national aggregates
    states = {}
    for st, (po, name) in STATES.items():
        states[po] = {'fips': st, 'name': name, 'results': {}}
    national = {}
    overrides = load_overrides()
    for e in ELECTIONS:
        y = e['year']
        agg = collections.defaultdict(lambda: [0, 0, 0, None])
        for cf, (d, r, t, _, race, special) in by_year[y].items():
            a = agg[cf[:2]]
            a[0] += d; a[1] += r; a[2] += t; a[3] = race + ('_special' if special else '')
        partial26 = set()
        if y == 2026:
            for st, races in sw26.items():
                expected = sum(1 for cf in by_year[2024] if cf[:2] == st)
                have = sum(1 for cf in by_year[2026] if cf[:2] == st)
                if st not in agg or have < 0.95 * expected:  # partial county file: keep statewide totals
                    if st in agg:
                        partial26.add(st)
                    s = races[0]
                    agg[st] = [s['d'], s['r'], s['t'], s['race']]
        overridden = {}
        for (oy, st), o in overrides.items():
            if oy == y:
                agg[st] = [o['d'], o['r'], o['t'], o['race']]
                overridden[st] = o
        nd = nr = nt = 0
        for st, (d, r, t, race) in agg.items():
            po = STATES[st][0]
            rec = {'race': race, 'd': d, 'r': r, 't': t}
            if st in overridden:
                rec['override_note'] = overridden[st]['note']
                rec['override_source'] = overridden[st]['source']
            if y == 2026 and st in sw26:
                main_race = next((s for s in sw26[st] if s['race'] == race), sw26[st][0])
                rec.update({k: main_race[k] for k in ('dem_candidate', 'rep_candidate', 'status', 'as_of', 'source')})
                rec['county_level'] = any(cf[:2] == st for cf in by_year[y]) and st not in partial26
                rec['other_races'] = [s for s in sw26[st] if s is not main_race]
            if (st, y) in STATEWIDE_FILL:
                rec['statewide_fill'] = True
            states[po]['results'][str(y)] = rec
            nd += d; nr += r; nt += t
        if e['type'] == 'presidential':
            national[str(y)] = {'d': nd, 'r': nr, 't': nt, 'states': len(agg)}
        else:
            national[str(y)] = {'d': nd, 'r': nr, 't': nt, 'states': len(agg),
                                'note': 'Sum of the race shown in each state (Senate, else governor, else US House). Not a national popular vote.'}

    generated = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    meta = {
        'generated_at': generated,
        'elections': ELECTIONS,
        'race_rule': 'Midterms: US Senate (regular before special), else governor, else all US House races summed. A race counts only if a Democrat and a Republican each got 15%+ statewide.',
        'sources': [
            {'name': 'Presidential county returns 2020 and 2024 (tonmcg/US_County_Level_Election_Results_08-24)', 'url': 'https://github.com/tonmcg/US_County_Level_Election_Results_08-24'},
            {'name': 'MIT Election Data + Science Lab, 2018 precinct returns', 'url': 'https://github.com/MEDSL/2018-elections-official'},
            {'name': 'MIT Election Data + Science Lab, 2022 precinct returns', 'url': 'https://github.com/MEDSL/2022-elections-official'},
            {'name': '2016 presidential county returns and county demographics (ACS 2012-2016): MEDSL election-context-2018', 'url': 'https://github.com/MEDSL/2018-elections-unoffical'},
            {'name': '2026: Texas Secretary of State / Decision Desk HQ (unofficial until certified)', 'url': 'https://electionresults.sos.state.tx.us/results.html'},
        ],
        'caveats': [
            '2026 results are unofficial until each state certifies them.',
            'Alaska reports by state-house district, and Connecticut 2024 by planning region, so their county maps show the statewide result.',
            'Midterm totals mix race types across states, so they are not a national popular vote.',
            'Demographics are ACS 2012-2016 estimates; factor charts show association, not cause.',
        ],
    }
    with open(os.path.join(OUT, 'gold', 'national.json'), 'w', encoding='utf-8') as f:
        json.dump({**meta, 'national': national, 'states': states}, f, separators=(',', ':'))

    # counties.json — columnar: names once, then per-year [d, r, t] arrays keyed by fips
    demo = load_demographics()
    names = {}
    for y in by_year:
        for cf, v in by_year[y].items():
            if v[3] and (cf not in names or y in (2020, 2024)):
                names[cf] = v[3]
    years = {}
    for y, data in by_year.items():
        years[str(y)] = {cf: [d, r, t] for cf, (d, r, t, *_rest) in data.items()}
    with open(os.path.join(OUT, 'gold', 'counties.json'), 'w', encoding='utf-8') as f:
        json.dump({'generated_at': generated, 'fields': ['dem', 'rep', 'total'], 'names': names,
                   'results': years, 'demographics_fields': dict(DEMO), 'demographics': demo}, f, separators=(',', ':'))
    for y, data in by_year.items():
        print(f'  {y}: {len(data)} county rows', file=sys.stderr)


def check(tolerance=0.015):
    """Regression gate: gold totals vs certified statewide / national figures in checks.csv."""
    g = json.load(open(os.path.join(OUT, 'gold', 'national.json'), encoding='utf-8'))
    bad = 0
    with open(os.path.join(ROOT, 'pipelines', 'elections', 'checks.csv'), newline='', encoding='utf-8') as f:
        for c in csv.DictReader(f):
            got = g['national'][c['year']] if c['state'] == 'US' else g['states'][c['state']]['results'].get(c['year'], {})
            if c['state'] != 'US' and got.get('race') != c['race']:
                print(f"FAIL {c['year']} {c['state']}: race {got.get('race')} != {c['race']}"); bad += 1; continue
            for k, col in (('d', 'dem_votes'), ('r', 'rep_votes')):
                want = int(c[col]); err = (got.get(k, 0) - want) / want
                ok = abs(err) <= tolerance
                bad += not ok
                print(f"{'ok  ' if ok else 'FAIL'} {c['year']} {c['state']:2} {c['race']:9} {k}: {got.get(k, 0):>11,} vs {want:>11,} ({err:+.2%})")
    print(f'{bad} failure(s)')
    return bad


if __name__ == '__main__':
    if '--check-only' not in sys.argv:
        main()
    if '--check' in sys.argv or '--check-only' in sys.argv:
        sys.exit(1 if check() else 0)
