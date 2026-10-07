# Local LLM Benchmark Lab

One fixed prompt suite, three local inference engines, one machine.

```bash
cd apple/benchlab

# Ollama (already running on :11434)
python3 bench.py run --backend ollama --models qwen3:8b qwen2.5:7b-instruct

# MLX, in-process
pip install mlx-lm
python3 bench.py run --backend mlx --models mlx-community/Qwen3-8B-4bit

# llama.cpp: start the server with one model, then point at it
llama-server -m ~/models/Qwen3-8B-Q4_K_M.gguf --port 8080 &
python3 bench.py run --backend llamacpp

# optional: package power draw (asks for sudo once)
sudo -v && python3 bench.py run --backend ollama --models qwen3:8b --power
```

Each `run` appends a raw JSONL file to `runs/` (bronze) and rebuilds `public_data_apple_bench_gold.json` at the repo root (gold). Commit both and push to publish. Re-running a model replaces its row; `python3 bench.py gold` rebuilds without benchmarking.

The model ids above are examples. Use tags you have pulled and MLX repos that exist.

## What is measured

| Metric | Source |
| --- | --- |
| Generation tok/s | reported by the engine; median across prompts of the per-prompt median |
| Prompt-processing tok/s | reported by the engine, taken from the long-context prompt only |
| Time to first token | stopwatch around the streaming request, short-chat prompt |
| Memory | Ollama `/api/ps` size, MLX peak memory, llama-server process RSS |
| Watts | `powermetrics` combined CPU + GPU + ANE power, only with `--power` |
| Cloud cost | the suite's token counts priced from `cloud_prices.json` |

## Reading the numbers honestly

- **Prompt cache.** Every repetition prefixes a random tag to the system prompt, and llama.cpp gets `cache_prompt: false`. Without that, repeat runs reuse the cached prefix and report prompt speeds that are many times too high.
- **Warm-up.** One unrecorded request per prompt loads the model first, so load time does not leak into throughput. Load time is reported separately.
- **Quantization.** A 4-bit MLX model and a Q4_K_M GGUF are close but not identical, and a Q8 model is a different comparison entirely. The gold file and the site table carry the quantization for that reason.
- **Timing source.** llama-server builds that do not attach `timings` to chat responses fall back to stopwatch timing and are marked `wallclock`.
- **Memory is not comparable across engines.** The three numbers are measured three different ways.
- **Cloud cost** compares token billing only. It says nothing about quality: an 8B local model and a hosted frontier model are not interchangeable. Set `electricity_usd_per_kwh` in `cloud_prices.json` and use `--power` to also get the local energy cost. Check the listed prices before publishing; they change.

Changing a prompt in `SUITE` requires bumping `SUITE_VERSION`, which keeps old runs out of the new gold file.
