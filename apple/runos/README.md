# RunOS: Apple Health running pipeline

```bash
# iPhone: Health > profile picture > Export All Health Data, then AirDrop export.zip to the Mac
python3 apple/runos/runos.py ~/Downloads/export.zip
```

| Layer | File | Contents |
| --- | --- | --- |
| Bronze | `data/bronze_workouts.jsonl` | every running workout exactly as exported |
| Silver | `data/silver_runs.csv` | one row per run: deduped, miles and min/mi, quality-checked |
| Gold | `public_data_runos_gold.json` (repo root) | what the site renders |

The export XML is parsed as a stream, so memory stays flat however large the file is. Standard library only.

## Privacy

`data/` is gitignored. Bronze and silver are raw health records and stay on the Mac. The gold file is committed to a public repo, so by default it holds running aggregates only: mileage, pace, run counts, and running-form medians (stride length, ground contact, power). Heart rate, VO2 max and resting heart rate are added only with `--include-vitals`. Open the gold file and read it before you commit it.

## Silver rules

- **Dedup.** The same run often reaches Health twice, from the watch and from a synced app. Two rows are one run when they start within 3 minutes and agree on distance within 10%. `source_priority` in `config.json` picks the survivor.
- **Quality gate.** Runs outside 0.25 to 60 miles or 4:00 to 20:00 per mile are rejected and counted in the gold file's `pipeline.rejected`.
- **Dates** are the local wall-clock date recorded with the workout, and weeks start on Monday to match the Strava panel.

## Gold

`weekly` (52 weeks, empty weeks as zeros), `load` (7-day miles against the 28-day weekly average), `yearly`, `totals`, `pace_by_temperature` (from the weather Apple attaches to outdoor workouts), `predictions` and `goal_race`.

Two of these need a caveat, and the site states both:

- **Predictions** apply Riegel to the best run of the last 90 days. Training runs are not races, so this is a floor.
- **Readiness** is a checklist, not a model: recent average week, peak week and longest run, each as a percentage of a target. The targets in `config.json` are placeholders I chose (50 mi average, 60 mi peak, 20 mi long run). Set them to your plan's real numbers.

"Now" is the date of the last run in the export, so an old export does not show up as weeks of zero mileage.

## Try it without your data

```bash
python3 apple/runos/tests/make_sample_export.py /tmp/sample_export.xml
python3 apple/runos/runos.py /tmp/sample_export.xml --out /tmp/runos_gold.json --data-dir /tmp/runos_data
python3 -m unittest discover -s apple/runos/tests
```

The sample export is synthetic. Keep `--out` pointed away from the repo so it is never published as real training.
