# AOS

AOS coordinates local-first research through hierarchies of specialized agents. Define workers, assemble a swarm, give it a goal, and inspect the work through the dashboard or CLI.

The dashboard and CLI use the same on-disk state in `.aos/`.

## What works

- Goal intake with clarification questions and a reviewable task plan
- Versioned worker instructions, worker configurations, and swarm configurations
- Agent-originated hierarchical delegation with immutable plan versions, exact child-template pins, and operator gates
- Deterministic local execution for development and testing
- Live Codex and Claude Code execution through existing account logins
- Disabled-by-default fixed-argv external-harness protocol for operator-owned CLI wrappers
- Per-worker budgets, sandbox access, capabilities, memory, and delegation limits
- One engine-owned, read-only MCP capability for bounded staged-text reads
- Optional scoped memory across agents, roles, runs, swarms, projects, and the global system
- Run telemetry, token accounting, artifacts, evidence, approval gates, and retrospectives
- Proposal-only self-improvement with explicit approval and rollback boundaries

Mounted worker adapters cover deterministic local execution, Codex, Claude Code, an explicit loopback-only Ollama worker, and a disabled-by-default external-harness protocol wrapper. The wrapper is not a native OpenCode/OpenClaw integration and does not implement provider OAuth. Generic API-key providers and arbitrary OAuth providers remain configuration-only. An unavailable adapter stops its assigned task instead of silently substituting another worker.

## Start locally

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run dev:all
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), then switch the top banner from **Simulated** to **Live / local**.

You can also run the services separately:

```bash
npm run engine
npm run dev
```

The engine listens on `127.0.0.1:7740`. Vite serves the dashboard on `127.0.0.1:5173` and proxies engine requests.

## Build and launch a swarm

1. Open **System Studio → Build swarm**.
2. Under **Instructions**, write or copy the operating instructions for each role.
3. Under **Workers**, combine instructions with a harness, model, tools, workspace access, memory policy, autonomy, and hard limits.
4. Under **Swarms**, choose the lead worker and available child workers. Set the hierarchy depth, parallelism, approval gates, memory defaults, and run ceilings.
5. Save the swarm and select it. Press **Next: create research goal**.
6. In **Goal Intake**, confirm the swarm, enter the objective and any local context paths, then press **Prepare research plan**.
7. Answer any required clarification questions.
8. Press **Launch _swarm name_**. AOS starts the run with the selected swarm and opens the live Swarm view.

The run records the resolved swarm version. Later edits create a new version and do not rewrite an existing run.

### Configuration model

- **Instructions** are the worker's system prompt and behavioral contract.
- **Worker** is a reusable execution profile: instructions, harness, model, tools, access, memory, delegation, retries, and budgets.
- **Swarm** is the coordinated team: lead worker, child pool, hierarchy, routing, parallelism, gates, and run ceilings.
- **Goal** is the research objective and its source context.
- **Run** is one execution of a goal by a resolved swarm version.

## Live account-session workers

AOS can use the Codex CLI session already authenticated with ChatGPT. The OAuth credential stays inside the Codex CLI session.

```bash
codex login status
node bin/aos.mjs live preflight
AOS_EXECUTION=codex npm run dev:all
```

The current live role policy binds lead, coordinator, planner, manager, supervisor, and branch-manager roles to `gpt-5.6-terra` at reasoning effort `max`. All other worker roles bind to `gpt-5.6-luna` at `max`. A run may contain at most seven logical manager-role tasks; worker fan-out has no role-policy ceiling, while provider, project, run, budget, and the four-process Codex cap still bound physical execution. Runtime evidence is checked after every worker attempt. Model substitution, missing session evidence, or another worker type stops the run.

AOS can also use the Claude Code account session without reading or copying its credential:

```bash
claude auth status
node bin/aos.mjs live preflight claude
AOS_EXECUTION=claude npm run dev:all
```

Mixed mode keeps assignments explicit and applies a separate concurrency limit to each provider:

```bash
AOS_EXECUTION=mixed \
  AOS_LOCAL_ENABLED=1 \
  AOS_CODEX_ENABLED=1 \
  AOS_CLAUDE_ENABLED=1 \
  npm run dev:all
```

To execute ready provider tasks from separate same-host processes, start one or more fenced pool runners with the same `AOS_HOME` and provider environment as the engine:

```bash
node bin/aos.mjs pool run --worker codex
```

Each runner handles one Codex task at a time and exits when its queue is idle. It uses the engine's loopback bearer-authenticated claim protocol; it is not a public or cross-host worker service. Claude and Ollama still run inside the engine process because their pool completion path does not yet have independent receipt verification.

Claude Code runs with restricted mode, safe mode, no custom MCP configuration, no browser integration, no permission prompts, and only read-oriented tools. AOS accepts the result only when Claude reports the requested model family and complete usage data.

Ollama can handle cheap, non-delegating bulk roles through its local HTTP service. It is available only in mixed mode, uses one exact configured model, and stays unavailable until preflight confirms that model is installed:

```bash
AOS_EXECUTION=mixed \
  AOS_LOCAL_ENABLED=1 \
  AOS_OLLAMA_ENABLED=1 \
  AOS_OLLAMA_MODEL=<exact-installed-model> \
  npm run dev:all

node bin/aos.mjs live preflight ollama
```

The Ollama endpoint must be a literal `http://127.0.0.1` or `http://[::1]` origin. AOS refuses credentials, redirects, remote hosts, model substitution, delegation, and tool execution on this adapter. Ollama usage is locally observed, not an externally verified provider receipt.

### External CLI harness wrapper

`command` is retained only as a compatibility ID. It is no longer a shell-command worker and is disabled in local mode. To enable it, provide an operator-owned executable and fixed argument array through `AOS_ADAPTERS`; the executable reads one JSON request from stdin and emits one JSON response using `aos-external-harness-v1`.

```bash
AOS_EXECUTION=mixed \
  AOS_ADAPTERS='{"local":{"enabled":true},"command":{"enabled":true,"bin":"aos-opencode-wrapper","argv":[],"provider":"opencode","model":"provider/model","authType":"external_cli_session","sessionMode":"ephemeral","timeoutMs":900000}}' \
  npm run dev:all

node bin/aos.mjs live preflight command
```

The wrapper receives a sanitized environment, never receives an AOS/provider token, runs with `shell=false`, has bounded redacted output, and is stopped through its own process group on timeout or cancellation. AOS verifies only protocol/config/nonce binding; provider identity, usage, and session evidence remain self-reported by the wrapper. It is therefore not a claim of native OpenCode, OpenClaw, dsh, or OAuth support.

This is a `host_process` disclosure tier, not filesystem or network isolation. A command task must explicitly use that tier and cannot contain a task command, a resume session, a fallback, delegation, or capability mounts. Existing task-provided command plans fail closed and must be migrated to a configured wrapper.

## MCP execution boundary

AOS ships one executable MCP capability: `aos.staged-text-reader@1`. It reads exactly the first declared relative project path through an engine-staged file and records fingerprints instead of raw content in state and events. The task must be read-only, offline, explicitly permissioned, tested, enabled, and bound to that exact version.

Arbitrary task-provided local commands, package-provided MCP servers, remote MCP transports, writable tools, and effectful MCP actions are not executable. The only generic CLI path is the explicit fixed-argv external-harness wrapper above.

One deterministic writable exception is shipped. The local task-workspace writer changes one fixed engine-owned file with engine-derived bytes. It accepts no task path or content. An operator must approve the exact upcoming attempt, capability, input, workspace isolation, and rollback plan before a fenced claim can mutate the file. The engine stores prior bytes only in a bounded private journal, publishes fingerprinted receipts, recovers a verified post-write interruption, and can idempotently restore or remove the prior file. The generic task approval endpoint refuses this effect; use the exact workspace-write approval and rollback actions in the loopback API or CLI. This does not enable generic file writing or external effects.

To return to deterministic local execution:

```bash
npm run dev:all
```

## Deterministic policy evaluation

AOS can evaluate a pending `maxConcurrency` proposal by replaying a frozen scheduler suite through the baseline and candidate settings:

```bash
node bin/aos.mjs improvement run-deterministic <proposalId> \
  --json '{"requestId":"scheduler-eval-1"}'
```

The receipt binds the proposal, policy baseline, fixture set, outputs, and promotion gate with content fingerprints. This evaluates AOS scheduler behavior only. It does not compare models, providers, Codex, OpenCode, or OpenClaw.

## CLI

The CLI operates on the same state as the dashboard.

```bash
node bin/aos.mjs help
node bin/aos.mjs blueprint list
node bin/aos.mjs goal create "State the objective, success criteria, and scope."
node bin/aos.mjs run start <goalId> --blueprint <blueprintId>
node bin/aos.mjs tree <runId>
node bin/aos.mjs advance <runId> --until-idle
node bin/aos.mjs delegation list <runId>
node bin/aos.mjs delegation approve <receiptId> --request-id <uniqueId>
node bin/aos.mjs delegation reject <receiptId> --request-id <uniqueId>
```

Workers with explicit delegation authority may propose child tasks only through exact, version-pinned templates. AOS derives the provider, model, tools, sandbox, parent edge, and budget boundary; the worker cannot set them. Finite proposals can apply automatically unless the swarm requires an expansion gate. Unlimited branches remain possible, but every generation stays operator-paced.

Set `AOS_LOCAL_ONLY=1` to force file-only CLI access. Set `AOS_HOME` to place the state directory somewhere other than `./.aos`.

## Development

```bash
npm test
npm run build
```

Architecture and engine details live in [docs/ENGINE.md](docs/ENGINE.md) and [docs/architecture/AOS-ARCHITECTURE-DOSSIER.md](docs/architecture/AOS-ARCHITECTURE-DOSSIER.md).

The HTTP server binds to loopback by default. Keep it there: this build is a local research tool, not a hardened multi-user service.
