# Apple Silicon Lab

Mac- and iPhone-side projects behind the [Apple Silicon Lab](https://www.yashhooda.ai/#apple-lab) section of yashhooda.ai.

| Folder | What it is | Runs on | Feeds the site through |
| --- | --- | --- | --- |
| [`benchlab/`](benchlab) | Local LLM benchmark harness for Ollama, MLX and llama.cpp | the Mac | `public_data_apple_bench_gold.json` |
| [`runos/`](runos) | Apple Health export to running analytics, Bronze / Silver / Gold | the Mac | `public_data_runos_gold.json` |
| [`career-agent/`](career-agent) | Siri Shortcut setup for the private `/api/career-agent` endpoint | iPhone, Mac | nothing public |
| [`ios/`](ios) | Two SwiftUI apps: ClimatePulse and Logbook | iPhone | reads `/api/climate` |

The site never invents these numbers. `/api/apple-lab` serves the two gold files at the repo root, and both ship as `"status": "awaiting_first_run"` until the tooling here has been run on real hardware and real data. Until then the dashboards show an empty state.

Publishing results is the same loop as ClimatePulse: run the tool, commit the gold file it rewrites, push, and Vercel redeploys.

This folder is excluded from the Vercel deployment by `.vercelignore`.

## What has and has not been verified

Built and tested off-device, so be clear-eyed about each piece:

- **benchlab**: exercised end to end against mock Ollama and llama-server HTTP servers and a stub `mlx_lm` module. The real engines, and the `--power` sampler, have not been run on an M-series Mac yet.
- **runos**: unit tests pass against a synthetic export (`python3 -m unittest discover -s apple/runos/tests`). Not yet run against a real Health export.
- **career-agent**: the endpoint was tested with Redis and the Anthropic API mocked. The Shortcut itself has to be assembled by hand on the phone.
- **ios**: written without a compiler. Expect to fix a few build errors in Xcode on first open.
