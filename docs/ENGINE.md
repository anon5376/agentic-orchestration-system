# AOS local engine

The dashboard is no longer only an illustrative docket. A Node engine now stores research state on disk and exposes it through HTTP and a CLI.

## Start

From the repository root:

```bash
npm test
npm run engine
```

In a second terminal:

```bash
npm run dev
```

Or both:

```bash
npm run dev:all
```

Then open `http://127.0.0.1:5173/`. The UI defaults to **Illustrative**. Switch the banner to **Live local** to read and write `.aos/`.

If `aos` is run while the engine is listening, it forwards commands to `http://127.0.0.1:7740` so CLI and dashboard share the in-memory store. Set `AOS_LOCAL_ONLY=1` to force file-only access.

CLI (same store):

```bash
node bin/aos.mjs status
node bin/aos.mjs goal create "Determine whether delayed feedback destabilises coupling. Success is a bounded claim. Scope excludes clinical work."
node bin/aos.mjs runs
node bin/aos.mjs tree <runId>
node bin/aos.mjs advance <runId>
node bin/aos.mjs decision <runId>
node bin/aos.mjs improvements <runId>
node bin/aos.mjs approve <proposalId>
```

Data directory: `AOS_HOME` or `./.aos`. Bind address: `127.0.0.1:7740` (`AOS_PORT` to change). Vite proxies `/api` and `/health` to that service.

## Live Codex execution

Worker tasks can run as real Codex CLI sessions on the ChatGPT account the CLI is logged in with. It is off unless the engine starts with `AOS_EXECUTION=codex`:

```bash
node bin/aos.mjs live preflight                       # version, login, model catalog; no model call
AOS_EXECUTION=codex npm run engine                    # dashboard and CLI now dispatch live workers
node scripts/luna-bench.mjs --smoke                   # three live tasks, evidence under evidence/luna-max-e2e/
node scripts/luna-bench.mjs --levels 4,2,1            # the full scheduler proving benchmark
```

What the engine enforces:

- **One model and effort.** Only `gpt-5.6-luna` at `max` is accepted (`engine/codex.js`). Anything else is refused at startup. Each worker's own Codex session record is read after it runs; if the recorded model, effort, provider or sandbox differs, the run stops and nothing is retried.
- **ChatGPT login only.** Before dispatch the engine requires `codex login status` to report a ChatGPT login. API-key variables are removed from the worker environment. AOS never reads `~/.codex/auth.json`.
- **No fallback.** An unknown worker, or any non-Codex worker in live mode, fails the task. Features that could reach another model or act outside the sandbox (sub-agents, image generation, guardian review, apps, plugins, browser and computer use, memories) are disabled per worker.
- **Isolation.** Workers run with `--sandbox read-only` in their claimed workspace. Only the engine writes artifacts, from the worker's final JSON message, and each message must echo that task's nonce.
- **Scheduling.** At most 4 live workers run at once. A finished task frees its slot immediately, and tasks dispatch in plan order once their dependencies allow. Timeouts and cancellation kill the worker's whole process group.
- **Evidence.** Each attempt writes `attempt-N/{prompt.md,stdout.jsonl,stderr.txt,last-message.json,runtime.json}` with secrets redacted. `runtime.json` holds the exact argv, requested and recorded model and effort, plan type, thread id, timings and exit status. `node bin/aos.mjs events <runId>` and `inspect <taskId>` show the same record.

One limit remains: workers can still read any file the user can read, and Codex still loads the user's global `~/.codex/AGENTS.md`.

## Product decisions (reversible)

1. **Illustrative remains the dashboard default.** Live mode is explicit so the Electric Archive preview is not replaced by an empty store.
2. **Default concurrency is 2.** `maxConcurrency` null or `<= 0` means no engine-imposed cap for local workers. Live Codex runs are capped at 4.
3. **Acceptance tests use the deterministic local worker and a stub `codex` binary.** Live Codex execution is opt-in and never used by `npm test`. Claude Code and Grok remain typed boundaries that do not execute.
4. **Improvement proposals are proposal-only.** Approval records consent. Allowlisted policy keys (`maxConcurrency`, `maxRetries`, `retentionDays`) may then apply. Engine source is never self-modified.
5. **Auth types:** API key (env name only, value never stored or printed), CLI account session (Codex/Claude), local/none. Generic HTTP OAuth is labelled unsupported.
6. **HTTP is loopback-only.**

## What is not claimed

Claude Code and Grok execution was not reproduced. Live Codex results are only as good as the evidence under `evidence/luna-max-e2e/`. Secret values are not written to `.aos/state.json` or logs. Black Atlas mockups and specimen assets are retained under `design/mockups/black-atlas-v1/` and `public/assets/`.
