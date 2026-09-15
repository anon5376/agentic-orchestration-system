# Presets, templates, swarms, memory, settings: handoff to Codex

Version 1.0 · 2026-09-14 · From Claude Fable 5.1 (`fable-aos`) to Codex (`codex-root-aos`) · Founder directive of 2026-09-14 11:13 UTC · Plan: [PRESETS-MEMORY-PLAN.md](PRESETS-MEMORY-PLAN.md) · Architecture: [AOS-ARCHITECTURE-DOSSIER.md](AOS-ARCHITECTURE-DOSSIER.md)

Everything in this document is shipped code in `engine/` with tests, staged in git and not committed. Last full run before writing it:

```
ℹ tests 89
ℹ pass 89
ℹ fail 0
✓ 39 modules transformed.
✓ built in 512ms
```

## 1. What shipped

| Area | Where | Status |
|---|---|---|
| Recovery kernel (leases, orphan rule, process-group reap, reload-safe transactions) | `engine/engine.js`, `engine/store.js` | done (M0) |
| Store schema v2, migration from v1 with `state.json.v1.bak`, hand-written validation, error envelope, 404s | `engine/migrate.js`, `engine/schema.js`, `engine/store.js`, `engine/http.js` | done (M1) |
| Role preset registry, 17 built-in full system-prompt presets plus the abstract base | `engine/presets/registry.js`, `engine/presets/builtin/*.md` | done (M2) |
| Subagent templates with the whole effective configuration, applied at instantiation, save-from-agent | `engine/templates.js` | done (M3) |
| Swarm blueprints with explicit unlimited, impossible-policy validation, dry-run estimate, run application | `engine/blueprints.js` | done (M4) |
| Optional continuous memory: policy, scoped file stores, retrieval, lifecycle hooks, promotion, retention, export/import | `engine/memory/` | done (M5) |
| Settings registry, manifest, shared action layer, 67 HTTP routes, CLI resource commands, versioned run patches | `engine/settings.js`, `engine/api.js`, `engine/http.js`, `engine/cli.js` | done (M6) |

Counts: 18 presets (17 concrete roles), 10 built-in templates, 3 built-in blueprints, 18 setting definitions in 10 groups, 67 resource routes. Engine source is about 7,600 lines across `engine/`.

## 2. How the pieces fit

A run starts from a goal and, optionally, a blueprint. The blueprint chooses the lead template for the root task and a template per task kind; a plan task may also name a template or a preset directly. At instantiation the engine applies the template to the task (harness, model, effort, preset, budget, sandbox, retries, timeout, capabilities, delegation, memory policy, escalation, termination) and records every value the plan overrode in `task.config.overrides`. At dispatch the engine renders the task's preset with the engine-supplied variables (goal, brief, dependency results, budget, sandbox, retrieved memory, and so on) and hands the text to the worker as `ctx.systemPrompt`; the Codex adapter puts it before the assignment block. Workers may return `memory_writes`; the memory service applies them by scope policy. When the run ends, a summary is written to the run's memory scope if memory is on. Settings resolve through layers with provenance, and an active run is changed only through versioned patches.

## 3. Schemas

All input validation uses `engine/schema.js` descriptors; the manifest publishes machine-readable descriptions of every schema under `inputSchemas`. Errors are `{ error, code, details }` with `details.errors[]` of `{ path, code, message }` for validation.

### 3.1 Preset (`engine/presets/registry.js`)

Input: `{ id, name, role, extends?: {id, version?}, abstract?, variables?: { name: { type: string|integer|number|boolean|enum|list, required?, default?, description?, values?, maxLength? } }, sections?: { 'Section name': text }, sectionModes?: { 'Section name': replace|append }, body?, note? }`. Stored version record adds `version, builtin, source, createdAt, createdBy, parentVersion, forkedFrom, archived, provenance`. Required sections of every concrete preset: Mission, Responsibilities, Inputs, Outputs, Operating loop, Delegation authority, Tool and capability policy, Evidence standard, Uncertainty rules, Communication protocol, Escalation rules, Stop conditions, Prohibited behavior, Memory policy, Budget behavior, Completion contract. Limits: body 60,000 chars, section 20,000, 40 sections, 50 variables, inheritance depth 8. Composition: root-first, child replaces or appends, variables merge child-wins. Rendering: `{{name}}` placeholders, one pass, values never re-scanned, control characters stripped. Export format `aos-presets/1`.

### 3.2 Template (`engine/templates.js`)

`{ id, name, description?, config: { preset: {id, version?}, harness: { id: local|codex|claude|api|ollama|command, model?, effort?, fallback?[] }, capabilities?: {skills, mcp, plugins, tools}, filesystem?: { sandbox: read_only|workspace_write|network, readPaths, writePaths }, network?: {allowed, allowlist}, memory?: {read, write, scopes, retentionDays}, context?: {inputs, maxTokens}, output?: {contract, maxFindings, maxSummaryWords}, delegation?: { mayDelegate, maxChildren: int|null|'unlimited', maxDepth: int|null|'unlimited', childTemplates }, concurrency?, retry?: {maxRetries}, timeoutMs?, budget?: {tokens, usd, timeMs}, escalation?: {target}, termination?: {criteria, stopOnBudget}, variables? }, note? }`. Canonical unlimited is `null`; `delegation.unlimited` is derived. Defaults fill every omitted field (`DEFAULT_CONFIG`). Export format `aos-templates/1`. `saveFromAgent({ taskId, id })` captures a task's effective configuration with provenance.

### 3.3 Blueprint (`engine/blueprints.js`)

`{ id, name, description?, config: { lead: {templateId, templateVersion?}, childTemplates[], depth: { max: int|null|'unlimited', unlimited }, concurrency: { global: int|null|'unlimited', perBranch, unlimited }, priority, routing: {rules[], fallback[]}, capabilities: {bindings[]}, contextPartition, messaging, artifacts, memory: {scopes, readByDefault, writeByDefault}, gates: { verification[], human[] }, failure, stop, ceilings: { tasks, tokens, usd, timeMs, unlimited }, kindTemplates: { kind: templateId } } }`. A limit or an explicit `unlimited: true` is required for depth, concurrency and ceilings (`limit_required` otherwise). `estimate(id, {depth})` returns levels with `maxAgents`/`maxTokens` (null and `indeterminate: true` once any fan-out is unlimited), `totalAgents`, `unbounded`, `warnings`. Export format `aos-blueprints/1`.

### 3.4 Memory record (`engine/memory/index.js`)

`{ id (mem_…), schemaVersion, scope, namespace, type, title, content, hash, tags[], confidence, sensitivity: normal|sensitive, status: committed|proposed, owner: {role, agentId}, provenance: {projectId, runId, taskId, attempt, source, promotedFrom?, importedFrom?, correctedFrom?}, evidence[], createdAt, updatedAt, expiresAt, pinned, supersedes, supersededBy, tombstoned, tombstonedAt, tombstoneReason }`. Worker write shape (`memory_writes[]` in WorkerOutput): `{ scope, type, title, content, tags, confidence, sensitivity }`. Export format `aos-memory/1`.

### 3.5 Setting record and run patch (`engine/settings.js`)

Record: `{ id (set_…), key, scope, scopeId, value, version, updatedAt, updatedBy, history[{version, value, at, by}] }`. Effective: `{ key, value, provenance: {layer, source, scopeId}, layers[{layer, value, source}], runPatchable, readOnly }`. Run patch: `{ version, key, value, reason, at, by }` appended to `run.patches`; applied to `run.maxConcurrency`, `run.policies.gates.human`, `run.policies.memory`, `run.ceilings`.

### 3.6 WorkerOutput v2 (`engine/codex.js`, `CODEX_OUTPUT_SCHEMA`)

Required: `task_nonce, summary, findings[], risks[], confidence, decision|null, retrospective|null, memory_writes[]`. Sub-plans and questions from workers are the next stage (plan patches); the presets already describe them so the contract does not change again.

## 4. Endpoint inventory (generated from `RESOURCE_ROUTES`)

All under loopback `127.0.0.1:7740`. Bodies and query parameters merge into one params object; path params win. Gates: `confirm` means the dashboard must confirm; `approval` means the backend creates a proposal unless `confirm: true` is sent explicitly; `policy` means the promotion policy decides and may return a proposal.

| Method | Path | Resource.action | Status | Gate |
|---|---|---|---|---|
| GET | `/api/v1/settings/manifest` | settings.manifest | 200 |  |
| GET | `/api/v1/settings/diagnostics` | settings.diagnostics | 200 |  |
| GET | `/api/v1/settings/export` | settings.export | 200 |  |
| POST | `/api/v1/settings/import` | settings.import | 200 |  |
| POST | `/api/v1/settings/validate` | settings.validate | 200 |  |
| POST | `/api/v1/settings/preview` | settings.preview | 200 |  |
| GET | `/api/v1/settings` | settings.list | 200 |  |
| GET | `/api/v1/settings/:key/effective` | settings.effective | 200 |  |
| GET | `/api/v1/settings/:key` | settings.get | 200 |  |
| PUT | `/api/v1/settings/:key` | settings.set | 200 |  |
| DELETE | `/api/v1/settings/:key` | settings.unset | 200 | confirm |
| GET | `/api/v1/presets/export` | presets.export | 200 |  |
| POST | `/api/v1/presets/import` | presets.import | 200 |  |
| POST | `/api/v1/presets/validate` | presets.validate | 200 |  |
| GET | `/api/v1/presets` | presets.list | 200 |  |
| POST | `/api/v1/presets` | presets.create | 201 |  |
| GET | `/api/v1/presets/:id/history` | presets.history | 200 |  |
| GET | `/api/v1/presets/:id/effective` | presets.effective | 200 |  |
| POST | `/api/v1/presets/:id/preview` | presets.preview | 200 |  |
| POST | `/api/v1/presets/:id/versions` | presets.edit | 201 |  |
| POST | `/api/v1/presets/:id/fork` | presets.fork | 201 |  |
| POST | `/api/v1/presets/:id/archive` | presets.archive | 200 | confirm |
| POST | `/api/v1/presets/:id/restore` | presets.restore | 200 | confirm |
| GET | `/api/v1/presets/:id` | presets.get | 200 |  |
| GET | `/api/v1/templates/export` | templates.export | 200 |  |
| POST | `/api/v1/templates/import` | templates.import | 200 |  |
| POST | `/api/v1/templates/validate` | templates.validate | 200 |  |
| POST | `/api/v1/templates/from-task` | templates.fromTask | 200 |  |
| GET | `/api/v1/templates` | templates.list | 200 |  |
| POST | `/api/v1/templates` | templates.create | 201 |  |
| GET | `/api/v1/templates/:id/history` | templates.history | 200 |  |
| POST | `/api/v1/templates/:id/versions` | templates.edit | 201 |  |
| POST | `/api/v1/templates/:id/fork` | templates.fork | 201 |  |
| POST | `/api/v1/templates/:id/archive` | templates.archive | 200 | confirm |
| POST | `/api/v1/templates/:id/restore` | templates.restore | 200 | confirm |
| GET | `/api/v1/templates/:id` | templates.get | 200 |  |
| GET | `/api/v1/blueprints/export` | blueprints.export | 200 |  |
| POST | `/api/v1/blueprints/import` | blueprints.import | 200 |  |
| POST | `/api/v1/blueprints/validate` | blueprints.validate | 200 |  |
| GET | `/api/v1/blueprints` | blueprints.list | 200 |  |
| POST | `/api/v1/blueprints` | blueprints.create | 201 |  |
| GET | `/api/v1/blueprints/:id/history` | blueprints.history | 200 |  |
| GET | `/api/v1/blueprints/:id/effective` | blueprints.effective | 200 |  |
| GET | `/api/v1/blueprints/:id/estimate` | blueprints.estimate | 200 |  |
| POST | `/api/v1/blueprints/:id/versions` | blueprints.edit | 201 |  |
| POST | `/api/v1/blueprints/:id/fork` | blueprints.fork | 201 |  |
| POST | `/api/v1/blueprints/:id/archive` | blueprints.archive | 200 | confirm |
| POST | `/api/v1/blueprints/:id/restore` | blueprints.restore | 200 | confirm |
| GET | `/api/v1/blueprints/:id` | blueprints.get | 200 |  |
| GET | `/api/v1/memory/stats` | memory.stats | 200 |  |
| GET | `/api/v1/memory/policy` | memory.policy | 200 |  |
| PUT | `/api/v1/memory/policy` | memory.setPolicy | 200 |  |
| GET | `/api/v1/memory/search` | memory.search | 200 |  |
| GET | `/api/v1/memory/export` | memory.export | 200 |  |
| POST | `/api/v1/memory/import` | memory.import | 200 |  |
| POST | `/api/v1/memory/retention` | memory.retention | 200 | confirm |
| POST | `/api/v1/memory/clear` | memory.clear | 200 | approval |
| POST | `/api/v1/memory/items` | memory.add | 201 |  |
| GET | `/api/v1/memory/items/:id` | memory.show | 200 |  |
| POST | `/api/v1/memory/items/:id/correct` | memory.correct | 200 |  |
| POST | `/api/v1/memory/items/:id/commit` | memory.commit | 200 |  |
| POST | `/api/v1/memory/items/:id/pin` | memory.pin | 200 |  |
| POST | `/api/v1/memory/items/:id/unpin` | memory.unpin | 200 |  |
| POST | `/api/v1/memory/items/:id/forget` | memory.forget | 200 | confirm |
| POST | `/api/v1/memory/items/:id/promote` | memory.promote | 200 | policy |
| POST | `/api/v1/runs/:runId/patch` | runs.patch | 200 | confirm |
| GET | `/api/v1/runs/:runId/patches` | runs.patches | 200 |  |

Pre-existing routes (goals, runs, tasks, proposals, providers, events, cli, snapshot) are unchanged except that `POST /api/v1/runs` accepts `blueprintId` and `blueprintVersion`, unknown ids return 404 and every error uses the envelope.

## 5. CLI inventory

- `aos settings manifest | diagnostics | list [--scope S --scope-id ID] | get <key> --scope S [--scope-id ID]`
- `aos settings effective <key> [--project ID --blueprint ID --preset ID --agent ID --run ID]`
- `aos settings set <key> <value> --scope S [--scope-id ID] | unset <key> --scope S [--scope-id ID]`
- `aos settings validate <key> <value> | preview <key> <value> --scope S [--scope-id ID] | export [--scope S] | import --file F`
- `aos preset list [--role R] | show <id> [--version N] | history <id> | effective <id> | preview <id> [--var k=v ...]`
- `aos preset create --json J | --file F | edit <id> --json J | fork <id> <newId> | archive <id> [--version N] | restore <id>`
- `aos preset validate --json J | export [--builtin] | import --file F`
- `aos template list | show <id> | history <id> | create --json J | edit <id> --json J | fork <id> <newId> | archive <id> | restore <id>`
- `aos template validate --json J | from-task <taskId> <newId> [--name N] | export | import --file F`
- `aos blueprint list | show <id> | history <id> | effective <id> | estimate <id> [--depth N] | create --json J | edit <id> --json J`
- `aos blueprint fork <id> <newId> | archive <id> | restore <id> | validate --json J | export | import --file F`
- `aos memory stats | policy [--scope S --scope-id ID] | policy set --json J [--scope S --scope-id ID]`
- `aos memory search [--scope S --namespace NS --query Q --tags a,b --limit N] | show <id> | add <scope> <namespace> --json J`
- `aos memory correct <id> --json J | commit <id> | pin <id> | unpin <id> | forget <id> [--reason R] | promote <id> <toScope>`
- `aos memory clear <scope> <namespace> [--confirm] | retention | export <scope> <namespace> | import --file F [--scope S --namespace NS]`
- `aos run patch <runId> <key> <value> [--reason R] | run patches <runId>`

Values are parsed as JSON when they parse, otherwise as strings; `--json` or `--file` supply objects; a repeated `--var k=v` supplies preset variables; output is JSON except `preset preview`, which prints the rendered text. The in-process tokenizer (used by the dashboard CLI drawer) keeps a `{...}` or `[...]` argument together.

## 6. Preset inventory

Every concrete preset extends `aos-base` and carries all 16 sections with role-specific text (14 or 15 sections overridden or appended per role; only the WorkerOutput contract section is shared unchanged). Role variables marked required are derived by the engine when the task does not set them (see 7.2).

| Preset | Role | Effective chars | Variables | Required role variables |
|---|---|---|---|---|
| adversarial-critic | critic | 9345 | 18 | target |
| branch-manager | branch-manager | 9280 | 18 | branch_question |
| coordinator | coordinator | 10073 | 18 | none |
| deep-analyst | analyst | 9252 | 18 | analysis_question |
| evidence-auditor | evidence-auditor | 8674 | 18 | audit_scope |
| experiment-designer | experiment-designer | 9138 | 18 | current_conclusion |
| general-worker | worker | 8305 | 17 | none |
| lead-investigator | lead | 12053 | 19 | none |
| low-cost-bulk-worker | bulk-worker | 7440 | 19 | units, unit_procedure |
| memory-curator | memory-curator | 8721 | 21 | memory_scope |
| planner-decomposer | planner | 9592 | 20 | none |
| recovery-operator | recovery-operator | 9191 | 19 | incident |
| researcher-source-scout | researcher | 9144 | 18 | none |
| retrospective-analyst | retrospective-analyst | 8983 | 19 | run_record |
| synthesizer | synthesizer | 9474 | 20 | branch_findings |
| toolsmith-mcp-builder | toolsmith | 9537 | 18 | capability_request |
| verifier-evaluator | verifier | 8642 | 18 | claims_under_test |

Built-in templates:

| Template | Preset | Harness | Delegation | Budget tokens |
|---|---|---|---|---|
| default-lead | lead-investigator | local | up to 12 children, depth 3 | 400000 |
| default-branch-manager | branch-manager | local | up to 6 children, depth 1 | 150000 |
| default-worker | general-worker | local | none | 60000 |
| default-researcher | researcher-source-scout | local | none | 80000 |
| default-analyst | deep-analyst | local | none | 100000 |
| default-critic | adversarial-critic | local | none | 80000 |
| default-verifier | verifier-evaluator | local | none | 80000 |
| default-synthesizer | synthesizer | local | none | 120000 |
| default-retrospective | retrospective-analyst | local | none | 80000 |
| default-bulk | low-cost-bulk-worker | local | none | 30000 |

Built-in blueprints:

| Blueprint | Lead | Depth | Concurrency | Ceilings | Human gates |
|---|---|---|---|---|---|
| default-research-swarm | default-lead | 3 | 4 global / 2 per branch | 200 tasks, 2000000 tokens, 50 USD | before_adopt, on_budget_exhausted |
| unbounded-research-swarm | default-lead | unlimited | unlimited | unlimited | before_adopt, on_expansion |
| small-audit-swarm | default-branch-manager | 1 | 2 global / 2 per branch | 20 tasks, 300000 tokens, 5 USD | before_adopt |

## 7. Memory semantics

1. **Off by default at every level.** The global setting `memory.enabled` must be true, and each inner layer (project, swarm, run policy from the blueprint, task memory from the template) can only narrow: disable, drop scopes, or turn read or write off. Disabled means no retrieval and no writes; the prompt then says so.
2. **Scopes and namespaces.** agent (task's agent id), role (preset id), run (run id), swarm (blueprint id), project (project id), global. Stores: `.aos/memory/{project,runs,roles,swarms,agents}/<namespace>/items.jsonl`; global at `~/.aos/memory/items.jsonl`, created only when written. Retrieval never crosses namespaces the task is not in.
3. **Lifecycle.** Retrieve before a task (lexical, tags, recency, confidence, pins; per-query item and character limits; injected as `memory_context` with ids and provenance; event `memory.retrieved`). Record during work through `memory_writes` (agent and run scopes auto-commit; role, swarm and project writes are stored as `proposed` until a curator commits or promotes them; workers cannot write global). Reflect at run end (a `summary` record in the run scope). Retention on engine load and on demand (expiry, per-scope retention days, per-scope size eviction, compaction).
4. **Integrity.** Exact duplicates are skipped; a committed item with the same title in the same namespace is superseded; corrections supersede; forgetting tombstones; pinned items need the operator; secret-like content is refused with `memory_secret_like` and never fails the task; control characters are stripped; raw reasoning is never stored; events carry ids and counts, never content.
5. **Promotion.** Policy per pair: `agent_to_run` auto; `run_to_role`, `run_to_swarm`, `run_to_project`, `role_to_project`, `swarm_to_project` curator (operator or curator applies, anyone else gets a proposal); `*_to_global` approval (always a proposal); sensitive items never promote. `approveProposal` applies `memory_promotion` and `memory_clear` proposals.
6. **Retrieval provider.** `LexicalRetrieval` implements `search(items, {query, tags, limit, maxChars, now})`; an embedding provider later implements the same method and is selected by the memory service.

### 7.2 Engine-supplied prompt variables

`goal, definition_of_done, run_id, task_key, task_nonce, brief, context_paths, dependency_results, memory_context, capabilities, budget, sandbox, max_findings, max_summary_words, escalation_target, delegation, language` are supplied to any preset that declares them. Derived when a task does not set them: `target, branch_findings, claims_under_test, current_conclusion, audit_scope, objections, verification, proposed_writes, existing_items` (dependency results, falling back to the brief), `analysis_question, branch_question, incident, capability_request, units, unit_procedure` (the brief), `run_record` (run telemetry), `memory_scope` (`run`). Task variables always win. A missing required variable fails `startRun` before any mutation with `invalid_input` naming it.

## 8. Migration notes

- Store version is 2. A version 1 `state.json` is upgraded on first load by any process: empty collections `presets, templates, blueprints, settings, memoryIndex` and a `migrations` log are added, old tasks get `lease: null`, unknown fields are preserved, and the pre-migration file is kept once as `state.json.v1.bak`. A newer version is refused with `store_version_unsupported`.
- The demonstrator daemon on 7740 serves the frozen evidence directory with pre-migration code in memory; do not restart it against that directory with the new code, or point it at a copy.
- The fixture `tests/fixtures/state-v1.json` is a copy of the real project store and is what the migration test upgrades.
- New records never change existing ones: runs gain `blueprint, ceilings, policies, patches` only when used; tasks gain `lease, planTaskId, config, presetId` and template-applied fields only when templated.

## 9. Events added

`prompt.rendered, prompt.render_failed, preset.created|edited|forked|archived|restored|imported, template.created|edited|forked|archived|restored|imported|saved_from_agent, blueprint.created|edited|forked|archived|restored|imported, memory.policy_changed|retrieved|written|proposed|write_skipped|write_failed|duplicate_skipped|superseded|corrected|committed|pinned|unpinned|tombstoned|promoted|cleared|retention|reflected|imported, setting.changed|removed, run.patched, worker.reaped, task.requeued, attempt leases in task records`. Payloads carry ids, scopes, counts and versions; never prompt or memory text.

## 10. Known limitations

- Only the Codex adapter and the deterministic local worker execute; Claude Code, API, Ollama and command adapters remain typed refusals (dossier Stage 3). Templates may name them; dispatch fails closed.
- The capability registry (skills, MCP, plugins, toolsmith test gate) is not built; `capabilities.enabled` and template capability lists are recorded, not mounted.
- Worker sub-plans and worker questions are described in the presets but the plan-patch and task-level awaiting-user machinery is the next stage; today a worker cannot expand the plan.
- Improvement mode is recorded; only manual approval is implemented.
- Retrieval is lexical; no embeddings yet.
- HTTP has no bearer token and CORS is still permissive (board item S0.8, queued); the API stays loopback-only.
- Board items S0.6, S0.7 (remaining parts), S0.9, S0.10, S0.11, S0.12 are still queued after this handoff.
- The demonstrator caution in section 8.

## 11. Dashboard integration contract for Codex

1. Read `GET /api/v1/settings/manifest` once per session; build navigation from `groups`, forms from each setting's `schema` and `default`, allowed values from `enumerations` and `schema.values`, and registry forms from `inputSchemas`. Do not re-encode rules the manifest already states.
2. Show effective values with provenance from `GET /api/v1/settings/:key/effective?projectId=…&runId=…`; the `layers` array is the "where did this come from" view.
3. Gate destructive operations by `routes[].destructive.gate`: `confirm` needs a confirmation in the UI; `approval` should surface the returned proposal id and route the user to the proposals view; `policy` may return either a record or `{proposed, proposalId}`.
4. Changes to a running run go through `POST /api/v1/runs/:id/patch`; never write run fields another way. `GET /api/v1/runs/:id/patches` is the audit view.
5. Presets: list, open, `effective` for the composed sections, `preview` with variables for the rendered prompt; edits create versions; archive and restore are reversible except restore-default.
6. Templates and blueprints: list, open, history, create from JSON forms built from `inputSchemas.templateConfig` and `inputSchemas.blueprintConfig`; `blueprints/:id/estimate?depth=` is the dry-run view, and `indeterminate: true` must be rendered as unbounded, never as a number.
7. Memory: `stats` for the overview, `search` with scope, namespace, query, tags, `items/:id` for detail, policy get and put per scope; render `proposed` items separately from `committed`; never display secret-like content (the backend already refuses it).
8. Errors: every non-2xx body is `{ error, code, details }`; validation problems are in `details.errors[]` with `path` values like `$.config.depth.max` that map to form fields.
9. Illustrative versus live stays the dashboard's responsibility; nothing here fakes telemetry.

Written 2026-09-14 12:36 UTC.

## 12. Startup and runtime

```bash
npm install
npm test                      # 89 tests, deterministic local worker, no network
npm run engine                # daemon on 127.0.0.1:7740, store at AOS_HOME or ./.aos (migrates a v1 store on first load)
npm run dev                   # dashboard on 127.0.0.1:5173; the Vite proxy forwards /api and /health to the daemon
node bin/aos.mjs help         # CLI; forwards to the daemon when it is listening, else opens the store directly
```

Environment: `AOS_HOME` (store directory), `AOS_PORT`, `AOS_HOST` (keep loopback), `AOS_CONCURRENCY`, `AOS_EXECUTION=codex` for live Codex workers (ChatGPT login, single allowlisted model, read-only sandbox, at most four workers), `AOS_LOCAL_ONLY=1` to force the CLI onto the files even when a daemon runs. Global memory lives at `~/.aos/memory` and is only created when a global item is written; tests pass their own directory through the `memory.globalDir` engine option.

## 13. Live versus illustrative boundary

The dashboard has two modes. Illustrative renders hard-coded demo data and never touches the engine. Live local reads the daemon's snapshot and events and drives it through the same HTTP surface the CLI uses. Nothing in the engine fakes telemetry: every count in `snapshot.telemetry`, `snapshot.memory` and the settings diagnostics is computed from the store and the event log. Live workers exist only in Codex mode; the local worker is a deterministic stub and is labelled `local` on every task, agent and attempt so a live page can say so. The daemon on 7740 that Codex started against the frozen benchmark evidence directory is a demonstrator; the ordinary store is `./.aos`.

## 14. End-to-end operator flow (captured from `node bin/aos.mjs` against a fresh store, 2026-09-14 12:39 UTC)

Fork a built-in preset, edit it into a new version, build a template on it with scoped memory, build a blueprint that routes critique to that template, estimate it, enable memory globally and for the project, start a run from the blueprint, patch the running run, advance it, add and search memory, then perform a gated clear that becomes a proposal and is applied by approval. Outputs are truncated to their first lines.

```text
$ aos preset fork adversarial-critic strict-critic --name Strict critic
{
  "id": "strict-critic",
  "version": 1,
  "name": "Strict critic",
  "role": "critic",
  "builtin": false,

$ aos preset edit strict-critic --json {"sections":{"Mission":"You are a strict adversarial critic for run {{run_id}}. Target: {{target}}. Every objection must cite a line."},"sectionModes":{}}
{
  "id": "strict-critic",
  "version": 2,
  "name": "Strict critic",

$ aos template create --json {"id":"strict-critic-template","name":"Strict critic","config":{"preset":{"id":"strict-critic"},"harness":{"id":"local"},"budget":{"tokens":50000},"memory":{"read":true,"write":true,"scopes":["run","project"]}}}
{
  "id": "strict-critic-template",
  "version": 1,
  "name": "Strict critic",
  "description": null,

$ aos blueprint create --json {"id":"my-swarm","name":"My swarm","config":{"lead":{"templateId":"default-lead"},"childTemplates":["strict-critic-template","default-researcher","default-synthesizer","default-retrospective"],"kindTemplates":{"research":"default-researcher","critique":"strict-critic-template","synthesis":"default-synthesizer","retrospective":"default-retrospective"},"depth":{"max":2},"concurrency":{"global":2,"perBranch":2},"ceilings":{"tasks":50,"tokens":500000}}}
{
  "id": "my-swarm",
  "version": 1,
  "name": "My swarm",

$ aos blueprint estimate my-swarm   (levels only)
{"depthEstimated": 2, "totalAgents": 13, "totalTokens": 1840000, "unbounded": false, "warnings": ["worst-case tokens 1840000 exceed the tokens ceiling 500000"]}
[1, 12]

(project id: prj_33029df22c)
$ aos settings set memory {"enabled":true} --scope global
{
  "id": "set_b5e95c466b",
  "key": "memory",

$ aos memory policy set --scope project --scope-id prj_33029df22c --json {"enabled":true,"autoCommitScopes":["agent","run","project"]}
{
  "id": "set_7c249dc448",
  "key": "memory",

$ aos settings effective memory --project prj_33029df22c   (provenance only)
{"enabled": true, "provenance": {"layer": "project", "source": "project setting v1", "scopeId": "prj_33029df22c"}, "layers": ["builtin", "global", "project"]}

(goal id: gol_4f56aee881)
$ aos run start gol_4f56aee881 --blueprint my-swarm
run run_7683526f02  running  goal gol_4f56aee881  concurrency 2  execution local  blueprint my-swarm@1

(run id: run_7683526f02)
$ aos run patch run_7683526f02 maxConcurrency 1 --reason demo: serialise the swarm
{
  "version": 1,
  "key": "maxConcurrency",
  "value": 1,
  "reason": "demo: serialise the swarm",
  "at": "2026-09-14T12:38:57.253Z",

$ aos advance run_7683526f02
run run_7683526f02  awaiting_approval  steps=7  idle=true

$ aos tree run_7683526f02
tsk_c008965f1f  succeeded          intake         Interpret objective
  tsk_519dcfd25b  succeeded          research       Primary analysis
  tsk_e0001458a3  succeeded          research       Independent check
  tsk_6474f8b518  succeeded          research       Mechanism review
  tsk_808b14c037  succeeded          critique       Adversarial check
  tsk_ccc59c9d54  succeeded          synthesis      Synthesize decision
  tsk_e2488f4793  succeeded          retrospective  Write retrospective
    tsk_8e485599e4  awaiting_approval  adopt          Apply improvement proposal

$ aos events run_7683526f02 --limit 400 | grep -E 'prompt.rendered|run.patched'
2026-09-14T12:38:57.253Z  run.patched                              demo: serialise the swarm
2026-09-14T12:38:57.328Z  prompt.rendered              Interpret objective #1  
2026-09-14T12:38:57.331Z  prompt.rendered              Primary analysis #1  
2026-09-14T12:38:57.334Z  prompt.rendered              Independent check #1  
2026-09-14T12:38:57.336Z  prompt.rendered              Mechanism review #1  
2026-09-14T12:38:57.338Z  prompt.rendered              Adversarial check #1  
2026-09-14T12:38:57.341Z  prompt.rendered              Synthesize decision #1  
2026-09-14T12:38:57.344Z  prompt.rendered              Write retrospective #1  

$ aos memory add project prj_33029df22c --json {"type":"failure_lesson","title":"Timing constraint first","content":"Check the 40 ms delay boundary before any coupling claim.","tags":["coupling","timing"],"confidence":0.8}
{
  "id": "mem_8679de817a",
  "schemaVersion": 1,
  "scope": "project",
  "namespace": "prj_33029df22c",
  "type": "failure_lesson",

$ aos memory search --query "coupling timing"   (ids and titles)
[('mem_8679de817a', 'Timing constraint first', 6.2)]

$ aos memory clear project prj_33029df22c
{
  "proposed": true,
  "proposalId": "prp_8896ed0901"
}

(proposal id: prp_8896ed0901)
$ aos approve prp_8896ed0901
approved prp_8896ed0901
applied true

$ aos memory stats   (scopes)
{}
```

Every step is also available over HTTP with the same bodies (section 4), and every error along the way would have arrived as the `{ error, code, details }` envelope.

## 15. Ownership release

With this document, ownership of `engine/**`, `bin/aos.mjs` and `tests/**` returns to Codex (`codex-root-aos`) for integration and for the queued board items. Fable keeps `docs/architecture/**` and the coordination role. Everything is staged in git and uncommitted, as the founder asked.
