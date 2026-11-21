#!/usr/bin/env python3
"""Every race, every cycle: President, US Senate, US House and Governor, 2016-2026.

Builds data/elections/gold/races.json for the race-by-race view of /#elections
(js/elections-races.js), the way Google's election results panel splits a cycle
into Senate / House / Governor (and President in presidential years).

Sources (bronze, fetched by fetch_bronze.sh into .elex-bronze/):
  538/election_results_{senate,house,gubernatorial,presidential}.csv
      FiveThirtyEight election-results: certified results, 2016-2024 (House from 2018)
  constituency-returns/1976-2018-house.csv
      MIT Election Lab constituency returns, used for the 2016 House
  manual/2026_statewide.csv        2026 Senate + governor (unofficial, shared with build.py)
  manual/2026_house.csv            2026 House by district (unofficial; optional)
  manual/governor_holdovers.csv    odd-year governor races 538 doesn't carry (2023, 2025)

Python standard library only.  Usage:
  python3 pipelines/elections/build_races.py            # build gold/races.json
  python3 pipelines/elections/build_races.py --check    # build, then assert known chamber totals
  python3 pipelines/elections/build_races.py --check-only   # gate the committed gold, no rebuild
"""
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
BRONZE = os.environ.get('ELEX_BRONZE', os.path.join(REPO, '.elex-bronze'))
MANUAL = os.path.join(HERE, 'manual')
OUT = os.path.join(REPO, 'data', 'elections', 'gold', 'races.json')

YEARS = [2016, 2018, 2020, 2022, 2024, 2026]
STATES = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC '
          'ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split()

# Electoral votes: 2010 apportionment (2012-2020) and 2020 apportionment (2024-2028)
EV_2010 = dict(AL=9, AK=3, AZ=11, AR=6, CA=55, CO=9, CT=7, DE=3, DC=3, FL=29, GA=16, HI=4, ID=4, IL=20, IN=11, IA=6, KS=6,
               KY=8, LA=8, ME=4, MD=10, MA=11, MI=16, MN=10, MS=6, MO=10, MT=3, NE=5, NV=6, NH=4, NJ=14, NM=5, NY=29, NC=15,
               ND=3, OH=18, OK=7, OR=7, PA=20, RI=4, SC=9, SD=3, TN=11, TX=38, UT=6, VT=3, VA=13, WA=12, WV=5, WI=10, WY=3)
EV_2020 = dict(EV_2010, CA=54, CO=10, FL=30, IL=19, MI=15, MT=4, NY=28, NC=16, OH=17, OR=8, PA=19, TX=40, WV=4)
EV = {2016: EV_2010, 2020: EV_2010, 2024: EV_2020}
DISTRICT_EV = {'M1': 'ME', 'M2': 'ME', 'N1': 'NE', 'N2': 'NE', 'N3': 'NE'}

# Independents who caucus with Democrats; counted in the Democratic caucus for seat totals.
CAUCUS_D = {'Bernard Sanders', 'Bernie Sanders', 'Angus S. King Jr.', 'Angus King', 'Angus S. King, Jr.'}

# Known post-election chamber totals (D caucus incl. independents, R) — the --check gate.
KNOWN = {
    'senate': {2016: (48, 52), 2018: (47, 53), 2020: (50, 50), 2022: (51, 49), 2024: (47, 53)},
    'house': {2016: (194, 241), 2018: (235, 199), 2020: (222, 213), 2022: (213, 222), 2024: (215, 220)},
    'governor': {2016: (16, 33), 2018: (23, 27), 2020: (23, 27), 2022: (24, 26), 2024: (23, 27)},
    'president_ev': {2016: (232, 306), 2020: (306, 232), 2024: (226, 312)},
}
# Results that were never certified: shown, but the seat is counted as vacant.
NON_VOTES = {'NA', 'BLANK VOTE', 'BLANK VOTES', 'OVER VOTE', 'OVER VOTES', 'UNDER VOTE', 'UNDER VOTES', 'SCATTERING', 'VOID', 'BLANK'}
# Office-holders who changed party between elections: (office, state, seat, effective year, new party)
SWITCHES = [('governor', 'WV', '', 2017, 'R')]  # Jim Justice, elected as a Democrat in 2016
# Seats up in 2026, so a race with no result yet counts as pending instead of keeping the old holder.
SCHEDULED = {
    ('senate', 2026): {(s, 'II') for s in 'AL AK AR CO DE GA ID IL IA KS KY LA ME MA MI MN MS MT NE NH NJ NM NC OK OR RI SC SD TN TX VA WV WY'.split()}
    | {('FL', 'III'), ('OH', 'III')},
    ('governor', 2026): {(s, '') for s in 'AK AL AR AZ CA CO CT FL GA HI IA ID IL KS MA MD ME MI MN NE NH NM NV NY OH OK OR PA RI SC SD TN TX VT WI WY'.split()},
}
UNCERTIFIED = {('house', 2018, 'NC', '9'): 'Not certified; a new election was ordered for 2019 (seat vacant)'}


def party_of(bp, name=''):
    bp = (bp or '').upper()
    if name in CAUCUS_D:
        return 'I'
    if 'Murkowski' in name:  # won 2010 as a write-in Republican
        return 'R'
    if bp in ('DEM', 'DFL', 'NPL') or bp.startswith('DEMOCRAT'):
        return 'D'
    if bp in ('REP',) or bp.startswith('REPUBLICAN'):
        return 'R'
    return 'O'


def num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def read(path, enc='utf-8'):
    with open(path, newline='', encoding=enc) as f:
        return list(csv.DictReader(f))


def seat_key(office, s):
    """House 'District 7' -> '7', at-large -> 'AL'; Senate 'Class II' -> 'II'."""
    s = (s or '').strip()
    if office == 'house':
        d = s.replace('District', '').strip()
        return 'AL' if (not d or d.lower().startswith('at') or d == '0') else str(int(d)) if d.isdigit() else d
    return s.replace('Class', '').strip()


def race_record(rows, special=False, stage='general'):
    """Collapse 538 result rows of one race into candidates; fusion lines summed per candidate."""
    rounds = [num(r.get('ranked_choice_round')) for r in rows if r.get('ranked_choice_round')]
    rcv = max(rounds) if rounds else None
    if rcv:
        rows = [r for r in rows if num(r.get('ranked_choice_round')) == rcv]
    cands, other = {}, 0
    for r in rows:
        name = r['candidate_name'].strip()
        v = num(r['votes'])
        if not name:
            other += v or 0
            continue
        key = r.get('candidate_id') or name
        c = cands.setdefault(key, {'n': name, 'p': 'O', 'v': None, 'w': False})
        p = party_of(r['ballot_party'], name)
        if c['p'] == 'O' or p in ('D', 'R', 'I') and c['p'] not in ('D', 'R', 'I'):
            c['p'] = p
        if v is not None:
            c['v'] = (c['v'] or 0) + v
        if r['winner'] == 'true':
            c['w'] = True
        if r.get('unopposed') == 'true':
            c['u'] = True
    return finish(list(cands.values()), other, special=special, stage=stage, rcv=rcv)


def finish(cands, other=0, **meta):
    cands.sort(key=lambda c: -(c['v'] or 0))
    if not any(c['w'] for c in cands) and cands and cands[0]['v']:
        cands[0]['w'] = True
    total = sum(c['v'] or 0 for c in cands) + other
    keep = [c for c in cands[:4] if c['v'] or c['w'] or c.get('u')]
    other += sum(c['v'] or 0 for c in cands[4:])
    win = next((c for c in cands if c['w']), None)
    rec = {'c': [{k: v for k, v in c.items() if v not in (None, False)} for c in keep], 't': total, 'win': win['p'] if win else None}
    if other:
        rec['o'] = other
    if len(cands) == 1 or all(c.get('u') for c in cands if c['w']):
        rec['unopposed'] = True
    for k, v in meta.items():
        if v and v != 'general':
            rec[k] = v
    return rec


# ── 538: group rows into races, pick the deciding stage per seat ──
def load_538(kind, office):
    rows = read(os.path.join(BRONZE, '538', f'election_results_{kind}.csv'))
    by_race = defaultdict(list)
    for r in rows:
        if r['stage'] not in ('general', 'runoff', 'jungle primary'):
            continue
        cyc = num(r['cycle'])
        if not cyc or cyc < 2010:
            continue
        by_race[r['race_id']].append(r)
    # (state, seat, cycle, special) -> {stage: rows}
    seats = defaultdict(dict)
    for rid, rr in by_race.items():
        r0 = rr[0]
        st = r0['state_abbrev']
        if office == 'president':
            seat = ''
        else:
            seat = seat_key(office, r0['office_seat_name'])
        seats[(st, seat, num(r0['cycle']), r0['special'] == 'true')][r0['stage']] = rr
    out = {}
    for key, stages in seats.items():
        first = stages.get('general') or stages.get('jungle primary')
        if not first:
            continue  # a runoff without its first round in the file
        rec = race_record(first, special=key[3])
        ro = stages.get('runoff')
        if ro and any(num(r['votes']) for r in ro):
            final = race_record(ro, special=key[3], stage='runoff')
            final['first'] = {'c': rec['c'], 't': rec['t']}
            rec = final
        out[key] = rec
    return out


def load_medsl_house_2016(runoffs):
    rows = read(os.path.join(BRONZE, 'constituency-returns', '1976-2018-house.csv'), enc='latin-1')
    by = defaultdict(dict)
    for r in rows:
        if r['year'] != '2016' or r['stage'] != 'gen' or r['special'] == 'TRUE':
            continue
        seat = str(max(1, int(r['district'])))  # MEDSL at-large = 0; 538 calls it District 1
        name = r['candidate'].replace('""', '"').strip()
        if not name or name.upper() in NON_VOTES or r['writein'] == 'TRUE' and not r['candidatevotes']:
            continue
        c = by[(r['state_po'], seat)].setdefault(name, {'n': name, 'p': 'O', 'v': 0, 'w': False})
        p = party_of(r['party'], name)
        if p != 'O':
            c['p'] = p
        c['v'] += num(r['candidatevotes']) or 0
    out = {}
    for (st, seat), cands in by.items():
        cs = list(cands.values())
        if len(cs) == 1:
            cs[0]['u'] = True
            cs[0]['w'] = True
            if not cs[0]['v']:
                cs[0]['v'] = None
        rec = finish(cs)
        if (st, seat) in runoffs:  # Louisiana December runoffs (538)
            ro = runoffs[(st, seat)]
            ro['first'] = {'c': rec['c'], 't': rec['t']}
            rec = ro
        out[(st, seat)] = rec
    return out


def load_2026_statewide():
    out = {}
    for r in read(os.path.join(MANUAL, '2026_statewide.csv')):
        d, rp, t = num(r['dem_votes']), num(r['rep_votes']), num(r['total_votes'])
        cands = [{'n': r['dem_candidate'], 'p': 'D', 'v': d, 'w': False}, {'n': r['rep_candidate'], 'p': 'R', 'v': rp, 'w': False}]
        rec = finish(cands, other=max(0, (t or 0) - d - rp))
        rec.update(status=r['status'], as_of=r['as_of'], src=r['source_url'])
        if not t:
            rec['two_party'] = True
        out[(r['state'], r['race'])] = rec
    return out


def load_manual_rows(name):
    """manual/2026_house.csv and manual/2026_senate_extra.csv, one row per candidate:
    state,seat,special,candidate,party,votes,winner,status,as_of,source_url
    party: D, R, I_D (independent caucusing with Democrats), I_R, or O. winner: true/false
    (leave every winner false while a race is uncalled; the leader is then shown as leading)."""
    p = os.path.join(MANUAL, name)
    if not os.path.exists(p):
        return {}
    by = defaultdict(list)
    for r in read(p):
        if r.get('state') and not r['state'].startswith('#'):
            by[(r['state'], r['seat'], r.get('special', '').lower() == 'true')].append(r)
    pmap = {'D': 'D', 'R': 'R', 'I_D': 'I', 'I_R': 'R'}
    out = {}
    for (st, seat, sp), rr in by.items():
        cands = [{'n': r['candidate'], 'p': pmap.get(r['party'].upper(), 'O'), 'v': num(r['votes']), 'w': r['winner'].lower() == 'true'} for r in rr]
        called = any(c['w'] for c in cands)
        rec = finish(cands, special=sp)
        if not called:
            rec['win'], rec['lead'] = None, rec['c'][0]['p'] if rec['c'] else None
            for c in rec['c']:
                c.pop('w', None)
        rec.update(status=rr[0]['status'], as_of=rr[0]['as_of'], src=rr[0]['source_url'])
        out[(st, seat, sp)] = rec
    return out


def held_party(rec, office, st, seat, year):
    w = rec and rec.get('win')
    for (o, s2, seat2, eff, newp) in SWITCHES:
        if (o, s2, seat2) == (office, st, seat) and eff <= year:
            w = newp
    return w


# ── chamber composition after each election ──
def composition(elections, year, keys, office=None, scheduled=()):
    """elections: {(state, seat, cycle, special): rec}. Latest decided race per seat with cycle <= year."""
    latest = {}
    for (st, seat, cyc, sp), rec in elections.items():
        if cyc > year or (st, seat) not in keys:
            continue
        cur = latest.get((st, seat))
        if cur is None or (cyc, sp) > (cur[0], cur[1]):
            latest[(st, seat)] = (cyc, sp, rec)
    seats = {'D': 0, 'R': 0, 'I': 0, 'O': 0, 'pending': 0}
    for k in keys:
        cyc, _, rec = latest.get(k, (None, None, None))
        w = rec and rec.get('win')
        if k in scheduled and (cyc is None or cyc < year):
            w = 'pending'  # up this cycle, result not loaded yet
        for (o, st, seat, eff, newp) in SWITCHES:
            if o == office and (st, seat) == k and cyc is not None and cyc < eff <= year:
                w = newp
        seats[w if w in seats else 'pending'] += 1
    return seats, latest


def check_only():
    """Gate the committed gold/races.json against KNOWN without rebuilding (CI on every PR)."""
    with open(OUT) as f:
        g = json.load(f)
    bad = []
    for ch in ('senate', 'house', 'governor'):
        for y, exp in KNOWN[ch].items():
            s = g['years'][str(y)][ch]['seats']
            if (s['D'] + s['I'], s['R']) != exp:
                bad.append(f'{y} {ch}: D{s["D"] + s["I"]} R{s["R"]}, expected D{exp[0]} R{exp[1]}')
    for y, exp in KNOWN['president_ev'].items():
        e = g['years'][str(y)]['president']['ev']
        if (e['D'], e['R']) != exp:
            bad.append(f'{y} electoral votes: D{e["D"]} R{e["R"]}, expected {exp}')
    for y, Y in g['years'].items():
        for ch in ('senate', 'governor'):
            seats = sum(Y[ch]['seats'].values())
            if seats != Y[ch]['total']:
                bad.append(f'{y} {ch}: {seats} seats, expected {Y[ch]["total"]}')
    print('\n'.join('CHECK FAILED: ' + b for b in bad) or 'races.json: all chamber totals match')
    sys.exit(1 if bad else 0)


def main():
    if '--check-only' in sys.argv:
        return check_only()
    check = '--check' in sys.argv
    sen = load_538('senate', 'senate')
    gov = load_538('gubernatorial', 'governor')
    hou = load_538('house', 'house')
    pre = load_538('presidential', 'president')
    s26 = load_2026_statewide()

    # Senate: classes keyed (state, class)
    sen = {k: v for k, v in sen.items() if k[0] in STATES and k[0] != 'DC'}
    for (st, race), rec in s26.items():
        if race == 'senate':
            special = st in ('FL', 'OH')  # 2026 specials for the Rubio (FL) and Vance (OH) seats, class III
            sen[(st, 'III' if special else 'II', 2026, special)] = dict(rec, special=special) if special else rec
    for (st, seat, sp), rec in load_manual_rows('2026_senate_extra.csv').items():
        sen[(st, seat, 2026, sp)] = rec
    sen_keys = {(st, c) for st in STATES if st != 'DC' for c in ('I', 'II', 'III')}
    sen_keys = {k for k in sen_keys if any((k[0], k[1]) == (s, c) for (s, c, _, _) in sen)}

    # Governor: one seat per state
    gov = {(st, '', cyc, sp): rec for (st, _, cyc, sp), rec in gov.items() if st in STATES and st != 'DC'}
    for r in read(os.path.join(MANUAL, 'governor_holdovers.csv')):
        gov[(r['state'], '', int(r['year']), False)] = {'c': [{'n': r['winner'], 'p': r['party'], 'w': True}], 't': 0, 'win': r['party'],
                                                       'src': r['source_url'], 'holdover_only': True}
    for (st, race), rec in s26.items():
        if race == 'governor':
            gov[(st, '', 2026, False)] = rec
    gov_keys = {(st, '') for st in STATES if st != 'DC'}

    # House: 2016 from MEDSL (+538 Louisiana runoffs), 2018-2024 from 538, 2026 manual
    hou = {k: v for k, v in hou.items() if not k[3] and k[0] in STATES and k[2] >= 2018}  # regular elections; 2016 from MEDSL
    la_ro = {(st, seat): rec for (st, seat, cyc, sp), rec in load_538('house', 'house').items() if cyc == 2016 and rec.get('stage') == 'runoff'}
    for (st, seat), rec in load_medsl_house_2016(la_ro).items():
        hou[(st, seat, 2016, False)] = rec
    for (st, seat, sp), rec in load_manual_rows('2026_house.csv').items():
        hou[(st, seat, 2026, False)] = rec
    for (_, y, st, seat), note in UNCERTIFIED.items():
        if (st, seat, y, False) in hou:
            hou[(st, seat, y, False)].update(win=None, note=note)

    gold = {'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'years': {}, 'sources': [
        {'name': 'FiveThirtyEight election-results (certified Senate, House, governor and presidential results)', 'url': 'https://github.com/fivethirtyeight/election-results'},
        {'name': 'MIT Election Data + Science Lab, constituency returns (2016 US House)', 'url': 'https://github.com/MEDSL/constituency-returns'},
        {'name': '2026: unofficial statewide results (manual/2026_statewide.csv, per-race source links)', 'url': 'https://github.com/yashhooda1/yashhooda/blob/main/pipelines/elections/manual/2026_statewide.csv'},
    ], 'caveats': [
        '2026 results are unofficial until each state certifies them.',
        'Seat totals count the latest election for every seat, including seats not up this cycle; independents who caucus with Democrats (Sanders, King) are counted with the Democrats.',
        'Runoffs (Georgia, Louisiana, Mississippi) show the deciding round; ranked-choice races (Alaska, Maine) show the final round.',
        'House popular vote sums reported votes; Florida and some other states print no votes for unopposed candidates.',
    ]}
    problems = []

    for y in YEARS:
        Y = {}
        # ── Senate ──
        comp, _ = composition(sen, y, sen_keys, 'senate', SCHEDULED.get(('senate', y), ()))
        prev, _ = composition(sen, y - 1, sen_keys, 'senate')  # just before this election (odd-year races included)
        _, before = composition(sen, y - 1, sen_keys)
        races = {}
        for (st, cls, cyc, sp), rec in sen.items():
            if cyc == y:
                r = dict(rec, cls=cls)
                if sp:
                    r['special'] = True
                if (st, cls) in before:
                    r['held'] = held_party(before[(st, cls)][2], 'senate', st, cls, y)
                races.setdefault(st, []).append(r)
        up = sum(len(v) for v in races.values())
        waiting = sorted({st for (st, cls) in SCHEDULED.get(('senate', y), ()) if not any(r['cls'] == cls for r in races.get(st, []))})
        Y['senate'] = {'seats': comp, 'prev': prev, 'total': 100, 'majority': 51, 'up': up + len(waiting), 'states': races, 'pending_states': waiting}
        # ── Governor ──
        comp, _ = composition(gov, y, gov_keys, 'governor', SCHEDULED.get(('governor', y), ()))
        prev, _ = composition(gov, y - 1, gov_keys, 'governor')
        _, before = composition(gov, y - 1, gov_keys)
        races = {st: [dict(rec, held=held_party(before[(st, '')][2], 'governor', st, '', y)) if (st, '') in before else rec]
                 for (st, _, cyc, sp), rec in gov.items() if cyc == y and not rec.get('holdover_only')}
        waiting = sorted({st for (st, _) in SCHEDULED.get(('governor', y), ()) if st not in races})
        Y['governor'] = {'seats': comp, 'prev': prev, 'total': 50, 'majority': 26, 'up': len(races) + len(waiting), 'states': races, 'pending_states': waiting}
        # ── House ──
        hs = defaultdict(dict)
        for (st, seat, cyc, sp), rec in hou.items():
            if cyc == y:
                hs[st][seat] = rec

        def tally(yy):
            t = {'D': 0, 'R': 0, 'I': 0, 'O': 0, 'pending': 0}
            for (st, seat, cyc, sp), rec in hou.items():
                if cyc == yy:
                    w = rec.get('win')
                    t[w if w in t else 'pending'] += 1
            return t
        seats, ptally = tally(y), tally(y - 2)
        if y == 2026 or sum(seats.values()) < 435:
            seats['pending'] += 435 - sum(seats.values())
        states = {}
        pop = {'D': 0, 'R': 0, 't': 0}
        for st, ds in hs.items():
            sc = defaultdict(int)
            for rec in ds.values():
                sc[rec.get('win') or 'pending'] += 1
                for c in rec['c']:
                    if c['p'] in ('D', 'R'):
                        pop[c['p']] += c.get('v') or 0
                pop['t'] += rec['t']
            pc = defaultdict(int)
            for (s2, _, c2, _), r2 in hou.items():
                if s2 == st and c2 == y - 2:
                    pc[r2.get('win') or 'pending'] += 1
            states[st] = {'seats': dict(sc), 'prev': dict(pc) if pc else None, 'districts': dict(sorted(ds.items(), key=lambda kv: (len(kv[0]), kv[0])))}
        Y['house'] = {'seats': seats, 'prev': ptally if y > 2016 else None, 'total': 435, 'majority': 218, 'up': 435, 'popular': pop, 'states': states}
        # ── President ──
        if y in EV:
            states, ev = {}, {'D': 0, 'R': 0, 'O': 0}
            for (st, _, cyc, sp), rec in pre.items():
                if cyc != y or not st:
                    continue
                if st in DISTRICT_EV:
                    states.setdefault(DISTRICT_EV[st], {}).setdefault('districts', {})[st[1]] = rec
                    ev[rec['win'] if rec['win'] in ev else 'O'] += 1
                    continue
                if st not in EV[y]:
                    continue
                s = states.setdefault(st, {})
                s.update(rec)
                last = pre.get((st, '', y - 4, False))
                if last:
                    s['held'] = last['win']
                s['ev'] = EV[y][st]
                at_large = 2 if st in ('ME', 'NE') else EV[y][st]
                ev[rec['win'] if rec['win'] in ev else 'O'] += at_large
            for st in ('ME', 'NE'):
                if st in states and 'districts' in states[st]:
                    split = defaultdict(int)
                    split[states[st]['win']] += 2
                    for d in states[st]['districts'].values():
                        split[d['win']] += 1
                    states[st]['ev_split'] = dict(split)
            prev_ev = Y_prev_ev if y > 2016 else None
            Y['president'] = {'ev': ev, 'prev_ev': prev_ev, 'total': 538, 'majority': 270, 'up': len(states), 'states': {k: [v] for k, v in states.items()}}
            Y_prev_ev = ev
        gold['years'][str(y)] = Y

        # ── gate ──
        for ch in ('senate', 'house', 'governor'):
            if y in KNOWN[ch]:
                s = Y[ch]['seats']
                got = (s['D'] + s['I'], s['R'])
                if got != KNOWN[ch][y]:
                    problems.append(f'{y} {ch}: got D{got[0]} R{got[1]}, expected D{KNOWN[ch][y][0]} R{KNOWN[ch][y][1]} ({s})')
        if y in KNOWN['president_ev']:
            e = Y['president']['ev']
            if (e['D'], e['R']) != KNOWN['president_ev'][y]:
                problems.append(f'{y} electoral votes: got D{e["D"]} R{e["R"]}, expected {KNOWN["president_ev"][y]}')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(gold, f, separators=(',', ':'))
    print(f'wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)')
    for y in YEARS:
        Y = gold['years'][str(y)]
        line = ' · '.join(f"{ch} D{Y[ch]['seats']['D'] + Y[ch]['seats']['I']} R{Y[ch]['seats']['R']}"
                          + (f" pending{Y[ch]['seats']['pending']}" if Y[ch]['seats']['pending'] else '') for ch in ('senate', 'house', 'governor'))
        if 'president' in Y:
            line += f" · EV D{Y['president']['ev']['D']} R{Y['president']['ev']['R']}"
        print(y, line)
    if problems:
        print('\n'.join('CHECK FAILED: ' + p for p in problems))
        if check:
            sys.exit(1)
    elif check:
        print('all chamber totals match')


if __name__ == '__main__':
    main()
