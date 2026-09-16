# AOS parity and superiority tracker

## Decision

AOS is not yet at OpenCode or OpenClaw feature depth, and no evidence shows it is superior to Codex. Its strongest differentiators are governed hierarchy, immutable run plans, resource accounting, and evaluation-gated improvement. The next work should turn those control-plane strengths into a broadly useful runtime: real provider APIs, durable sessions, richer tools, automation, and comparative evaluations.

Status is tied to code and executable checks, not feature names in the interface.

## Status definitions

- **Shipped:** implemented on the current branch and covered by an executable check.
- **Partial:** a bounded implementation exists, but a material use case or proof is missing.
- **Missing:** no runnable implementation exists.
- **Unproven:** the feature exists, but the comparative claim has not been measured.

## Capability tracker

| Surface | External baseline | AOS evidence | Status | Completion evidence still required |
|---|---|---|---|---|
| Hierarchical orchestration | OpenCode has primary agents and subagents. OpenClaw exposes spawn, send, wait, history, and session ownership tools. | Immutable plan versions, exact child-template pins, bounded delegation, approval gates, seven manager-role slots, and worker fan-out without a product cap. | Shipped locally | A sustained run with dynamic branches, cancellation, recovery, and more workers than one Codex session could coordinate alone. |
| Provider execution | OpenCode supports many providers. OpenClaw supports provider plugins and local models. | Codex and Claude account sessions, direct OpenAI Responses, loopback Ollama, and a fixed external-harness protocol are mounted. OpenAI has injected-transport evidence but no live operator-key receipt from this run. | Partial | Live receipts from every advertised provider, then additional provider-specific adapters without fallback or substitution. |
| Authentication | Competitors support provider credentials and selected OAuth flows. | ChatGPT-login Codex and Claude account sessions work without copying their credentials. OpenAI Responses reads a key only from a named environment variable. | Partial | Provider-specific OAuth only where the provider officially supports it. No generic OAuth claim. |
| Sessions and continuation | OpenCode exposes session creation, children, fork, abort, share, diff, and summarize. OpenClaw stores and routes durable sessions. | AOS owns redacted harness-session records with exact project, run, task, agent, and attempt scope. Retries cannot inherit a prior attempt's session. | Partial | Safe continuation and fork semantics for supported providers, transcript policy, compaction, search, and operator-visible lifecycle controls. |
| Tools and MCP | OpenCode supports custom tools and local or remote MCP servers. OpenClaw has tool policy, plugins, code mode, and tool search. | Versioned capability registry, a bounded generated tool, engine-owned MCP reader, operator-pinned local stdio MCP, and one approval-gated workspace writer. | Partial | Multiple tools per server, discovery, remote MCP with provider-supported auth, fine-grained ask/allow/deny policy, and sandboxed effectful tools. |
| Agent configuration | OpenCode agents bind prompts, models, and tool permissions. OpenClaw agents own workspaces, bootstrap context, skills, and session stores. | Versioned presets, templates, and swarms bind prompts, models, tools, memory, delegation, budgets, and access. | Shipped locally | Import/export compatibility tests, migration guarantees across releases, and usability evidence from creating a non-trivial swarm without editing JSON. |
| Memory | OpenClaw provides workspace memory, dated notes, retrieval, and optional cross-conversation recall. | Scoped memory supports search, retention, correction, promotion, pinning, forgetting, import, export, and role or agent policy. It is off by default. | Shipped locally | Retrieval-quality evaluation, larger-store latency measurements, and a transparent context-budget view. |
| Permissions and isolation | OpenCode supports per-tool allow, ask, and deny rules. OpenClaw combines tool policy with optional sandbox workspaces. | Exact capability versions require tests, enablement, and scoped grants. Provider sandboxes and host-process disclosures fail closed. | Partial | General per-tool ask/allow/deny rules and an OS-level sandbox for operator-added processes. |
| Events and control plane | Both competitors expose programmatic runtime control and live status. | Loopback-only authenticated HTTP, CLI parity, global event cursors, replay, server-sent events, resync, and a local worker-pool protocol. | Shipped locally | Stable public schema versioning, SDK generation, backpressure tests, and an authenticated cross-host transport. |
| Automation | OpenClaw has cron, heartbeat, hooks, webhooks, and isolated scheduled sessions. | No AOS-owned scheduler or trigger runtime is shipped. | Missing | Durable schedules, missed-run semantics, captured authority, cancellation, history, and dashboard/CLI controls. |
| Extensibility | OpenCode and OpenClaw expose plugin systems. | AOS versions capability metadata and can run a narrow local MCP or an operator-owned external harness. | Partial | A documented plugin lifecycle, signed or pinned packages, hooks, migration, reload, failure isolation, and an install/uninstall control surface. |
| Resource governance | Competitor controls vary by provider and runtime. | AOS reserves concurrency, tokens, cost, and time before workspace claim, then settles verified usage without hiding overruns. | Shipped locally | Multi-host accounting and adversarial tests against provider retries, partial usage, and network partitions. |
| Self-improvement | No competitor feature name proves better outcomes. | Proposals, comparable evaluation receipts, versioned policy genomes, approval, deterministic scheduler replay, and rollback are implemented. | Partial | Model-quality and cross-harness evaluations. No source rewrite or promotion may occur from self-authored evidence alone. |
| Operator experience | OpenCode has a mature TUI and server API. OpenClaw has onboarding and a broad Control UI. | Dashboard and CLI share state; live and illustrative modes are explicit. | Partial | End-to-end setup usability, error recovery, complete configuration coverage, accessible mobile layouts, and release packaging. |
| Superiority to Codex | Requires a defined task set and head-to-head evidence. | AOS adds multi-agent governance and run-level evidence around Codex workers. The current benchmark measures AOS scheduling from one live Codex trace only. | Unproven | Blindly scored task quality, completion rate, operator interventions, wall time, token use, cost, recovery, and reproducibility across repeated AOS and direct-Codex runs. |

## Acceptance gates

Parity is reached only when every row above is either shipped or deliberately excluded with a product decision. A passing unit suite is necessary but does not establish parity.

Superiority is reached only when a preregistered comparative suite shows a material advantage over direct Codex on at least one primary outcome without an unacceptable regression in the guardrails. The primary outcomes are task success and evidence quality. Guardrails are operator interventions, elapsed time, tokens, cost, reproducibility, and safety violations.

The comparison must use the same goals, source material, model family where possible, environment, time limits, and scoring rubric. Evaluators must not know which system produced each artifact. AOS scheduling replays are engineering tests, not superiority evidence.

## Next implementation order

1. Prove the direct OpenAI adapter against a live operator-selected account and exact model.
2. Add provider session continuation and fork semantics without weakening attempt ownership.
3. Generalize tool policy to allow, ask, or deny exact tool invocations.
4. Add durable automation with captured authority and missed-run history.
5. Build the comparative runner and freeze its tasks and scoring rubric before viewing results.
6. Expand the plugin and distributed-worker surfaces only after their trust boundaries are explicit.

## External baselines

- OpenCode agents and permissions: <https://opencode.ai/docs/agents>
- OpenCode tools: <https://dev.opencode.ai/docs/tools/>
- OpenCode MCP: <https://opencode.ai/v2/docs/mcp-servers>
- OpenCode server API: <https://dev.opencode.ai/docs/server/>
- OpenClaw capability overview: <https://docs.openclaw.ai/tools>
- OpenClaw session tools: <https://docs.openclaw.ai/concepts/session-tool>
- OpenClaw runtime: <https://docs.openclaw.ai/concepts/agent>
- OpenClaw memory: <https://docs.openclaw.ai/concepts/memory>
