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

## Experimental local worker-pool protocol

The loopback HTTP service exposes a fenced worker-pool protocol for local experiments. A worker claims work with `POST /api/v1/worker-pool/claims` and supplies `worker`, `ownerId`, `requestId`, and an optional `runId`. A new claim returns `201` with one redacted claim; when no work is available, the endpoint returns `200` with exactly `{ "claim": null }`. It renews the fence with `POST /api/v1/worker-pool/claims/:claimId/heartbeat`, supplying `ownerId`, `attempt`, and optional process IDs. It settles the fence with `POST /api/v1/worker-pool/claims/:claimId/complete`, supplying `ownerId`, `attempt`, and `result`. Claim, heartbeat, and completion requests use the existing loopback host/origin checks, body cap, bearer token, and error envelope; responses contain no credentials, provider references, thread IDs, or harness references.

This protocol is local-only and experimental. It assumes the engine and pool clients share the same AOS store on the same host, so the bearer token authenticates the local control plane rather than creating a distributed worker trust domain. It is not a public bind or a cross-host scheduling protocol; deployment across hosts needs a separately designed transport and trust boundary.

The bundled one-slot runner executes ordinary, non-delegating provider tasks through the existing adapter code:

```bash
AOS_EXECUTION=mixed AOS_CODEX_ENABLED=1 AOS_CODEX_MODEL=gpt-5.6-luna AOS_CODEX_EFFORT=max \
  node bin/aos.mjs pool run --worker codex --once
```

Without `--once`, the command drains currently ready Codex work and exits when the pool is idle. Start more runner processes for more local slots; engine, project, run, and provider limits remain authoritative. The runner refuses every other worker, delegation, mounted capabilities, MCP execution, write access, profile drift, non-loopback targets, and unverified successful receipts. Codex processes are fenced by PID/PGID heartbeats, and the engine independently re-reads the Codex-owned session record before accepting success. Claude and Ollama remain in-process until they have an equally independent receipt source.

## Live provider execution

Worker tasks can run as real Codex CLI sessions on the ChatGPT account the CLI is logged in with. It is off unless the engine starts with `AOS_EXECUTION=codex`:

```bash
node bin/aos.mjs live preflight                       # version, login, model catalog; no model call
AOS_EXECUTION=codex npm run engine                    # dashboard and CLI now dispatch live workers
node scripts/luna-bench.mjs --smoke                   # three live tasks, evidence under evidence/luna-max-e2e/
node scripts/luna-bench.mjs --levels 4,2,1            # the full scheduler proving benchmark
```

What the engine enforces:

- **Role-bound models at one effort.** Manager roles (`lead`, `coordinator`, `planner`, `branch-manager`, `manager`, and `supervisor`) use `gpt-5.6-terra` at `max`; worker roles use `gpt-5.6-luna` at `max` (`engine/role-runtime.js`). The engine rejects a conflicting task assignment before dispatch and reads each worker's own Codex session record after execution. A recorded model, effort, provider, or sandbox mismatch stops the run without retrying the substituted attempt.
- **ChatGPT login only.** Before dispatch the engine requires `codex login status` to report a ChatGPT login. API-key variables are removed from the worker environment. AOS never reads `~/.codex/auth.json`.
- **No fallback.** An unknown worker, or any non-Codex worker in live mode, fails the task. Features that could reach another model or act outside the sandbox (sub-agents, image generation, guardian review, apps, plugins, browser and computer use, memories) are disabled per worker.
- **Isolation.** Workers run with `--sandbox read-only` in their claimed workspace. Only the engine writes artifacts, from the worker's final JSON message, and each message must echo that task's nonce.
- **Scheduling.** A run may contain at most seven logical manager-role tasks. Worker fan-out is not capped by the role policy, but at most four live Codex processes run at once and provider, project, run, and budget ceilings remain authoritative. A finished task frees its slot immediately, and tasks dispatch in plan order once their dependencies allow. Timeouts and cancellation kill the worker's whole process group.
- **Evidence.** Each attempt writes `attempt-N/{prompt.md,stdout.jsonl,stderr.txt,last-message.json,runtime.json}` with secrets redacted. `runtime.json` holds the exact argv, requested and recorded model and effort, plan type, thread id, timings and exit status. `node bin/aos.mjs events <runId>` and `inspect <taskId>` show the same record.

Claude Code can run through the existing `claude.ai` account session. AOS passes the output schema inline, disables customizations and browser integration, exposes only read-oriented tools, verifies the requested model family from `modelUsage`, and records provider-reported token and USD usage. It stores the provider session reference behind an AOS-owned session ID and omits that reference from public state and events.

```bash
node bin/aos.mjs live preflight claude               # account and CLI check; no model call
AOS_EXECUTION=claude npm run engine
AOS_EXECUTION=mixed AOS_LOCAL_ENABLED=1 AOS_CODEX_ENABLED=1 AOS_CLAUDE_ENABLED=1 npm run engine
```

Mixed mode preserves the worker named in each task. A failed provider preflight fails only that provider's assigned tasks before workspace claim; other configured providers continue. Provider, project, and run concurrency limits are checked before every reservation. A temporary slot race defers the task automatically rather than asking the operator to approve more capacity.

One limit remains: provider workers can read any file allowed by their CLI sandbox and the paths supplied by the operator.

## Local stdio MCP tools

The capability registry can mount one operator-pinned local stdio MCP tool for deterministic local tasks. Registration canonicalizes and hashes the executable and absolute file arguments. The engine rechecks those pins before its probe and every launch, requires the fixed staged-file input schema, and bounds protocol traffic, output, time, and receipts. The task must use the local worker, one relative read path, the exact capability version, a scoped `filesystem_read` grant, and the explicit `host_process` sandbox label.

This is a host-process integration, not filesystem or network isolation. A registered program can still exercise the operating-system authority of the current user. Remote transports, task-supplied commands or arguments, writes, external actions, and worker-pool execution are refused.

## Product decisions (reversible)

1. **Illustrative remains the dashboard default.** Live mode is explicit so the Electric Archive preview is not replaced by an empty store.
2. **Default concurrency is 2.** `maxConcurrency` null or `<= 0` means no engine-imposed cap for local workers. Live Codex runs are capped at 4.
3. **Acceptance tests use deterministic local workers, fake Codex and Claude binaries, and an injected Ollama transport.** Live account sessions and local-model calls are opt-in and never used by `npm test`. Grok and generic HTTP remain typed boundaries that do not execute.
4. **Improvement proposals are proposal-only.** Approval records consent. Allowlisted policy keys (`maxConcurrency`, `maxRetries`, `retentionDays`) may then apply. Engine source is never self-modified.
5. **Auth types:** API key (env name only, value never stored or printed), CLI account session (Codex/Claude), local/none. Generic HTTP OAuth is labelled unsupported.
6. **HTTP is loopback-only.**

## What is not claimed

The Claude adapter has focused fake-binary coverage; a real Claude worker result is not part of the automated suite. Live Codex results are only as good as the evidence under `evidence/luna-max-e2e/`. Ollama is mounted for exact-model, loopback-only, non-delegating bulk work, but no live Ollama daemon was called by the automated suite. Grok and generic HTTP remain unimplemented. Secret values are not written to public state or logs. Black Atlas mockups and specimen assets are retained under `design/mockups/black-atlas-v1/` and `public/assets/`.
