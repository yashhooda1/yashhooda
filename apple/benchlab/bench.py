#!/usr/bin/env python3
"""Apple Silicon Local LLM Benchmark Lab.

Benchmarks local inference backends on one machine with one fixed prompt suite:

    ollama    -> http://127.0.0.1:11434  (/api/chat)
    llamacpp  -> llama-server            (/v1/chat/completions)
    mlx       -> mlx_lm in-process       (Apple Silicon only)

Medallion layout, same idea as ClimatePulse:

    bronze  apple/benchlab/runs/*.jsonl      one raw record per request
    gold    public_data_apple_bench_gold.json  medians per (backend, model)

Standard library only. `mlx-lm` is imported lazily and only for --backend mlx.

    python3 bench.py run --backend ollama --models qwen3:8b llama3.2:3b
    python3 bench.py run --backend mlx --models mlx-community/Qwen3-8B-4bit
    python3 bench.py run --backend llamacpp --url http://127.0.0.1:8080
    python3 bench.py gold
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import random
import re
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS_DIR = HERE / "runs"
PRICES_PATH = HERE / "cloud_prices.json"
GOLD_PATH = HERE.parent.parent / "public_data_apple_bench_gold.json"
SCHEMA_VERSION = 1


# ── Prompt suite ─────────────────────────────────────────────────────────────
# Fixed and deterministic so runs are comparable across backends and over time.
# Change a prompt -> bump SUITE_VERSION, otherwise old and new runs get mixed.
SUITE_VERSION = "2026.10-a"


def _long_context() -> str:
    """~1.5k words of synthetic pipeline log. Stresses prompt processing."""
    rng = random.Random(1807)
    stations = ["KIAH", "KHOU", "KDAL", "KDFW", "KAUS", "KSAT", "KDEN", "KEWR", "KORD", "KLAX"]
    cats = ["VFR", "MVFR", "IFR", "LIFR"]
    lines = []
    for i in range(110):
        st = rng.choice(stations)
        lines.append(
            f"2026-10-01T{rng.randrange(24):02d}:{rng.randrange(60):02d}Z batch={i:03d} station={st} "
            f"bronze_rows={rng.randrange(40, 400)} silver_rows={rng.randrange(30, 380)} "
            f"dropped={rng.randrange(0, 12)} category={rng.choice(cats)} "
            f"lag_s={rng.randrange(1, 240)} checkpoint=ok"
        )
    return "\n".join(lines)


SUITE = [
    {
        "id": "chat",
        "label": "Short chat",
        "max_tokens": 160,
        "user": "Explain the difference between a data lake and a data warehouse in four sentences.",
    },
    {
        "id": "code",
        "label": "Code generation",
        "max_tokens": 320,
        "user": (
            "Write a PySpark function `dedupe_latest(df, key_cols, ts_col)` that keeps only the "
            "most recent row per key using a window function. Include a short docstring."
        ),
    },
    {
        "id": "json",
        "label": "JSON extraction",
        "max_tokens": 160,
        "user": (
            "Extract a JSON object with keys company, role, location, salary_range, next_step from "
            "this note. Reply with JSON only.\n\n"
            "Note: Talked to Dana at Northwind Energy about the Senior Data Engineer role, hybrid in "
            "Houston. She mentioned 135 to 155k and wants to set up a technical screen next Tuesday."
        ),
    },
    {
        "id": "context",
        "label": "Long context (prompt processing)",
        "max_tokens": 200,
        "user": (
            "Below is a streaming pipeline log. Summarize the three most important operational "
            "observations in a short bulleted list.\n\n" + _long_context()
        ),
    },
]
SYSTEM_PROMPT = "You are a concise senior data engineer."


def messages_for(prompt: dict, nonce: str) -> list[dict]:
    # The nonce changes the very first tokens, so no backend can reuse a cached
    # prompt prefix from the previous repetition. Without it, repeat runs report
    # wildly inflated prompt-processing speeds.
    return [
        {"role": "system", "content": f"[run {nonce}] {SYSTEM_PROMPT}"},
        {"role": "user", "content": prompt["user"]},
    ]


# ── Machine info ─────────────────────────────────────────────────────────────
def _sh(cmd: list[str]) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or None if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def machine_info() -> dict:
    info = {
        "platform": platform.system(),
        "arch": platform.machine(),
        "python": platform.python_version(),
    }
    if platform.system() == "Darwin":
        mem = _sh(["sysctl", "-n", "hw.memsize"])
        info.update(
            chip=_sh(["sysctl", "-n", "machdep.cpu.brand_string"]),
            memory_gb=round(int(mem) / 1024**3) if mem and mem.isdigit() else None,
            cores_performance=_to_int(_sh(["sysctl", "-n", "hw.perflevel0.physicalcpu"])),
            cores_efficiency=_to_int(_sh(["sysctl", "-n", "hw.perflevel1.physicalcpu"])),
            os="macOS " + (_sh(["sw_vers", "-productVersion"]) or "?"),
            model_identifier=_sh(["sysctl", "-n", "hw.model"]),
        )
    else:
        info.update(chip=platform.processor() or None, os=platform.platform(), memory_gb=None)
    return info


def _to_int(s: str | None) -> int | None:
    return int(s) if s and s.isdigit() else None


# ── Optional power sampling (macOS, needs sudo) ──────────────────────────────
POWER_RE = re.compile(r"Combined Power \(CPU \+ GPU \+ ANE\):\s*([\d.]+)\s*mW")


def parse_power_mw(text: str) -> list[float]:
    return [float(m) for m in POWER_RE.findall(text)]


class PowerSampler:
    """Runs `sudo -n powermetrics` in the background and averages package power.

    Run `sudo -v` first so the non-interactive sudo succeeds. If it cannot
    start, sampling is skipped and the run continues without power numbers.
    """

    def __init__(self, enabled: bool):
        self.enabled = enabled and platform.system() == "Darwin"
        self.proc = None
        self.samples: list[float] = []
        self._thread = None
        self._lock = threading.Lock()

    def start(self) -> bool:
        if not self.enabled:
            return False
        try:
            self.proc = subprocess.Popen(
                ["sudo", "-n", "powermetrics", "--samplers", "cpu_power", "-i", "500"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            )
        except OSError:
            self.enabled = False
            return False
        time.sleep(1.2)
        if self.proc.poll() is not None:
            print("  power: could not start powermetrics (run `sudo -v` first); skipping", file=sys.stderr)
            self.enabled = False
            return False
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()
        return True

    def _pump(self):
        for line in self.proc.stdout:
            for mw in parse_power_mw(line):
                with self._lock:
                    self.samples.append(mw)

    def mark(self) -> int:
        with self._lock:
            return len(self.samples)

    def avg_watts_since(self, mark: int) -> float | None:
        with self._lock:
            window = self.samples[mark:]
        return round(statistics.fmean(window) / 1000, 2) if window else None

    def stop(self):
        if self.proc and self.proc.poll() is None:
            # powermetrics runs as root, so a plain terminate() is not permitted.
            subprocess.run(["sudo", "-n", "kill", str(self.proc.pid)],
                           capture_output=True, check=False)


# ── HTTP helpers ─────────────────────────────────────────────────────────────
def _post_stream(url: str, body: dict, timeout: float):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    return urllib.request.urlopen(req, timeout=timeout)


def _get_json(url: str, timeout: float = 10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ── Backends ─────────────────────────────────────────────────────────────────
# Each backend returns one dict per request:
#   prompt_tokens, gen_tokens, prompt_tps, gen_tps, ttft_ms, total_s, load_s,
#   peak_mem_gb, timing_source ("backend" = reported by the engine,
#   "wallclock" = derived here from a stopwatch)
class Ollama:
    name = "ollama"

    def __init__(self, url: str, timeout: float):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def version(self) -> str | None:
        try:
            return _get_json(self.url + "/api/version").get("version")
        except (OSError, ValueError):
            return None

    def model_meta(self, model: str) -> dict:
        meta = {}
        try:
            req = urllib.request.Request(
                self.url + "/api/show", data=json.dumps({"model": model}).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode()).get("details", {})
            meta = {"params": d.get("parameter_size"), "quant": d.get("quantization_level"),
                    "family": d.get("family")}
        except (OSError, ValueError):
            pass
        return meta

    def _loaded_gb(self, model: str) -> float | None:
        try:
            for m in _get_json(self.url + "/api/ps").get("models", []):
                if m.get("name") == model or m.get("model") == model:
                    return round(m.get("size", 0) / 1024**3, 2) or None
        except (OSError, ValueError):
            pass
        return None

    def generate(self, model: str, messages: list[dict], max_tokens: int) -> dict:
        body = {
            "model": model, "messages": messages, "stream": True,
            "options": {"temperature": 0, "seed": 42, "num_predict": max_tokens},
        }
        t0 = time.perf_counter()
        ttft = None
        final = {}
        with _post_stream(self.url + "/api/chat", body, self.timeout) as resp:
            for raw in resp:
                raw = raw.strip()
                if not raw:
                    continue
                chunk = json.loads(raw)
                if chunk.get("error"):
                    raise RuntimeError(chunk["error"])
                msg = chunk.get("message") or {}
                if ttft is None and (msg.get("content") or msg.get("thinking")):
                    ttft = time.perf_counter() - t0
                if chunk.get("done"):
                    final = chunk
        total = time.perf_counter() - t0
        ns = 1e9
        p_n, p_d = final.get("prompt_eval_count"), final.get("prompt_eval_duration")
        g_n, g_d = final.get("eval_count"), final.get("eval_duration")
        return {
            "prompt_tokens": p_n, "gen_tokens": g_n,
            "prompt_tps": round(p_n / (p_d / ns), 2) if p_n and p_d else None,
            "gen_tps": round(g_n / (g_d / ns), 2) if g_n and g_d else None,
            "ttft_ms": round(ttft * 1000, 1) if ttft is not None else None,
            "total_s": round(total, 3),
            "load_s": round(final.get("load_duration", 0) / ns, 3),
            "peak_mem_gb": self._loaded_gb(model),
            "timing_source": "backend",
        }


class LlamaCpp:
    name = "llamacpp"

    def __init__(self, url: str, timeout: float):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def version(self) -> str | None:
        try:
            return str(_get_json(self.url + "/props").get("build_info") or "") or None
        except (OSError, ValueError):
            return None

    def served_model(self) -> str | None:
        try:
            data = _get_json(self.url + "/v1/models").get("data") or []
            return os.path.basename(data[0]["id"]) if data else None
        except (OSError, ValueError, KeyError, IndexError):
            return None

    def model_meta(self, model: str) -> dict:
        m = re.search(r"(Q\d[\w]*|F16|F32|BF16)", model, re.I)
        return {"quant": m.group(1).upper() if m else None}

    def _rss_gb(self) -> float | None:
        pid = _sh(["pgrep", "-n", "llama-server"])
        if not pid:
            return None
        rss_kb = _sh(["ps", "-o", "rss=", "-p", pid.split()[0]])
        return round(int(rss_kb) / 1024**2, 2) if rss_kb and rss_kb.strip().isdigit() else None

    def generate(self, model: str, messages: list[dict], max_tokens: int) -> dict:
        body = {
            "messages": messages, "stream": True, "max_tokens": max_tokens,
            "temperature": 0, "seed": 42, "cache_prompt": False,
            "stream_options": {"include_usage": True},
        }
        t0 = time.perf_counter()
        ttft = None
        timings, usage = {}, {}
        with _post_stream(self.url + "/v1/chat/completions", body, self.timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                chunk = json.loads(payload)
                if chunk.get("error"):
                    raise RuntimeError(str(chunk["error"]))
                if chunk.get("timings"):
                    timings = chunk["timings"]
                if chunk.get("usage"):
                    usage = chunk["usage"]
                for ch in chunk.get("choices") or []:
                    delta = ch.get("delta") or {}
                    if ttft is None and (delta.get("content") or delta.get("reasoning_content")):
                        ttft = time.perf_counter() - t0
        total = time.perf_counter() - t0
        p_n = timings.get("prompt_n") or usage.get("prompt_tokens")
        g_n = timings.get("predicted_n") or usage.get("completion_tokens")
        if timings.get("predicted_per_second"):
            source = "backend"
            gen_tps = round(timings["predicted_per_second"], 2)
            prompt_tps = round(timings["prompt_per_second"], 2) if timings.get("prompt_per_second") else None
        else:
            # Older llama-server builds do not attach `timings` to chat chunks.
            source = "wallclock"
            gen_window = total - (ttft or 0)
            gen_tps = round(g_n / gen_window, 2) if g_n and gen_window > 0 else None
            prompt_tps = round(p_n / ttft, 2) if p_n and ttft else None
        return {
            "prompt_tokens": p_n, "gen_tokens": g_n, "prompt_tps": prompt_tps, "gen_tps": gen_tps,
            "ttft_ms": round(ttft * 1000, 1) if ttft is not None else None,
            "total_s": round(total, 3), "load_s": None,
            "peak_mem_gb": self._rss_gb(), "timing_source": source,
        }


class MLX:
    name = "mlx"

    def __init__(self):
        try:
            import mlx_lm  # noqa: F401
        except ImportError as e:
            raise SystemExit(
                "mlx-lm is not installed. On the Mac: pip install mlx-lm\n"
                f"(import error: {e})"
            )
        self._loaded = (None, None, None)
        self._load_s = None

    def version(self) -> str | None:
        try:
            from importlib.metadata import version
            return version("mlx-lm")
        except Exception:
            return None

    def model_meta(self, model: str) -> dict:
        m = re.search(r"(\d+)\s*-?bit", model, re.I)
        return {"quant": f"{m.group(1)}bit" if m else None}

    def _ensure(self, model: str):
        from mlx_lm import load
        if self._loaded[0] != model:
            t0 = time.perf_counter()
            mdl, tok = load(model)
            self._load_s = round(time.perf_counter() - t0, 3)
            self._loaded = (model, mdl, tok)
        return self._loaded[1], self._loaded[2]

    def generate(self, model: str, messages: list[dict], max_tokens: int) -> dict:
        from mlx_lm import stream_generate
        mdl, tok = self._ensure(model)
        prompt = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        t0 = time.perf_counter()
        ttft = None
        last = None
        for resp in stream_generate(mdl, tok, prompt, max_tokens=max_tokens):
            if ttft is None:
                ttft = time.perf_counter() - t0
            last = resp
        total = time.perf_counter() - t0
        if last is None:
            raise RuntimeError("mlx_lm produced no output")
        peak = getattr(last, "peak_memory", None)
        return {
            "prompt_tokens": getattr(last, "prompt_tokens", None),
            "gen_tokens": getattr(last, "generation_tokens", None),
            "prompt_tps": _r2(getattr(last, "prompt_tps", None)),
            "gen_tps": _r2(getattr(last, "generation_tps", None)),
            "ttft_ms": round(ttft * 1000, 1) if ttft is not None else None,
            "total_s": round(total, 3), "load_s": self._load_s,
            "peak_mem_gb": _r2(peak), "timing_source": "backend",
        }


def _r2(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else None


# ── Run (bronze) ─────────────────────────────────────────────────────────────
def cmd_run(args) -> int:
    if args.backend == "ollama":
        be = Ollama(args.url or "http://127.0.0.1:11434", args.timeout)
        models = args.models
    elif args.backend == "llamacpp":
        be = LlamaCpp(args.url or "http://127.0.0.1:8080", args.timeout)
        # llama-server serves exactly one model; --models is only a display label.
        models = [(args.models[0] if args.models else None) or be.served_model() or "llama-server-model"]
    else:
        be = MLX()
        models = args.models
    if not models:
        print("error: --models is required for this backend", file=sys.stderr)
        return 2

    suite = [p for p in SUITE if not args.prompts or p["id"] in args.prompts]
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    out_path = RUNS_DIR / f"{run_id}-{be.name}.jsonl"
    machine = machine_info()
    be_version = be.version()
    power = PowerSampler(args.power)
    power.start()

    print(f"run {run_id}  backend={be.name} {be_version or ''}  reps={args.reps}  -> {out_path.name}")
    failures = 0
    try:
        with out_path.open("w") as fh:
            for model in models:
                meta = be.model_meta(model)
                print(f"\n{model}")
                for prompt in suite:
                    # Warmup: loads the model and pages weights in. Not recorded as a rep.
                    for rep in range(-args.warmup, args.reps):
                        nonce = uuid.uuid4().hex[:8]
                        rec = {
                            "schema_version": SCHEMA_VERSION, "suite_version": SUITE_VERSION,
                            "run_id": run_id, "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            "backend": be.name, "backend_version": be_version, "model": model, **meta,
                            "prompt_id": prompt["id"], "max_tokens": prompt["max_tokens"],
                            "rep": rep, "warmup": rep < 0, "machine": machine,
                        }
                        mark = power.mark()
                        try:
                            rec.update(be.generate(model, messages_for(prompt, nonce), prompt["max_tokens"]))
                            rec["avg_watts"] = power.avg_watts_since(mark)
                            rec["ok"] = True
                        except (OSError, RuntimeError, ValueError, urllib.error.URLError) as e:
                            rec.update(ok=False, error=f"{type(e).__name__}: {e}"[:300])
                            failures += 1
                        fh.write(json.dumps(rec) + "\n")
                        fh.flush()
                        if rep >= 0:
                            if rec["ok"]:
                                print(f"  {prompt['id']:<8} rep {rep + 1}: {rec.get('gen_tps')} tok/s gen, "
                                      f"{rec.get('prompt_tps')} tok/s prompt, ttft {rec.get('ttft_ms')} ms")
                            else:
                                print(f"  {prompt['id']:<8} rep {rep + 1}: FAILED {rec['error']}")
                        if not rec["ok"]:
                            break  # no point repeating a prompt that errors
                    if not rec["ok"] and prompt is suite[0]:
                        print("  skipping the rest of this model", file=sys.stderr)
                        break  # the model itself is unusable (not pulled, bad tag)
    finally:
        power.stop()

    print(f"\nwrote {out_path}")
    if failures:
        print(f"{failures} request(s) failed; they are recorded and excluded from medians.", file=sys.stderr)
    if not args.no_gold:
        cmd_gold(args)
    return 1 if failures else 0


# ── Gold ─────────────────────────────────────────────────────────────────────
def _median(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(statistics.median(vals), 2) if vals else None


def load_prices() -> dict:
    try:
        return json.loads(PRICES_PATH.read_text())
    except (OSError, ValueError):
        return {}


def build_gold(records: list[dict], prices: dict) -> dict:
    # Latest run wins per (backend, model): re-running a model replaces its row.
    latest_run: dict[tuple, str] = {}
    for r in records:
        key = (r["backend"], r["model"])
        if r.get("suite_version") != SUITE_VERSION:
            continue
        if key not in latest_run or r["run_id"] > latest_run[key]:
            latest_run[key] = r["run_id"]

    results = []
    machine = None
    for (backend, model), run_id in sorted(latest_run.items()):
        rows = [r for r in records if r["backend"] == backend and r["model"] == model
                and r["run_id"] == run_id]
        measured = [r for r in rows if r.get("ok") and not r.get("warmup")]
        errors = sorted({r["error"] for r in rows if not r.get("ok") and r.get("error")})
        if not measured:
            results.append({"backend": backend, "model": model, "run_id": run_id,
                            "prompts": {}, "summary": None, "errors": errors})
            continue
        machine = machine or measured[0].get("machine")
        prompts = {}
        suite_in = suite_out = 0
        for p in SUITE:
            pr = [r for r in measured if r["prompt_id"] == p["id"]]
            if not pr:
                continue
            p_tok, g_tok = _median([r.get("prompt_tokens") for r in pr]), _median([r.get("gen_tokens") for r in pr])
            suite_in += p_tok or 0
            suite_out += g_tok or 0
            prompts[p["id"]] = {
                "gen_tps": _median([r.get("gen_tps") for r in pr]),
                "prompt_tps": _median([r.get("prompt_tps") for r in pr]),
                "ttft_ms": _median([r.get("ttft_ms") for r in pr]),
                "total_s": _median([r.get("total_s") for r in pr]),
                "prompt_tokens": p_tok, "gen_tokens": g_tok, "reps": len(pr),
            }
        watts = _median([r.get("avg_watts") for r in measured])
        gen_tps = _median([v["gen_tps"] for v in prompts.values()])
        first = measured[0]
        summary = {
            "gen_tps": gen_tps,
            # Prompt speed is only meaningful on a prompt long enough to dominate
            # timer overhead, so it is taken from the long-context prompt alone.
            "prompt_tps": (prompts.get("context") or {}).get("prompt_tps"),
            "ttft_ms": (prompts.get("chat") or {}).get("ttft_ms"),
            "peak_mem_gb": max([r["peak_mem_gb"] for r in measured
                                if isinstance(r.get("peak_mem_gb"), (int, float))], default=None),
            "load_s": max([r["load_s"] for r in rows if isinstance(r.get("load_s"), (int, float))],
                          default=None),
            "avg_watts": watts,
            "tokens_per_joule": round(gen_tps / watts, 2) if gen_tps and watts else None,
            "suite_prompt_tokens": suite_in, "suite_gen_tokens": suite_out,
        }
        cloud = []
        for name, p in (prices.get("models") or {}).items():
            try:
                usd = suite_in / 1e6 * float(p["input_per_mtok"]) + suite_out / 1e6 * float(p["output_per_mtok"])
            except (KeyError, TypeError, ValueError):
                continue
            cloud.append({"model": name, "usd_per_1k_suite_runs": round(usd * 1000, 4)})
        local_usd = None
        kwh = prices.get("electricity_usd_per_kwh")
        if watts and isinstance(kwh, (int, float)):
            suite_s = sum(v["total_s"] or 0 for v in prompts.values())
            local_usd = round(watts * suite_s / 3.6e6 * kwh * 1000, 4)
        results.append({
            "backend": backend, "backend_version": first.get("backend_version"),
            "model": model, "params": first.get("params"), "quant": first.get("quant"),
            "run_id": run_id, "timing_source": first.get("timing_source"),
            "prompts": prompts, "summary": summary,
            "cost": {"cloud": cloud, "local_energy_usd_per_1k_suite_runs": local_usd},
            "errors": errors,
        })

    ok = [r for r in results if r["summary"]]
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok" if ok else "awaiting_first_run",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "suite_version": SUITE_VERSION,
        "machine": machine,
        "suite": [{"id": p["id"], "label": p["label"], "max_tokens": p["max_tokens"]} for p in SUITE],
        "prices_as_of": prices.get("as_of"),
        "results": results,
    }


def read_bronze() -> list[dict]:
    records = []
    for path in sorted(RUNS_DIR.glob("*.jsonl")):
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except ValueError:
                print(f"skip {path.name}:{n} (not JSON)", file=sys.stderr)
    return records


def cmd_gold(args) -> int:
    gold = build_gold(read_bronze(), load_prices())
    out = Path(args.out) if getattr(args, "out", None) else GOLD_PATH
    out.write_text(json.dumps(gold, indent=2) + "\n")
    n = sum(1 for r in gold["results"] if r["summary"])
    print(f"gold: {n} model result(s) -> {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="benchmark models on one backend")
    run.add_argument("--backend", required=True, choices=["ollama", "llamacpp", "mlx"])
    run.add_argument("--models", nargs="*", default=[], help="model tags / repo ids")
    run.add_argument("--url", help="server base URL (ollama, llamacpp)")
    run.add_argument("--reps", type=int, default=3, help="measured repetitions per prompt")
    run.add_argument("--warmup", type=int, default=1, help="unrecorded warmup requests per prompt")
    run.add_argument("--prompts", nargs="*", help="subset of prompt ids: " + ", ".join(p["id"] for p in SUITE))
    run.add_argument("--timeout", type=float, default=600)
    run.add_argument("--power", action="store_true", help="sample package power with powermetrics (sudo)")
    run.add_argument("--no-gold", action="store_true", help="do not rebuild the gold file afterwards")
    run.add_argument("--out", help="gold output path (default: repo root)")
    run.set_defaults(fn=cmd_run)

    gold = sub.add_parser("gold", help="rebuild the gold JSON from all bronze runs")
    gold.add_argument("--out")
    gold.set_defaults(fn=cmd_gold)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
