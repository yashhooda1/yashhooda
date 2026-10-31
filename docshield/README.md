# DocShield — a security gate for AI document pipelines

**Live demo:** [yashhooda.ai/#docshield](https://yashhooda.ai/#docshield) · **Engine:** [`lib/docshield/`](../lib/docshield) · **Threat model:** [THREAT_MODEL.md](THREAT_MODEL.md)

Every AI app that reads documents (resume screeners, invoice and policy extractors, RAG indexes, email agents) turns uploaded files into model input. That makes each file an attack surface twice over: the classic one (malicious PDFs, disguised executables) and the new one (**indirect prompt injection**: instructions hidden in the document that the model obeys and a human reviewer never sees).

DocShield sits *before* ingestion and answers one question per file: **ALLOW, REVIEW or BLOCK**, with the evidence and the framework mapping (OWASP LLM Top 10 2025, MITRE ATT&CK, MITRE ATLAS, CWE) for every finding.

I built it after doing document extraction at work (Azure Document Intelligence / Azure OpenAI on insurance policy PDFs) and auditing the upload filter on my own site. That filter (`lib/fileGuard.js`) regex-scans the first 10 KB of the raw bytes. It can't see inside compressed PDF streams, which is where nearly all real PDF text lives.

```
bytes ─► file type & polyglot ─► PDF structure ─► text layers ─► injection & evasion ─► secrets & PII ─► score ─► verdict
         magic vs label          JS / Launch /     visible vs     10 phrase families    keys, tokens,     severity   ALLOW
         double ext, RTLO        embedded files    hidden (Tr 3,  Unicode tags, ZW,     private keys,     points     REVIEW
         appended ZIP/EXE        #hex escapes      white, <1pt,   homoglyphs, base64    SSN, Luhn cards              BLOCK
                                 bombs, XFA        off-page),
                                                   metadata
```

## Why this design

* **Zero dependencies, pure function.** `scanBuffer(bytes) → report`. No network, no disk, no model call. The same engine runs in the Vercel function, the CLI, CI and the tests, and it can't be prompt-injected because there is no model in the decision.
* **Read text the way the model will.** It doesn't stop at grepping bytes: it inflates streams, resolves `/ObjStm` object streams, decodes CID fonts through their `ToUnicode` CMaps, and runs a small content-stream interpreter that tracks the graphics state (`q`/`Q`, fill colour, render mode, font size × text matrix × CTM). That's how it separates what a human sees from what an extractor reads.
* **Hidden + instruction = critical.** Hidden text alone can be legitimate design (white headings on dark banners), so it scores low. Injection phrasing alone can be legitimate (an article *about* injection), so it scores high but not critical. When **both** happen together it becomes `DS-PI-010`, and that pairing is the actual attack.
* **Defensive parsing.** Hard limits on decoded bytes per stream (4 MB) and per file (32 MB), stream count, object count and input size. Decompression bombs are reported, not inflated. Every regex has bounded quantifiers, and there's a ReDoS test.
* **Never echo secrets.** Evidence for credentials and PII is redacted (`AKIA••••••••••••LE`, `•••• 1111`). The API never stores uploads, and logs carry only a hash prefix and the verdict.

## Detections

| Rule | Severity | What | Maps to |
|---|---|---|---|
| DS-FT-001 | high | Declared type/extension ≠ magic bytes | ATT&CK T1036.008 · CWE-434 |
| DS-FT-002 | critical | Executable (PE/ELF/Mach-O/script) uploaded as a document | T1204.002, T1036.008 |
| DS-FT-003 | high | Polyglot: PDF header not at byte 0, ZIP/EXE/HTML after `%%EOF` | T1027 |
| DS-FT-004 | high | Double extension (`invoice.pdf.exe`) or RTL-override filename | T1036.007, T1036.002 |
| DS-FT-005 | medium | HTML / SVG active content | T1204.002 · CWE-79 |
| DS-PDF-001 | high → critical | JavaScript (critical when wired to `/OpenAction` or `/AA`) | T1059.007, T1204.002 |
| DS-PDF-002 | medium | Auto-run actions | T1204.002 |
| DS-PDF-003 | critical | `/Launch` action | T1204.002 · CWE-78 |
| DS-PDF-004 / 005 | medium / critical | Embedded files / executable attachment | T1027.009 |
| DS-PDF-006 | high | `#hex` name obfuscation (`/J#61vaScript`) | T1027 |
| DS-PDF-007 | medium | SubmitForm, XFA, RichMedia, GoToR/E, ImportData | T1204.002 |
| DS-PDF-008 | medium | Encrypted (content not inspectable) | T1027 |
| DS-PDF-009 | low | Incremental updates (shadow-attack surface) | — |
| DS-PDF-010 | high | Decompression bomb / oversize | OWASP LLM10 · CWE-409 |
| DS-PDF-011 | medium (low for white-only) | Hidden text layer | LLM01 · ATLAS AML.T0051.001 |
| DS-PI-001 … 009 | medium–high | Override, role/delimiter spoofing, AI-addressed text, persona hijack, markdown-image exfiltration, secrecy, system-prompt extraction, output/decision tampering, tool coercion | LLM01 / LLM05 / LLM07 · AML.T0051 |
| DS-PI-010 | critical | Injection concealed from humans (hidden layer, metadata, Unicode tags, zero-width, homoglyph, base64) | LLM01 · AML.T0051.001 · T1027 |
| DS-UNI-001 … 005 | low–critical | Unicode tag "ASCII smuggling", zero-width splitting, bidi overrides, mixed-script homoglyphs, base64-encoded instructions | T1027 |
| DS-SEC-001 … 005 | medium–critical | AWS / GitHub / Slack / Stripe / Anthropic / OpenAI / Google / Azure keys, private keys, DB connection strings, JWTs, high-entropy password fields | LLM02 · T1552.001/.004 · CWE-798 |
| DS-PII-001 … 003 | info–high | SSNs, Luhn-valid card numbers, contact details | LLM02 · CWE-359 |

**Scoring:** critical 60 · high 30 · medium 12 · low 4 · info 0 (repeat hits of the same rule from another text layer count half). Any critical finding or a score ≥ 60 is **BLOCK**. A score ≥ 12 is **REVIEW**. Below that is **ALLOW**.

## Results

`node docshield/eval.js` runs a labeled corpus of 26 attack and 13 benign documents ([`lib/docshield/fixtures.js`](../lib/docshield/fixtures.js), all generated in code with inert payloads) through DocShield **and** through the site's existing `fileGuard`:

| gate | caught | missed | false alarms | recall | FPR |
|---|---|---|---|---|---|
| **DocShield** | 26 | 0 | 1 | 100% | 8% |
| fileGuard (baseline) | 2 | 24 | 1 | 8% | 8% |

p50 latency 0.3 ms, p95 ≈ 15 ms (the decompression-bomb case) on a laptop-class CPU.

**How to read this honestly:** I wrote the corpus alongside the detector, so 100% recall means the regression suite passes, not that real-world recall is 100%. The useful signals are elsewhere:
1. The baseline gap is structural. fileGuard can't see compressed text, file magic or Unicode tricks, and those are fixed by design rather than by tuning.
2. The false positive is real and kept on purpose. A blog post *about* prompt injection quotes "ignore previous instructions" and gets REVIEW. Phrase matching can't tell use from mention; that's the case for a model-based second stage (see roadmap).
3. Two real Chromium-generated PDFs (CID fonts, ToUnicode CMaps, glyph-by-glyph positioning) live in [`test/fixtures`](test/fixtures) so the parser is tested on what real tools produce, not only on PDFs I wrote by hand.

CI (`.github/workflows/docshield.yml`) runs the unit tests and fails the build if recall drops below 95% or FPR rises above 15%.

## Use it

```bash
# library
import { scanBuffer, scanText, toSarif } from './lib/docshield/index.js';
const report = scanBuffer(fs.readFileSync('resume.pdf'), { fileName: 'resume.pdf', declaredMime: 'application/pdf' });

# CLI — exit 1 if anything is at/above --fail-on (default: block)
node docshield/cli.js uploads/ --fail-on review --sarif docshield.sarif

# tests + eval
node --test docshield/test/*.test.js
node docshield/eval.js --check

# HTTP (site)
POST /api/docshield  { fileName, mimeType, data: <base64> }   # or { text } or { sample: "<corpus id>" }
```

The SARIF output loads into GitHub code scanning (`github/codeql-action/upload-sarif`) with `security-severity` set on every rule, so document findings sort alongside SAST results.

## Limitations (on purpose, documented)

* **Not a malware sandbox.** It flags JavaScript but doesn't emulate it, and it doesn't parse ZIP/OOXML internals. Office files get type and polyglot checks only.
* **No OCR.** A scanned image of an injection is invisible to it. The report says "no extractable text" so the pipeline can route the file to OCR before the model sees it.
* **Fonts without a ToUnicode map** (rare, mostly hand-made) are counted and reported rather than guessed.
* **Phrase rules are English-first** and can be paraphrased around. That's why the verdict has a REVIEW tier and why model output must still be treated as untrusted (OWASP LLM05).
* **Text covered by an opaque shape** (text drawn, then a rectangle painted over it) isn't detected yet. That needs a z-order model of the page.

## Roadmap

1. Shadow-mode integration in front of `api/analyze.js` uploads: log DocShield verdicts next to fileGuard's for two weeks, then enforce.
2. Second stage for REVIEW items: a small classifier (or an LLM judge working only on the *extracted snippet*, isolated from tools) to separate "mentions an injection" from "is an injection".
3. Occlusion detection (text under filled rectangles) and OOXML (`word/document.xml`) text extraction.
