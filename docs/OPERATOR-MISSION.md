# Operator mission: AOS depth and model control

## Objective

Raise AOS from its current local research-orchestration MVP toward the depth and reliability of mature agent harnesses such as OpenCode and OpenClaw. AOS should be more capable and governable than a single-agent coding harness.

The shipped foundation includes a first-class Models workspace, immutable runtime plans, operator-only plan expansion, a reconnectable event spine, worker clarification states, an operator-gated lead planner, loopback operator authentication and durable resource accounting. The full mission remains broader than this foundation.

## Operating hierarchy

- Lead: this root task, acting as the Astra coordination layer. Exact root runtime identity is not independently exposed here, so model identity is not claimed as verified.
- Managers: Terra, maximum seven logical managers. One is active in the first wave because the current runtime has four total agent slots.
- Workers: Luna at max effort. The product design allows an unbounded logical worker pool, while every real run remains bounded by provider quota, budget, sandbox and available runtime slots.
- Review order: Luna artifact and checks, then Terra integration review, then root acceptance.

## Current plan

1. Keep `#/models` honest about provider truth, current runtime, allowed models, per-worker assignment and explicit save/version behavior.
2. Use immutable plan versions and operator-only append receipts as the run-control boundary.
3. Drive dashboard updates through global event cursors, bounded replay and SSE with resync and polling fallback.
4. Keep task-level `awaiting_user` and `blocked` states and the schema-valid lead-planner proposal contract fail-closed.
5. Keep the shipped capability registry as the assignment boundary; no capability becomes mountable before its exact version, current passing test and scoped permissions are explicit.
6. Reserve provider, project and run capacity before workspace claim; settle verified usage without hiding overruns and gate future work when a ceiling is exhausted.
7. Let authorized workers propose bounded child work through exact template versions; append accepted children as a new immutable plan version and keep unlimited ancestry operator-paced.

## Current evidence

- The scheduler, task leases, workspace isolation, recovery, versioned prompts/templates/blueprints, scoped memory and fail-closed Codex adapter are implemented and covered by the current test suite.
- `#/models` exposes enforced runtime, policy-allowed models, adapter readiness and versioned worker assignment. Configured-only providers are not presented as executable.
- Every new run receives an immutable plan v1. Operator append patches produce later immutable versions, receipts and per-task plan provenance. Stale, cyclic, over-budget and unsupported live patches fail without changing the plan.
- The append-only event log has durable global cursors, bounded replay and SSE. The dashboard resyncs from authoritative snapshots and retries with bounded backoff. It falls back to polling without duplicating streams.
- The HTTP control plane refuses non-loopback binds, Host headers, browser origins and Vite proxy targets; never emits wildcard CORS; caps JSON bodies at 1 MiB; and requires a private operator bearer token on every non-health route. The browser receives that token only through the loopback development proxy, not in its bundle.
- Claude Code is mounted through its existing `claude.ai` account session. Mixed runs keep local, Codex, and Claude assignments explicit; Grok and generic HTTP remain typed configuration boundaries. Dispatch-bound sessions wrap opaque harness references in AOS-owned authorization scope.
- Task-level questions, dependency blocking and lead-planner proposals persist across restart. Lead planning uses verified ChatGPT-login Codex at `gpt-5.6-terra`/`max`/read-only, requires explicit request IDs and operator acceptance, and exposes the same lifecycle through HTTP and CLI.
- Runtime roles are engine-bound rather than plan-selected: manager roles use Terra/max, worker roles use Luna/max, substitutions fail closed, and every attempt records requested and effective posture. The run-wide logical manager ceiling is seven across initial and delegated tasks; retries reuse a slot. Logical worker fan-out remains unbounded by this role policy while physical provider, project, run, and budget limits remain enforced.
- Provider views and dispatch now consume one public, redacted contract for catalog provenance, auth proof, requested/effective runtime, sandbox, cancellation, attestation, quota state and typed failures. Dispatch refuses an invalid contract before workspace claim.
- The capability registry versions skills, MCP servers, plugins and tools; records immutable test, state and permission receipts; and blocks dispatch unless an exact enabled version has a current passing test and sufficient scoped permission. Tasks may invoke the generated `aos.bounded-echo-v1` adapter, the engine-owned `aos.staged-text-reader@1`, or one operator-pinned local stdio MCP tool. The local adapter uses a fixed, hash-pinned launch descriptor and an engine-run probe; it is explicitly labelled `host_process_unisolated`, not presented as an OS sandbox. One deterministic task-workspace writer is also shipped. It accepts no path or content from the plan, requires approval for the exact upcoming attempt, records only fingerprints publicly, and supports bounded rollback. Generic writable and externally acting execution remain unavailable.
- Dispatch-bound harness sessions now receive AOS-owned IDs with exact project, run, task, agent and attempt scope. Public API and CLI views omit provider references; reset and retention remove the stored reference, and retries cannot inherit or inject another attempt's session.
- Policy proposals require an immutable, comparable evaluation receipt before approval. Promotion records a versioned policy genome and rollback appends a restoring version. AOS can replay a frozen scheduler suite for `maxConcurrency` proposals; metrics and artifacts outside that deterministic suite remain operator-attested.
- Verified successful workers can now propose child tasks through a strict shared Codex/Claude contract. The engine pins exact child-template versions, derives execution authority and parent dependencies, enforces depth, fan-out and aggregate budgets, rejects secret-like proposal content before persistence, and records accepted, rejected, stale or awaiting-approval receipts. Unlimited ancestry is supported but cannot recurse without a fresh operator decision at every generation.
- Ollama is now mounted as an explicit mixed-mode worker for non-delegating bulk roles. Its adapter accepts only literal loopback origins, refuses auth and redirects, preflights one exact installed model, preserves locally reported token counters without inventing USD, and remains distinct from externally verified provider evidence. Initial and appended plans share the same admission rule.

## Architecture sequence

1. **Models truth boundary — shipped.** Display enforced runtime, policy-allowed models, configured-only adapters and per-worker assignments without implying that a saved choice is executable.
2. **Versioned plan and event spine — shipped.** Immutable plan versions, validated append patches, per-task plan provenance, task waits, dependency blocking, global event cursors, replay, SSE and transport fallback are implemented.
3. **Planner contract — shipped for Codex.** A verified Terra/max lead planner proposes a bounded schema-valid plan. Ambiguity waits for operator answers, and no task becomes runnable until the operator accepts the active proposal.
4. **Provider contract — shipped for mounted adapters.** Each adapter declares catalog provenance, auth boundary, requested and effective runtime, sandbox and cancellation guarantees, attestation strength, quota signals and typed failures. Models and dispatch consume the same verdict.
5. **Capability registry — four bounded execution adapters shipped.** Skills, MCP servers, plugins and generated tools are version-pinned, tested, permissioned and revocable before assignment. Dispatch persists the resolved mount receipt. The generated `aos.bounded-echo-v1` tool accepts bounded engine-derived input. The engine-owned `aos.staged-text-reader@1` and operator-pinned local stdio MCP adapter each read one staged declared file over a fixed protocol; the local adapter runs as an explicitly unisolated host process and is unavailable to the worker pool. The task-workspace writer updates one fixed engine-owned file from deterministic bytes after an exact approval and fenced claim. It keeps prior bytes in a private bounded journal, publishes fingerprinted receipts, recovers a post-write interruption, and supports an idempotent rollback. Generic discovery and additional effectful adapters remain pending.
6. **Session authority — shipped for worker dispatch.** AOS IDs wrap opaque harness references with exact dispatch scope, retention and reset semantics. Provider-specific resume execution remains pending.
7. **Measured improvement — shipped as an evidence gate for policy proposals.** Evaluation receipts bind quality, cost, latency, verified-runtime rate and operator intervention to the current proposal, full baseline and genome head. Promotion and rollback append immutable genome versions. An engine-owned deterministic replay evaluates `maxConcurrency` changes against a frozen scheduler suite. Live cross-harness and model-quality benchmarks remain pending.
8. **Resource governance — shipped for mounted providers.** Every admitted attempt receives a durable reservation before workspace claim. Provider, project and run concurrency are physical bounds; token, USD and wall-clock ceilings are enforced from versioned settings and run policy; verified usage settles exactly; unattributed failures settle conservatively; and overruns remain visible instead of stranding an active reservation.
9. **Scaling and operator UX.** Extend the local reservation protocol into a distributed scheduler while CLI and dashboard consume the same reconnectable event stream.
10. **Dynamic delegation — bounded kernel shipped.** Authorized workers can expand the active hierarchy without rewriting prior plan versions. Approval decisions use only the stored canonical candidate, reject stale bases, and are idempotent by request ID. Distributed execution and a dashboard approval surface remain pending.

## Resource governance

Before a workspace is claimed, AOS now writes a durable resource reservation for the exact task attempt. The local governor accounts input, cached, output and reasoning tokens together; finite USD limits reject an unknown cost rather than treating it as zero. A resource refusal becomes a typed task operator gate with the blocked dimension, limit, consumed and reserved amount, and remediation text. Answering that gate after an operator raises a versioned budget setting retries without erasing earlier receipts. Cancellation, failure settlement and orphan recovery settle the reservation conservatively, so retries cannot reset spend. The only cross-engine dedupe guarantee is the store transaction; provider capacities and reservation receipts remain physical bounds even when a logical swarm is configured unlimited.

The shipped writable scenario is deliberately narrow. It runs only in the local in-process engine, rejects pool execution, uses no shell, child process, network or external-action adapter, and never accepts a user-selected file path or raw content. The generic approval endpoint refuses it; operators use the exact workspace-write approval and rollback actions exposed through the loopback HTTP API and CLI.

## Ownership — completed foundation wave

- Root: mission record, integration review, independent test floor and live browser verification.
- Terra manager: architecture brief and reverse review; no self-approval by implementation workers.
- Luna frontend: Models workspace, live run-plan inspection and append controls, SSE/replay transport and responsive behavior.
- Luna backend: model-control seam, immutable plans, operator append validation, durable event cursors, worker wait states, lead-planner contract and multi-process race coverage.

## Constraints

- Preserve the current uncommitted setup-assistant work.
- No new dependencies, public bind, credential access, auth replacement or silent model substitution.
- Live and illustrative state stay explicit. Unsupported adapters remain visibly unavailable and fail closed.
- Model and worker changes are versioned and require an explicit operator action.
- Logical unlimited scale is not presented as observed runtime capacity.

## Open decisions

- Whether the setup assistant itself should invoke Codex through a dedicated verified configuration-session path or remain a deterministic guide.
- Whether Ollama or a generic Responses-compatible API should be the next mounted provider.
- How projects constrain model catalogs without reintroducing a hard-coded engine allowlist.
