"""python3 -m unittest discover -s apple/runos/tests"""
import json
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import runos  # noqa: E402
from make_sample_export import build  # noqa: E402

END = datetime(2026, 10, 4, 12, 0, tzinfo=timezone(timedelta(hours=-5)))


class RunOSTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.xml = Path(cls.tmp.name) / "export.xml"
        cls.xml.write_text(build(END), encoding="utf-8")
        cls.cfg = json.loads(json.dumps(runos.DEFAULT_CONFIG))
        cls.cfg["goal_race"] = {"name": "Test Marathon", "date": "2027-01-17", "distance": "Marathon",
                                "goal_time": "2:59:59", "target_weekly_mi": 50,
                                "target_peak_week_mi": 60, "target_long_run_mi": 20}
        cls.bronze, cls.buckets, cls.stats = runos.extract(cls.xml)
        cls.silver, cls.report = runos.to_silver(cls.bronze, cls.cfg)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_only_running_workouts_reach_bronze(self):
        self.assertGreater(self.stats["workouts_total"], self.stats["workouts_running"])
        self.assertEqual(len(self.bronze), self.stats["workouts_running"])

    def test_duplicates_removed_and_watch_preferred(self):
        self.assertGreater(self.report["duplicates_removed"], 30)
        self.assertFalse([r for r in self.silver if r["source"] == "Strava"])

    def test_gps_glitch_rejected(self):
        self.assertEqual(self.report["rejected"].get("pace_out_of_range"), 1)

    def test_units(self):
        self.assertAlmostEqual(runos.miles(10, "km"), 6.2137, places=3)
        self.assertEqual(runos.temp_f("25 degC"), 77.0)
        self.assertEqual(runos.humidity_pct("8500 %"), 85.0)
        self.assertEqual(runos.fmt_hms(10799), "2:59:59")
        self.assertEqual(runos.hms_to_s("2:59:59"), 10799)

    def test_gold_shape_and_privacy_default(self):
        gold = runos.build_gold(list(self.silver), self.buckets, self.report, self.stats, self.cfg, False)
        self.assertEqual(gold["status"], "ok")
        self.assertEqual(len(gold["weekly"]), 52)
        self.assertNotIn("vitals_monthly", gold)
        self.assertNotIn("avg_hr", gold["weekly"][-1])
        self.assertNotIn("avg_hr", json.dumps(gold))
        self.assertAlmostEqual(sum(y["miles"] for y in gold["yearly"]), gold["totals"]["miles"], delta=0.2)
        self.assertEqual(gold["goal_race"]["days_to_go"], 105)
        self.assertEqual(len(gold["goal_race"]["components"]), 3)
        self.assertIn("Marathon", gold["predictions"]["races"])

    def test_vitals_opt_in(self):
        gold = runos.build_gold(list(self.silver), self.buckets, self.report, self.stats, self.cfg, True)
        self.assertIn("vo2max", gold["vitals_monthly"])
        self.assertIn("avg_hr", gold["weekly"][-1])

    def test_weekly_total_matches_silver(self):
        gold = runos.build_gold(list(self.silver), self.buckets, self.report, self.stats, self.cfg, False)
        last = gold["weekly"][-1]
        ws = datetime.fromisoformat(last["week_start"]).date()
        expect = sum(r["miles"] for r in self.silver
                     if ws <= datetime.fromisoformat(r["date"]).date() < ws + timedelta(days=7))
        self.assertAlmostEqual(last["miles"], expect, delta=0.06)

    def test_zip_input_and_empty_export(self):
        z = Path(self.tmp.name) / "export.zip"
        with zipfile.ZipFile(z, "w") as zf:
            zf.write(self.xml, "apple_health_export/export.xml")
        bronze, _, _ = runos.extract(z)
        self.assertEqual(len(bronze), len(self.bronze))
        gold = runos.build_gold([], {}, {}, {}, self.cfg, False)
        self.assertEqual(gold["status"], "awaiting_first_run")


if __name__ == "__main__":
    unittest.main()
