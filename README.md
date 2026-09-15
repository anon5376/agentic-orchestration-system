# AOS

AOS coordinates local-first research through hierarchies of specialized agents. Define workers, assemble a swarm, give it a goal, and inspect the work through the dashboard or CLI.

The dashboard and CLI use the same on-disk state in `.aos/`.

## What works

- Goal intake with clarification questions and a reviewable task plan
- Versioned worker instructions, worker configurations, and swarm configurations
- Hierarchical delegation with dependency-aware scheduling and bounded concurrency
- Deterministic local execution for development and testing
- Live Codex execution through an existing ChatGPT login
- Per-worker budgets, sandbox access, capabilities, memory, and delegation limits
- Optional scoped memory across agents, roles, runs, swarms, projects, and the global system
- Run telemetry, token accounting, artifacts, evidence, approval gates, and retrospectives
- Proposal-only self-improvement with explicit approval and rollback boundaries

Mounted worker adapters currently cover deterministic local execution and Codex. Claude, generic API-key providers, Ollama, and arbitrary OAuth providers remain configuration-only. An unavailable adapter stops dispatch instead of silently substituting another worker.

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

## Live Codex workers

AOS can use the Codex CLI session already authenticated with ChatGPT. The OAuth credential stays inside the Codex CLI session.

```bash
codex login status
node bin/aos.mjs live preflight
AOS_EXECUTION=codex npm run dev:all
```

The current live policy accepts only `gpt-5.6-luna` at reasoning effort `max`, with at most four concurrent workers. Runtime evidence is checked after every worker attempt. Model substitution, missing session evidence, or another worker type stops the run.

To return to deterministic local execution:

```bash
npm run dev:all
```

## CLI

The CLI operates on the same state as the dashboard.

```bash
node bin/aos.mjs help
node bin/aos.mjs blueprint list
node bin/aos.mjs goal create "State the objective, success criteria, and scope."
node bin/aos.mjs run start <goalId> --blueprint <blueprintId>
node bin/aos.mjs tree <runId>
node bin/aos.mjs advance <runId> --until-idle
```

Set `AOS_LOCAL_ONLY=1` to force file-only CLI access. Set `AOS_HOME` to place the state directory somewhere other than `./.aos`.

## Development

```bash
npm test
npm run build
```

Architecture and engine details live in [docs/ENGINE.md](docs/ENGINE.md) and [docs/architecture/AOS-ARCHITECTURE-DOSSIER.md](docs/architecture/AOS-ARCHITECTURE-DOSSIER.md).

The HTTP server binds to loopback by default. Keep it there: this build is a local research tool, not a hardened multi-user service.
