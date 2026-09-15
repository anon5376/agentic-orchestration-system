# Presets, templates, swarms, memory, settings: implementation plan

Version 0.1 · 2026-09-14 · Owner and implementer: Claude Fable 5.1 (`fable-aos`) · Founder directive of 2026-09-14 11:13 UTC relayed as bus message `msg_hn3b8wdw5g` · Integrator after handoff: Codex (`codex-root-aos`)

Grounded in the current repository: Node 24, no dependencies, `engine/` kernel with a JSON store and append-only event log, 40 passing tests after S0.3. Everything below is additive to that kernel. The architecture dossier (`AOS-ARCHITECTURE-DOSSIER.md`, D2 to D10) is the design authority; this plan is its delivery order for the founder's scope.

## Ownership

| Owner | Paths | Until |
|---|---|---|
| Fable | `engine/**`, `bin/aos.mjs`, `tests/**`, `docs/architecture/**`, new `engine/presets/**`, `engine/memory/**` | handoff (M7) |
| Codex | nothing in `engine/` or `tests/` during this plan; `src/**` integration after handoff; `docs/ENGINE.md` after handoff | |
| Founder | approvals for destructive memory operations and for any new dependency (none planned) | |

Board tasks S0.4 and S0.5 move to Fable as M0. Board tasks S0.6 to S0.12 remain queued after M7 unless a milestone needs one earlier (then it is folded in and reported).

## Milestones

Each milestone ends green: full `npm test` and `npm run build`, exact counts reported on the bus with changed paths and new test names. No milestone is "done" on a design document.

| Id | Content | New or changed files | Tests added | Done when |
|---|---|---|---|---|
| M0 | S0.4 attempt leases and lease-based orphan recovery with process-group reap; S0.5 reference re-resolution so `transact` can reload during a drive, and dispatch-time saves under the lock | `engine/engine.js`, `engine/codex.js`, `tests/recovery.test.js` | lease respected across processes; expired lease requeued with attempt accounting; live pgid reaped on restart; CLI write during a live drive not lost | suite green; two engines on one store cannot double-dispatch |
| M1 | Store schema v2 and migration: new collections `presets`, `templates`, `blueprints`, `settings`, `memoryIndex`; migration from the present `state.json` preserving every existing record; shared validation helpers (hand-written, no dependency); stable error envelope `{error, code, details}` for the new surfaces | `engine/store.js`, new `engine/schema.js`, new `engine/migrate.js`, `tests/migrate.test.js` | migration of a copy of today's real `.aos/state.json`; restart persistence; unknown fields preserved | old store loads, all runs and evidence intact, version bumped |
| M2 | Role preset registry with full system-prompt bodies: immutable built-ins for 17 roles, derived user versions, fork, edit, validate, archive, restore-default, import, export, version history; typed variables with safe interpolation; inheritance and composition with deterministic section precedence and cycle rejection; effective-prompt preview; body-size limit | new `engine/presets/registry.js`, new `engine/presets/builtin/*.md` (one file per role, structured sections), `engine/engine.js` (registry wiring), `tests/presets.test.js` | CRUD and versioning; interpolation rejects unresolved variables; inheritance precedence and cycles; import/export round-trip; limits; adversarial bodies treated as data | every built-in role has an operable prompt; preview renders an effective prompt |
| M3 | Subagent templates: schema (preset and version, harness and model policy, effort, capability allowlist, filesystem and network policy, memory policy, context inputs, output contract, max children, concurrency, retry and timeout, budgets, escalation target, termination criteria); CRUD, versions, clone, archive, import, export, provenance; save a live agent's effective configuration as a template; apply a template when a task is instantiated | new `engine/templates.js`, `engine/engine.js` (task instantiation reads a template), `tests/templates.test.js` | validation; version history; save-from-live-agent; apply-on-instantiate; import/export | a run's task can carry `templateId` and its effective config resolves from it |
| M4 | Swarm blueprints: lead template, permitted child templates, recursion depth with explicit unlimited, branch and global concurrency, queue priority, model routing and fallback, capability bindings, context partition, message policy, shared-artifact rules, memory scopes, verification and human gates, failure and recovery policy, stop conditions, ceilings; validation of cycles and impossible policies; dry-run expansion and estimate; effective-configuration view; `startRun` accepts a blueprint | new `engine/blueprints.js`, `engine/engine.js`, `tests/blueprints.test.js` | no fixed size cap when unlimited is selected; cycle and impossibility rejection; dry-run estimate; effective view | a run started from a blueprint records it and enforces its ceilings |
| M5 | Memory subsystem: file-backed stores per scope (global, project, swarm, run, role, agent) under `~/.aos/memory` and `.aos/memory`; record types (fact or decision, procedure, preference, failure lesson, evidence reference, summary, unresolved question); record fields as specified; enable flags per scope where disabled means no retrieval and no writes; lifecycle hooks (retrieve before task, bounded record during, reflect at completion, commit by policy); deterministic lexical, tag and recency retrieval behind a provider interface; dedup, supersession, tombstones, pin, forget, clear-scope behind the existing approval gate, export, import; retention and size limits; events with redaction; failed writes never fail the task | new `engine/memory/{store,retrieval,policy,hooks}.js`, `engine/engine.js` (hooks in `#executeTask` and settle), `engine/codex.js` (`memory_writes` in the output schema), `tests/memory.test.js` | off means off; namespace isolation; ranking and token limit; retention, tombstones, supersession; hooks; event redaction; import/export; restart persistence | a run with memory on retrieves into a later run's brief; with memory off nothing is read or written |
| M6 | Settings and system access: setting groups (agents and roles, templates, swarms, models and harnesses, capabilities, memory, budgets and concurrency, approvals and safety, storage and retention, diagnostics); effective values with provenance (built-in, project, swarm, role, agent, run); list, get, create, update, archive, import, export, validate, preview through both HTTP and CLI with shared validation; capability manifest endpoint describing every setting for the dashboard; explicit versioned patches for active runs; stable machine-readable errors | new `engine/settings.js`, `engine/http.js`, `engine/cli.js`, `bin/aos.mjs`, `tests/settings.test.js`, `tests/e2e.test.js` | CLI and API parity; override precedence; manifest completeness; invalid inputs; run patches are versioned | every new control is reachable from both CLI and loopback HTTP |
| M7 | Handoff for Codex: schemas, endpoint and CLI inventory, preset inventory, memory semantics, migration notes, test and build output, known limitations, dashboard integration contract | new `docs/architecture/PRESETS-MEMORY-HANDOFF.md` | none | Codex can integrate without reading engine source |

## Sequencing and rules

- M0 first because M3 to M5 add durable records and lifecycle hooks in the same engine paths; recovery must be correct before more state lands.
- No new dependency. Validation is hand-written. Retrieval is lexical and deterministic; an embedding provider is an interface for later.
- Prompts, imported templates, memory content and agent messages are untrusted data; they are validated, size-limited, and never executed or interpolated into shell commands.
- Nothing persists raw hidden reasoning. Memory records store observations, summaries and provenance.
- No agent approves its own permission, promotion, prompt mutation or destructive operation. Clear-scope and global promotion use the proposal gate.
- Auth, sandbox, allowlists, frozen evidence and the illustrative-versus-live distinction are unchanged.

## Resumable state

Each milestone's bus report names the milestone, the changed paths, the new tests and the counts. If the session ends mid-milestone, the last report plus `git diff --stat` against the staged baseline is the resume point.

## Progress log

| When (UTC) | Milestone | Result |
|---|---|---|
| 2026-09-14 11:5x | M0 | leases, lease-based orphan rule, pgid reap, heartbeat, reload-safe transactions; 46/46; build ok; staged |
| 2026-09-14 11:33 | M1 | schema v2, migration with `.v1.bak`, validation module, error envelope, 404s; 52/52; build ok; staged. Caution: the demonstrator daemon must not be restarted against the frozen evidence directory with the new code |
| 2026-09-14 11:51 | M2 | preset registry (versions, fork, archive, restore, import, export, inheritance, typed variables, preview) and 17 built-in full presets plus the abstract base; 61/61; build ok; staged |
| 2026-09-14 12:00 | M3 | template registry with 10 built-ins, full config field set, versioning/fork/archive/restore/import/export, save-from-agent, applied at instantiation with overrides recorded, preset rendered as the worker system prompt; 69/69; build ok; staged |
| 2026-09-14 12:12 | M4 | blueprint registry with 3 built-ins, explicit unlimited switches, impossible-policy validation, dry-run estimate, effective view, run start applies lead and per-kind templates and records ceilings/policies; derived role variables; CLI/HTTP accept a blueprint; 76/76; build ok; staged |
| 2026-09-14 12:24 | M4 correction | unlimited is canonical null in templates and blueprints, no finite fan-out or depth cap, indeterminate estimates for unbounded topologies |
| 2026-09-14 12:24 | M5 | memory subsystem: policy (off by default, narrowing layers), file stores per scope namespace, deterministic retrieval provider, lifecycle hooks, operator operations, promotion with approval gate, retention, export/import; 85/85; build ok; staged |
| 2026-09-14 12:34 | M6 | settings registry (18 definitions, 10 groups, provenance, preview, versioned run patches), shared action layer, 67 HTTP routes, CLI resource commands, manifest with schemas/routes/gates/enumerations; 89/89; build ok; staged |
| 2026-09-14 12:39 | M7 | handoff document with generated inventories, schemas, memory semantics, migration notes, startup and boundary notes, captured end-to-end operator flow, dashboard contract; approval of run-less proposals fixed in CLI and HTTP; 89/89; build ok; ownership released to Codex |
