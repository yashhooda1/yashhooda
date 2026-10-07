#!/usr/bin/env python3
"""Write a SYNTHETIC Apple Health export.xml for testing RunOS.

Nothing in the output is real training data. Use it to try the pipeline
before exporting from the Health app, and never publish its gold file:

    python3 tests/make_sample_export.py /tmp/sample_export.xml
    python3 runos.py /tmp/sample_export.xml --out /tmp/runos_gold.json --data-dir /tmp/runos_data
"""
import random
import sys
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=-5))
FMT = "%Y-%m-%d %H:%M:%S %z"


def build(end: datetime, weeks: int = 40, seed: int = 7) -> str:
    rng = random.Random(seed)
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>\n]>',
           '<HealthData locale="en_US">',
           f' <ExportDate value="{end.strftime(FMT)}"/>',
           ' <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>']
    day = end - timedelta(weeks=weeks)
    while day <= end:
        # Noise the pipeline must skip.
        out.append(f' <Record type="HKQuantityTypeIdentifierStepCount" unit="count" '
                   f'startDate="{day.strftime(FMT)}" endDate="{day.strftime(FMT)}" value="{rng.randrange(4000, 16000)}"/>')
        if day.day == 1:
            out.append(f' <Record type="HKQuantityTypeIdentifierVO2Max" unit="mL/min·kg" '
                       f'startDate="{day.strftime(FMT)}" endDate="{day.strftime(FMT)}" value="{rng.uniform(52, 58):.1f}"/>')
            out.append(f' <Record type="HKQuantityTypeIdentifierRunningStrideLength" unit="m" '
                       f'startDate="{day.strftime(FMT)}" endDate="{day.strftime(FMT)}" value="{rng.uniform(1.1, 1.3):.2f}"/>')
        wd = day.weekday()
        if wd != 4:  # rest on Fridays
            mi = rng.uniform(13, 18) if wd == 6 else rng.uniform(3, 8)
            pace = rng.uniform(430, 520)
            start = day.replace(hour=6, minute=rng.randrange(0, 40), second=0)
            end_t = start + timedelta(seconds=mi * pace)
            temp = rng.randrange(48, 96)
            body = (f'  <MetadataEntry key="HKIndoorWorkout" value="0"/>\n'
                    f'  <MetadataEntry key="HKWeatherTemperature" value="{temp} degF"/>\n'
                    f'  <MetadataEntry key="HKWeatherHumidity" value="{rng.randrange(40, 95) * 100} %"/>\n'
                    f'  <MetadataEntry key="HKElevationAscended" value="{rng.randrange(500, 9000)} cm"/>\n'
                    f'  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="{mi:.3f}" unit="mi"/>\n'
                    f'  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="{rng.randrange(138, 165)}" maximum="{rng.randrange(170, 188)}" unit="count/min"/>\n')
            out.append(f' <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="{mi * pace / 60:.2f}" '
                       f'durationUnit="min" sourceName="Sample Apple Watch" startDate="{start.strftime(FMT)}" '
                       f'endDate="{end_t.strftime(FMT)}">\n{body} </Workout>')
            if wd == 2:
                # The same run synced a second time by another app: must be deduped.
                s2 = start + timedelta(seconds=40)
                out.append(f' <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="{mi * pace / 60:.2f}" '
                           f'durationUnit="min" totalDistance="{mi * 1.609344 * 1.01:.3f}" totalDistanceUnit="km" '
                           f'sourceName="Strava" startDate="{s2.strftime(FMT)}" endDate="{end_t.strftime(FMT)}"/>')
        if wd == 0:
            out.append(f' <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="45" durationUnit="min" '
                       f'sourceName="Sample Apple Watch" startDate="{day.strftime(FMT)}" endDate="{day.strftime(FMT)}"/>')
        day += timedelta(days=1)
    # One GPS glitch that the quality gate must reject (2:00/mi).
    out.append(f' <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="10" durationUnit="min" '
               f'totalDistance="5" totalDistanceUnit="mi" sourceName="Sample Apple Watch" '
               f'startDate="{(end - timedelta(days=3, hours=5)).strftime(FMT)}" endDate="{end.strftime(FMT)}"/>')
    out.append('</HealthData>')
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "sample_export.xml"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(build(datetime(2026, 10, 4, 12, 0, tzinfo=TZ)))
    print(f"wrote synthetic export -> {path}")
