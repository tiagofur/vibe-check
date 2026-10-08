# VibeCheck

[![CI](https://github.com/tiagofur/vibe-check/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagofur/vibe-check/actions/workflows/ci.yml)
[![Self-audit](https://github.com/tiagofur/vibe-check/actions/workflows/self-audit.yml/badge.svg)](https://github.com/tiagofur/vibe-check/actions/workflows/self-audit.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Tests](https://img.shields.io/badge/tests-75%20passing-emerald)](tests)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/tiagofur)

> **Adversarial due diligence for repositories in the vibe coding era.** Did an AI write that repo at 3 AM? Find out **before you clone**.
>
> **Before you ship it, VibeCheck it.**

[Read in Spanish](README.es.md) · [Quick start](#quick-start) · [Docs](#documentation) · [API](#api) · [Roadmap](#roadmap) · [Contributing](#contributing) · [Issues](https://github.com/tiagofur/vibe-check/issues)

VibeCheck audits **entire repositories** — public GitHub repos, local folders, or loose snippets — and produces a **Vibe Score 0-100** with a verdict: `SHIP IT 🚀` / `ALMOST THERE 🟡` / `SUSPICIOUS 🤨` / `DANGER 🚨`.

Unlike in-session AI assistants (Claude Code, Cursor, Copilot) that review *their own output when you ask*, VibeCheck does **independent due diligence**: it didn't write the code, so it has no incentive to defend it.

---

## Why this exists

Vibe coding is here to stay: people ship AI-generated code to production without deep review. The failure modes are new and specific:

1. **Nobody does due diligence before cloning.** When you grab a boilerplate, a template, or buy an "AI-built" app, no one hands you an independent, adversarial trust report of the whole repo.
2. **Cross-file hallucinations.** AI calls `getUserById()` which exists in **no file**, imports `./lib/auth` which was never created, or uses phantom npm packages (slopsquatting). Detecting this requires an **import graph of the entire repo** — no IDE does it systematically.
3. **Structural checks must not depend on an LLM.** Missing deps in `package.json`, broken imports, committed `.env` files, dead dependencies, orphan files: these should be **verifiable, reproducible code** — not a model's opinion.

VibeCheck is built for exactly that gap.

## What it detects

| Category | Weight | Examples |
|---|---|---|
| 🔒 Security | 0.30 | Hardcoded secrets, committed `.env`, SQL/XSS injection, unauthenticated endpoints |
| 👻 Hallucinations | 0.30 | Imports of non-existent packages, invented APIs, calls to local modules that were never created |
| 🐛 Bugs | 0.25 | Off-by-one, unhandled nulls, race conditions, **fake tests** (that cannot fail) |
| 🏭 Overengineering | 0.15 | Unjustified abstractions, dead code, unused dependencies, orphan files |

On top of that, a **deterministic engine** (100% reproducible, zero LLM) verifies structural checks: import graph vs. manifest (including **tsconfig/jsconfig path aliases**), phantom dependencies, broken imports, secret patterns, committed `.env`, dead deps, and files nobody imports. It also ships a **fake-test detector**: suites that cannot fail (zero assertions), tautological assertions (`expect(true).toBe(true)`), empty test bodies and skipped tests — in JS/TS and Python.

Every score comes with its receipt: the **"Why N/100?" breakdown** shows how many points each group of findings cost (severity × category weight) and whether a hard ceiling was applied.

## How it works

1. **Download + import graph** — walks the repo tree (tarball from GitHub, no API keys needed) and builds the import graph against the manifest. Deterministic and verifiable.
2. **Adversarial triage** — files are ranked by risk (auth > payments > secrets > DB > API) and the ~30 hottest are deep-audited by AI in batches, hunting cross-file hallucinations and fake tests.
3. **Verdict with evidence** — findings with file, line and suggested fix; vibe coding signals; and a deterministic score with a **hard ceiling**: a critical security or hallucination finding caps the score at ≤35 (DANGER).

## Screenshots

| Home — the analyzer | A healthy repo | A vibe-coded repo |
|---|---|---|
| ![VibeCheck home](docs/assets/hero.png) | ![SHIP IT report](docs/assets/report-ship-it.png) | ![DANGER report](docs/assets/report-danger.png) |

Real audits: `sindresorhus/slugify` scores **98/100 SHIP IT** (note the trend sparkline: ↗ +5 pts vs the previous audit), while a synthetic vibe-coded folder scores **35/100 DANGER** with every planted issue caught — phantom dependency, broken import, 3 secrets, committed `.env`, dead dep and an orphan file.

---

## Documentation

### Modes

- **🐙 GitHub repo** — public repos work with zero setup. Private repos: paste a Personal Access Token (scope `repo`) per audit — it is never stored — or set `GITHUB_TOKEN` on the server.
- **📁 Local folder** — drag & drop or pick a folder; runs the same pipeline.
- **✂️ Snippet** — paste code for a quick audit.
- **🔀 Diff mode** — the regression gate. Enter a base ref (tag/branch/sha) and VibeCheck downloads both trees, diffs them, and **audits and scores only the changed files**. Pre-existing findings are excluded from the score and counted. Perfect for PRs.
- **📈 Trend** — every full audit feeds a historical series per repo: the report shows a sparkline with the score evolution and the delta vs the previous audit (`↗ +5 pts`), and the badge shows the trend arrow. Diff audits are excluded from trends (they score changes, not the repo).
- **🔥 Roast mode** — the serious report stays serious. Hit "Modo roast" (web) or `--roast` (CLI) for a deterministic, shareable sarcastic summary of the damage. Same repo, same roast — it's reproducible like everything else here.

### Quick start

Requirements: [Bun](https://bun.sh) (or Node 20+), and `z-ai-web-dev-sdk` credentials for the AI backend.

```bash
git clone https://github.com/tiagofur/vibe-check.git
cd vibe-check
bun install

# environment
cp .env.example .env

# database (audit history)
bun run db:generate && bun run db:push

# http://localhost:3000
bun run dev
```

> The AI SDK (`z-ai-web-dev-sdk`) is configured per its own docs (`.z-ai-config` file); it is never used client-side. Without credentials the web app **falls back to deterministic-only reports** automatically (see the ⚡ badge on the report) — and the CLI never needed it.

| Command | What it does |
|---|---|
| `bun run dev` | Dev server on :3000 |
| `bun run build` / `bun run start` | Standalone production build / run |
| `bun run lint` / `bun run typecheck` | ESLint / `tsc --noEmit` |
| `bun run test` / `bun run test:watch` | Engine test suite (Vitest) |
| `bun run db:push` / `db:generate` | Sync Prisma schema / regenerate client |

### CLI: audit without a server

The deterministic engine runs locally — no server, no LLM, no database:

```bash
bun cli.ts ./my-project            # human-readable report
bun cli.ts ./my-project --json     # machine-readable (includes scoreExplanation + roast)
bun cli.ts ./my-project --roast    # adds the 🔥 roast section
bun cli.ts . --exclude tests       # exclude paths (repeatable)
echo $?                            # 1 if verdict is SUSPICIOUS or DANGER → CI gate
```

### API

| Endpoint | Description |
|---|---|
| `POST /api/analyze` | Audit a snippet `{ code, language?, title? }` · 20 req/h per IP |
| `POST /api/analyze-repo` | Audit a repo or folder · 10 req/h per IP · with `Accept: text/event-stream` responds NDJSON progress (`{type:'progress', phase, pct, message}` → `{type:'done'}`) |
| `GET /api/checks` · `/[id]` · `DELETE` | Snippet history / detail / delete |
| `GET /api/repo-checks` · `/[id]` · `DELETE` | Repo history / detail / delete |
| `GET /api/repo-trend?repo=owner/name` | Score time series (diff audits excluded) |
| `GET /api/badge/[owner]/[repo].svg` | SVG badge with the latest Vibe Score + trend arrow (never 404s) |

**Content cache**: each repo version is audited once — the cache key is the sha256 of the downloaded tarball (or folder contents). Re-auditing an unchanged repo responds instantly without burning LLM credits.

### VibeCheck on your Pull Requests

Copy [`docs/vibecheck-action.yml`](docs/vibecheck-action.yml) to `.github/workflows/vibecheck.yml` in any repo, set the `VIBECHECK_URL` secret to your instance, and every PR gets a comment with its Vibe Score, the "why this score" breakdown and the badge.

- **Diff mode built in**: the workflow audits the PR head against `github.event.pull_request.base.sha`, so the score reflects only what the PR changed.
- **Quality gate**: define the repo variable `VIBECHECK_MIN_SCORE` (default `60`) and the job fails when the score drops below it.

### VibeCheck audits VibeCheck

The best dogfooding is auditing the auditor. Every push to `main` runs the deterministic CLI against this repo's own source and publishes the score, the point-by-point breakdown and the roast to the [job summary](https://github.com/tiagofur/vibe-check/actions/workflows/self-audit.yml).

Two exclusions, on purpose and in the open: `tests/` (the versioned fixture plants defects on purpose) and `src/lib/samples.ts` (example snippets with fake secrets — the scanner catches them, which is exactly the point).

### Badge in your README

After auditing a repo on your instance:

```markdown
![VibeCheck](https://your-instance.example.com/api/badge/owner/repo.svg)
```

### Privacy by design

Audited file contents are **never persisted** — only the report (scores, findings, metadata) stays on your instance. Pasted snippets are not stored either.

### Honest limits

- **Repos of any size work** — the tarball is read as a stream: the full tree is counted and content is kept for the top-120 files by risk (guard: 1.5 GB decompressed).
- Diff mode reads both trees up to 4,000 files; beyond that the comparison is approximate.
- Local folders: up to 800 files (≤256 KB each, content read truncated at 64 KB, 8 MB total). `node_modules` and friends are never traversed.
- AI-assisted findings can be wrong: **not a substitute for human code review**. Deterministic findings (`origin: scan`) are reproducible.
- Rate limiting is in-memory per instance (swap for Redis if you scale out).

## Project status

**v0.1.0** — functional and actively developed. Born as a vibe-coded project, audited by itself, and hardened step by step: clean build (no ignored type errors), 75 tests with a versioned "vibe-coded" fixture, CI on every push, rate limiting, content cache, real streaming progress, diff mode, private repos, local CLI, historical trends, explainable scores, a deterministic fake-test detector and roast mode.

## Roadmap

- [ ] GitHub OAuth (per-session tokens instead of pasting PATs)
- [ ] Diff mode for local folders (against a saved snapshot)
- [ ] Publish the CLI to npm (`npx vibecheck`)
- [ ] Score attribution in trends ("the changes since v1.2 cost you 12 points")

## Contributing

The best dogfooding is auditing the auditor: clone, run `bun run lint && bun run typecheck && bun run test`, and read [`src/lib/repo-scan.ts`](src/lib/repo-scan.ts) — the deterministic engine is pure and easy to extend with new checks.

The workflow for new checks: **plant the issue first** in [`tests/fixtures/vibe-coded-repo/`](tests/fixtures/vibe-coded-repo) (a mini vibe-coded repo with intentional defects), then make the engine detect it. The suite demands every planted issue is caught and zero false positives appear.

## Support

If VibeCheck saves you from cloning (or shipping) an AI disaster, consider:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-tiagofur-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/tiagofur)

## License

[MIT](LICENSE) — built with 💚 for the developer community.
