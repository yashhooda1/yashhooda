#!/usr/bin/env bash
# Fetch raw (bronze) election data into $ELEX_BRONZE (default: .elex-bronze, git-ignored).
# Only needs git + curl; all sources are public GitHub repos.
set -euo pipefail
B="${ELEX_BRONZE:-$(cd "$(dirname "$0")/../.." && pwd)/.elex-bronze}"
mkdir -p "$B/tonmcg"
cd "$B"

for y in 2016 2020 2024; do
  f="${y}_US_County_Level_Presidential_Results.csv"
  [ -s "tonmcg/$f" ] || curl -sSfL -o "tonmcg/$f" "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/$f"
done

[ -s election-context-2018.csv ] || curl -sSfL -o election-context-2018.csv \
  "https://raw.githubusercontent.com/MEDSL/2018-elections-unoffical/master/election-context-2018.csv"

# States missing from a MEDSL release (see SUPPLEMENTS in build.py)
mkdir -p openelections
[ -s openelections/in-2018-general-county.csv ] || curl -sSfL -o openelections/in-2018-general-county.csv \
  "https://raw.githubusercontent.com/openelections/openelections-data-in/master/2018/20181106__in__general__county.csv"

# MEDSL precinct returns: blobless clone, then check out only the files we use (~180 MB total).
sparse() { # repo dir paths...
  local repo="$1" dir="$2"; shift 2
  [ -d "$dir/.git" ] || git clone -q --depth 1 --filter=blob:none --no-checkout "https://github.com/$repo" "$dir"
  git -C "$dir" checkout -q HEAD -- "$@"
}
sparse MEDSL/2018-elections-official MEDSL-2018 SENATE/SENATE_precinct_general.zip STATE/STATE_precinct_general.zip HOUSE/HOUSE_precinct_general.zip
sparse MEDSL/2022-elections-official MEDSL-2022 individual_states

echo "bronze ready in $B"
