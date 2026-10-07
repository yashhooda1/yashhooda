#!/usr/bin/env python3
"""RunOS: Apple Health -> running analytics, medallion style.

    bronze  data/bronze_workouts.jsonl   every running workout exactly as exported
    silver  data/silver_runs.csv         deduped, unit-normalized, quality-checked
    gold    public_data_runos_gold.json  aggregates the site renders

Input is the Health app export (Health > profile picture > Export All Health
Data), either the export.zip or the extracted export.xml. The XML is parsed as
a stream, so a multi-gigabyte export stays at a small, flat memory footprint.

Privacy: bronze and silver stay in apple/runos/data/, which is gitignored. The
gold file is committed and public, so it holds running aggregates only. Heart
rate, VO2 max and resting heart rate are left out unless --include-vitals is
passed.

    python3 runos.py ~/Downloads/export.zip
    python3 runos.py ~/Downloads/export.zip --include-vitals

Standard library only.
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
CONFIG_PATH = HERE / "config.json"
GOLD_PATH = HERE.parent.parent / "public_data_runos_gold.json"
SCHEMA_VERSION = 1

RUNNING = "HKWorkoutActivityTypeRunning"
T_DIST = "HKQuantityTypeIdentifierDistanceWalkingRunning"
T_HR = "HKQuantityTypeIdentifierHeartRate"
T_ENERGY = "HKQuantityTypeIdentifierActiveEnergyBurned"

# Record types pulled from the top-level <Record> stream. Everything else in
# the export (steps, sleep, audio exposure, ...) is skipped without being kept.
VITALS = {
    "HKQuantityTypeIdentifierVO2Max": "vo2max",
    "HKQuantityTypeIdentifierRestingHeartRate": "resting_hr",
}
DYNAMICS = {
    "HKQuantityTypeIdentifierRunningPower": "power_w",
    "HKQuantityTypeIdentifierRunningStrideLength": "stride_m",
    "HKQuantityTypeIdentifierRunningGroundContactTime": "ground_contact_ms",
    "HKQuantityTypeIdentifierRunningVerticalOscillation": "vertical_osc_cm",
}

KM_PER_MI = 1.609344
RACES_MI = {"5K": 3.10686, "10K": 6.21371, "Half": 13.1094, "Marathon": 26.2188}

DEFAULT_CONFIG = {
    "source_priority": ["Watch", "Garmin", "Strava"],
    "quality": {"min_miles": 0.25, "max_miles": 60, "min_pace_s": 240, "max_pace_s": 1200},
    "goal_race": None,
}


# ── Parsing helpers ──────────────────────────────────────────────────────────
def parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        return None


def to_float(s) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def miles(value: float | None, unit: str | None) -> float | None:
    if value is None:
        return None
    u = (unit or "").lower()
    if u == "mi":
        return value
    if u == "km":
        return value / KM_PER_MI
    if u == "m":
        return value / 1000 / KM_PER_MI
    return None


def minutes(value: float | None, unit: str | None) -> float | None:
    if value is None:
        return None
    u = (unit or "min").lower()
    return {"min": value, "s": value / 60, "sec": value / 60, "hr": value * 60, "h": value * 60}.get(u)


def temp_f(raw: str | None) -> float | None:
    """HKWeatherTemperature metadata, e.g. '78 degF' or '25.5 degC'."""
    if not raw:
        return None
    parts = raw.split()
    v = to_float(parts[0])
    if v is None:
        return None
    unit = parts[1].lower() if len(parts) > 1 else "degf"
    return round(v * 9 / 5 + 32, 1) if unit == "degc" else round(v, 1)


def humidity_pct(raw: str | None) -> float | None:
    """HKWeatherHumidity is stored scaled by 100: '8500 %' means 85%."""
    if not raw:
        return None
    v = to_float(raw.split()[0])
    if v is None:
        return None
    return round(v / 100 if v > 100 else v, 1)


def open_export(path: Path):
    """Return (binary file handle, closer) for export.xml inside a zip or on disk."""
    if zipfile.is_zipfile(path):
        zf = zipfile.ZipFile(path)
        names = [n for n in zf.namelist() if n.endswith("export.xml") and "cda" not in n.lower()]
        if not names:
            raise SystemExit(f"{path} has no export.xml inside")
        fh = zf.open(names[0])
        return fh, lambda: (fh.close(), zf.close())
    fh = path.open("rb")
    return fh, fh.close


# ── Bronze: stream the export ────────────────────────────────────────────────
def workout_to_bronze(el: ET.Element) -> dict:
    a = el.attrib
    row = {
        "start": a.get("startDate"), "end": a.get("endDate"), "created": a.get("creationDate"),
        "source": a.get("sourceName"), "source_version": a.get("sourceVersion"),
        "duration": to_float(a.get("duration")), "duration_unit": a.get("durationUnit"),
        # Pre-iOS 16 exports carry distance on the Workout element itself.
        "distance": to_float(a.get("totalDistance")), "distance_unit": a.get("totalDistanceUnit"),
        "avg_hr": None, "max_hr": None, "energy_kcal": to_float(a.get("totalEnergyBurned")),
        "indoor": None, "temp_raw": None, "humidity_raw": None, "elevation_raw": None,
    }
    for child in el:
        c = child.attrib
        if child.tag == "WorkoutStatistics":
            t = c.get("type")
            if t == T_DIST and to_float(c.get("sum")) is not None:
                row["distance"], row["distance_unit"] = to_float(c.get("sum")), c.get("unit")
            elif t == T_HR:
                row["avg_hr"], row["max_hr"] = to_float(c.get("average")), to_float(c.get("maximum"))
            elif t == T_ENERGY and to_float(c.get("sum")) is not None:
                row["energy_kcal"] = to_float(c.get("sum"))
        elif child.tag == "MetadataEntry":
            k, v = c.get("key"), c.get("value")
            if k == "HKIndoorWorkout":
                row["indoor"] = v == "1"
            elif k == "HKWeatherTemperature":
                row["temp_raw"] = v
            elif k == "HKWeatherHumidity":
                row["humidity_raw"] = v
            elif k == "HKElevationAscended":
                row["elevation_raw"] = v
    return row


def extract(path: Path) -> tuple[list[dict], dict, dict]:
    """One streaming pass. Returns (bronze workouts, monthly record buckets, stats)."""
    fh, close = open_export(path)
    workouts: list[dict] = []
    buckets: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    stats = {"elements": 0, "workouts_total": 0, "workouts_running": 0, "records_kept": 0,
             "export_date": None}
    wanted = {**VITALS, **DYNAMICS}
    depth = 0
    root = None
    try:
        for event, el in ET.iterparse(fh, events=("start", "end")):
            if event == "start":
                depth += 1
                if root is None:
                    root = el
                continue
            depth -= 1
            if depth != 1:
                continue  # only act when a direct child of <HealthData> closes
            stats["elements"] += 1
            if el.tag == "Workout":
                stats["workouts_total"] += 1
                if el.attrib.get("workoutActivityType") == RUNNING:
                    stats["workouts_running"] += 1
                    workouts.append(workout_to_bronze(el))
            elif el.tag == "Record":
                key = wanted.get(el.attrib.get("type"))
                if key:
                    v, dt = to_float(el.attrib.get("value")), parse_dt(el.attrib.get("startDate"))
                    if v is not None and dt is not None:
                        unit = el.attrib.get("unit", "")
                        if key == "stride_m" and unit == "cm":
                            v /= 100
                        buckets[key][dt.strftime("%Y-%m")].append(v)
                        stats["records_kept"] += 1
            elif el.tag == "ExportDate":
                stats["export_date"] = el.attrib.get("value")
            # Free the finished element and everything before it. Without this the
            # tree keeps every record and memory grows with the size of the export.
            root.clear()
    except ET.ParseError as e:
        raise SystemExit(f"could not parse {path}: {e}")
    finally:
        close()
    return workouts, buckets, stats


# ── Silver: normalize, quality-check, dedupe ─────────────────────────────────
def source_rank(source: str | None, priority: list[str]) -> int:
    s = (source or "").lower()
    for i, needle in enumerate(priority):
        if needle.lower() in s:
            return i
    return len(priority)


def to_silver(bronze: list[dict], cfg: dict) -> tuple[list[dict], dict]:
    q = cfg["quality"]
    rejected: dict[str, int] = defaultdict(int)
    rows = []
    for b in bronze:
        start = parse_dt(b["start"])
        mi = miles(b["distance"], b["distance_unit"])
        mins = minutes(b["duration"], b["duration_unit"])
        if start is None:
            rejected["bad_start_date"] += 1
            continue
        if mi is None or mins is None or mi <= 0 or mins <= 0:
            rejected["missing_distance_or_duration"] += 1
            continue
        pace = mins * 60 / mi
        if not q["min_miles"] <= mi <= q["max_miles"]:
            rejected["distance_out_of_range"] += 1
            continue
        if not q["min_pace_s"] <= pace <= q["max_pace_s"]:
            rejected["pace_out_of_range"] += 1
            continue
        elev = to_float((b["elevation_raw"] or "").split()[0]) if b["elevation_raw"] else None
        rows.append({
            # Local wall-clock date as recorded: a 6am run in Houston belongs to that
            # Houston day, whatever UTC says.
            "date": start.strftime("%Y-%m-%d"), "start_local": start.strftime("%Y-%m-%dT%H:%M:%S"),
            "start_utc": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "miles": round(mi, 3), "minutes": round(mins, 2), "pace_s_per_mi": round(pace, 1),
            "avg_hr": b["avg_hr"], "max_hr": b["max_hr"], "energy_kcal": b["energy_kcal"],
            "indoor": b["indoor"], "temp_f": temp_f(b["temp_raw"]),
            "humidity_pct": humidity_pct(b["humidity_raw"]),
            "elev_gain_ft": round(elev / 30.48, 0) if elev is not None else None,
            "source": b["source"],
        })

    # The same run often lands in Health twice (watch + a synced app). Two rows
    # are the same run when they start within 3 minutes and agree on distance
    # within 10%; the preferred source wins.
    rows.sort(key=lambda r: r["start_utc"])
    kept: list[dict] = []
    dupes = 0
    prio = cfg["source_priority"]
    for r in rows:
        prev = kept[-1] if kept else None
        if prev is not None:
            gap = abs((_utc(r) - _utc(prev)).total_seconds())
            close_dist = abs(r["miles"] - prev["miles"]) <= 0.10 * max(r["miles"], prev["miles"])
            if gap <= 180 and close_dist:
                dupes += 1
                if source_rank(r["source"], prio) < source_rank(prev["source"], prio):
                    kept[-1] = r
                continue
        kept.append(r)
    report = {"bronze": len(bronze), "silver": len(kept), "duplicates_removed": dupes,
              "rejected": dict(rejected)}
    return kept, report


def _utc(r: dict) -> datetime:
    return datetime.strptime(r["start_utc"], "%Y-%m-%dT%H:%M:%SZ")


# ── Gold ─────────────────────────────────────────────────────────────────────
def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())  # Monday, same as the Strava panel


def riegel(time_s: float, dist_mi: float, target_mi: float) -> float:
    return time_s * (target_mi / dist_mi) ** 1.06


def fmt_hms(seconds: float) -> str:
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def hms_to_s(text: str) -> int | None:
    try:
        parts = [int(p) for p in text.split(":")]
    except (AttributeError, ValueError):
        return None
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def weighted_pace(runs: list[dict]) -> float | None:
    mi = sum(r["miles"] for r in runs)
    return round(sum(r["minutes"] for r in runs) * 60 / mi, 1) if mi else None


def build_gold(runs: list[dict], buckets: dict, report: dict, stats: dict, cfg: dict,
               include_vitals: bool, today: date | None = None) -> dict:
    gold = {
        "schema_version": SCHEMA_VERSION,
        "status": "ok" if runs else "awaiting_first_run",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Apple Health export",
        "export_date": stats.get("export_date"),
        "pipeline": report,
        "includes_vitals": include_vitals,
    }
    if not runs:
        return gold

    for r in runs:
        r["_d"] = date.fromisoformat(r["date"])
    last_day = max(r["_d"] for r in runs)
    # "Now" is the last run in the export, not the wall clock: an export from
    # three weeks ago should not look like three weeks of zero mileage.
    today = today or last_day
    gold["data_through"] = last_day.isoformat()
    gold["first_run"] = min(r["_d"] for r in runs).isoformat()

    # Weekly, last 52 weeks, with empty weeks filled in as zeros.
    by_week: dict[date, list[dict]] = defaultdict(list)
    for r in runs:
        by_week[week_start(r["_d"])].append(r)
    this_week = week_start(today)
    weekly = []
    for i in range(51, -1, -1):
        ws = this_week - timedelta(weeks=i)
        wr = by_week.get(ws, [])
        row = {
            "week_start": ws.isoformat(), "miles": round(sum(r["miles"] for r in wr), 1),
            "runs": len(wr), "long_run_mi": round(max((r["miles"] for r in wr), default=0), 1),
            "avg_pace_s_per_mi": weighted_pace(wr),
        }
        if include_vitals:
            hrs = [r["avg_hr"] for r in wr if r["avg_hr"]]
            row["avg_hr"] = round(statistics.fmean(hrs)) if hrs else None
        weekly.append(row)
    gold["weekly"] = weekly

    # Training load from mileage alone (no heart-rate model needed).
    def window_miles(days: int) -> float:
        lo = today - timedelta(days=days - 1)
        return sum(r["miles"] for r in runs if lo <= r["_d"] <= today)
    acute, chronic = window_miles(7), window_miles(28) / 4
    gold["load"] = {
        "acute_7d_mi": round(acute, 1), "chronic_28d_weekly_mi": round(chronic, 1),
        "acwr": round(acute / chronic, 2) if chronic else None,
    }

    # Totals.
    by_year: dict[int, list[dict]] = defaultdict(list)
    for r in runs:
        by_year[r["_d"].year].append(r)
    gold["yearly"] = [{"year": y, "miles": round(sum(r["miles"] for r in rs), 1), "runs": len(rs),
                       "avg_pace_s_per_mi": weighted_pace(rs)} for y, rs in sorted(by_year.items())]
    gold["totals"] = {"runs": len(runs), "miles": round(sum(r["miles"] for r in runs), 1),
                      "hours": round(sum(r["minutes"] for r in runs) / 60, 1),
                      "longest_run_mi": round(max(r["miles"] for r in runs), 1)}

    # Pace vs temperature, from the weather Apple attaches to outdoor workouts.
    bands = [(None, 50, "< 50°F"), (50, 60, "50s"), (60, 70, "60s"), (70, 80, "70s"),
             (80, 90, "80s"), (90, None, "90°F +")]
    heat = []
    for lo, hi, label in bands:
        br = [r for r in runs if r["temp_f"] is not None and not r["indoor"]
              and (lo is None or r["temp_f"] >= lo) and (hi is None or r["temp_f"] < hi)]
        heat.append({"band": label, "runs": len(br), "miles": round(sum(r["miles"] for r in br), 1),
                     "avg_pace_s_per_mi": weighted_pace(br)})
    gold["pace_by_temperature"] = heat

    # Race predictions: Riegel from the single best run of the last 90 days.
    # Training runs are not races, so read these as a conservative floor.
    recent = [r for r in runs if (today - r["_d"]).days <= 90 and r["miles"] >= 3]
    if recent:
        best = min(recent, key=lambda r: riegel(r["minutes"] * 60, r["miles"], RACES_MI["Marathon"]))
        gold["predictions"] = {
            "method": "Riegel (exponent 1.06) from the best run of the last 90 days",
            "basis": {"date": best["date"], "miles": round(best["miles"], 2),
                      "time": fmt_hms(best["minutes"] * 60)},
            "races": {name: fmt_hms(riegel(best["minutes"] * 60, best["miles"], d))
                      for name, d in RACES_MI.items()},
        }

    goal = cfg.get("goal_race")
    if goal and goal.get("date"):
        gold["goal_race"] = readiness(goal, runs, weekly, today, gold.get("predictions"))

    dyn = {k: _monthly(buckets.get(k, {})) for k in DYNAMICS.values() if buckets.get(k)}
    if dyn:
        gold["running_dynamics_monthly"] = dyn
    if include_vitals:
        vit = {k: _monthly(buckets.get(k, {})) for k in VITALS.values() if buckets.get(k)}
        if vit:
            gold["vitals_monthly"] = vit

    for r in runs:
        del r["_d"]
    return gold


def _monthly(bucket: dict[str, list[float]]) -> list[dict]:
    return [{"month": m, "median": round(statistics.median(v), 2), "n": len(v)}
            for m, v in sorted(bucket.items())][-24:]


def readiness(goal: dict, runs: list[dict], weekly: list[dict], today: date, predictions) -> dict:
    """Transparent checklist against targets from config.json. Not a model."""
    race_day = date.fromisoformat(goal["date"])
    last4 = weekly[-5:-1] if len(weekly) >= 5 else weekly  # four completed weeks
    recent_long = max((r["miles"] for r in runs if (today - r["_d"]).days <= 42), default=0)
    peak = max((w["miles"] for w in weekly[-16:]), default=0)
    avg4 = statistics.fmean(w["miles"] for w in last4) if last4 else 0
    parts = []

    def part(label, value, target, unit):
        if not target:
            return
        parts.append({"label": label, "value": round(value, 1), "target": target, "unit": unit,
                      "pct": round(min(value / target, 1) * 100)})
    part("Average week, last 4 weeks", avg4, goal.get("target_weekly_mi"), "mi")
    part("Peak week, last 16 weeks", peak, goal.get("target_peak_week_mi"), "mi")
    part("Longest run, last 6 weeks", recent_long, goal.get("target_long_run_mi"), "mi")
    out = {
        "name": goal.get("name"), "date": goal["date"], "distance": goal.get("distance", "Marathon"),
        "goal_time": goal.get("goal_time"), "days_to_go": (race_day - today).days,
        "weeks_to_go": max((race_day - today).days // 7, 0),
        "components": parts,
        "readiness_pct": round(statistics.fmean(p["pct"] for p in parts)) if parts else None,
    }
    pred = (predictions or {}).get("races", {}).get(out["distance"])
    goal_s = hms_to_s(goal.get("goal_time")) if goal.get("goal_time") else None
    if pred and goal_s:
        out["predicted_time"] = pred
        out["gap_to_goal_s"] = hms_to_s(pred) - goal_s
    return out


# ── IO ───────────────────────────────────────────────────────────────────────
def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        user = json.loads(CONFIG_PATH.read_text())
    except OSError:
        return cfg
    except ValueError as e:
        raise SystemExit(f"{CONFIG_PATH} is not valid JSON: {e}")
    for k, v in user.items():
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", type=Path, help="export.zip or export.xml from the Health app")
    ap.add_argument("--include-vitals", action="store_true",
                    help="also publish heart rate, VO2 max and resting HR aggregates")
    ap.add_argument("--out", type=Path, default=GOLD_PATH, help="gold output path")
    ap.add_argument("--data-dir", type=Path, default=DATA_DIR, help="bronze/silver directory")
    args = ap.parse_args()

    if not args.export.exists():
        print(f"error: {args.export} does not exist", file=sys.stderr)
        return 2
    cfg = load_config()

    print(f"bronze: streaming {args.export} ...")
    bronze, buckets, stats = extract(args.export)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    with (args.data_dir / "bronze_workouts.jsonl").open("w") as fh:
        for b in bronze:
            fh.write(json.dumps(b) + "\n")
    print(f"        {stats['elements']:,} elements scanned, {stats['workouts_running']:,} running "
          f"workouts of {stats['workouts_total']:,} total")

    silver, report = to_silver(bronze, cfg)
    with (args.data_dir / "silver_runs.csv").open("w", newline="") as fh:
        if silver:
            w = csv.DictWriter(fh, fieldnames=list(silver[0].keys()))
            w.writeheader()
            w.writerows(silver)
    print(f"silver: {report['silver']:,} runs kept, {report['duplicates_removed']} duplicates removed, "
          f"rejected {report['rejected'] or 'none'}")

    gold = build_gold(silver, buckets, report, stats, cfg, args.include_vitals)
    args.out.write_text(json.dumps(gold, indent=2) + "\n")
    print(f"gold:   {args.out}")
    if not silver:
        print("no running workouts survived; the site will keep showing the empty state.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
