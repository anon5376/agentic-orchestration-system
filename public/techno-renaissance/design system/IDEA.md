# AOS: the idea

## One sentence

AOS is an open-source coordination layer that turns one difficult goal into a living hierarchy of specialized AI workers, lets them use different agent harnesses and capabilities, shows the work and resource consumption honestly, and improves its coordination methods through evaluated, reversible generations.

## What it is

AOS stands for **Agentic Orchestration System**. It begins as a second layer over existing systems such as Codex, Claude Code, DeepSeek Harness, direct model APIs, and local models. It is not initially another foundation model and it does not require one universal worker runtime.

The user supplies:

- a goal;
- relevant files, documents, data, and prior context;
- constraints, risk boundaries, and a definition of done;
- answers to a small number of questions when the goal is materially ambiguous.

A lead process studies the goal and context before assigning work. It chooses a decomposition, creates specialist roles, selects the appropriate harness, model, skills, plugins, MCP servers, and tools for each role, and decides which work can happen in parallel.

Each specialist can delegate again. The result is a dynamic hierarchy rather than a fixed team or flat chat room. “Unlimited agents” means the architecture imposes no arbitrary small cap; actual concurrency remains bounded by provider limits, local compute, cost, and useful work.

## How a mission unfolds

1. **Constraint:** A rough prompt becomes a mission with explicit boundaries and success conditions.
2. **Decomposition:** The lead creates a provisional task tree and identifies uncertainty, dependencies, and human gates.
3. **Swarm:** Specialized workers execute in isolated workspaces so parallel agents do not overwrite or interrupt each other.
4. **Evidence:** Findings, files, commands, failures, citations, and verification results are recorded against the tasks that produced them.
5. **Synthesis:** Competing branches and dissent are compared. A conclusion keeps its provenance and unresolved objections.
6. **Decision:** The user or an authorized policy selects the next action.
7. **Evolution:** The run produces a retrospective: what failed, why it failed, what could improve, and how that change should be tested.
8. **Next generation:** Approved changes are benchmarked against the previous version. Promotion requires evidence and retains a rollback point.

The plan is not frozen at mission creation. The lead may split a task, replace an approach, create a new specialist, request a missing input, or stop a low-value branch as evidence changes.

## Capabilities

AOS treats capabilities as routable resources:

- external harnesses such as Codex, Claude Code, and DeepSeek Harness;
- direct provider APIs and provider-supported account or OAuth paths;
- local inference systems such as Ollama;
- skills and reusable role instructions;
- MCP servers;
- plugins and external services;
- generated tools created for a specific research role.

A generated tool is not trusted merely because an agent wrote it. It requires a bounded test before another worker can depend on it.

Provider adapters expose their actual differences: model availability, reasoning controls, context limits, rate limits, authentication mode, tool support, token accounting, and cost. The interface must never imply that every provider behaves identically.

## Dashboard and CLI

The dashboard and CLI are two views over the same mission state.

The CLI is the fastest path for creating goals, attaching context, inspecting runs, intervening, scripting workflows, and operating over SSH.

The dashboard makes relationships visible. It combines a task hierarchy, active dependency path, evidence view, timeline, board state, and generation comparison without displaying all of them at full density simultaneously.

At a glance, the user should be able to see:

- the active goal and current definition of done;
- the organization hierarchy and the task/dependency hierarchy;
- which agents are running, waiting, blocked, failed, or complete;
- who delegated each task and which workspace owns it;
- the harness, provider, model, and reasoning effort;
- tokens, context use, estimated cost, elapsed time, and rate-limit pressure;
- tools, skills, plugins, and MCP connections in use;
- evidence produced, verification status, and unresolved disagreement;
- human approvals, safety boundaries, and reversible intervention points;
- what changed between system generations and why.

The organization hierarchy and task dependency graph are related but distinct. A manager may own several workers whose tasks depend on work elsewhere. The interface must not collapse ownership, scheduling, and causality into one decorative node graph.

## Memory

Memory is separated by purpose and authority:

- **Global memory:** reusable system knowledge, policies, and validated patterns.
- **Project memory:** mission-specific documents, findings, decisions, and history.
- **Agent memory:** temporary working context for one role or task.

Inheritance, retention, export, and privacy boundaries are visible and configurable. “Remember everything” is an option with consequences, not a hidden default.

## Self-improvement

Self-improvement is a controlled scientific loop:

```text
observed failure
      ↓
causal hypothesis
      ↓
proposed change
      ↓
held-out evaluation
      ↓
comparison with baseline
      ↓
approve / reject / revise
      ↓
versioned generation + rollback
```

Retrospectives generate proposals, not proof. The system does not approve its own high-risk changes. Settings may allow manual approval, automatic promotion of narrowly defined safe changes, or broader automation, but every promoted change remains versioned, measured, and reversible.

Over time, AOS may train or adapt small local models for cheap, repeated roles such as classification, routing, extraction, or verification. A local model earns work only when it improves the measured cost, speed, or quality trade-off against the current baseline.

## The long horizon

The ambition is compounding coordination: solve more difficult goals, at higher quality, with less wasted time and compute, while learning from every run.

The visual idea of **technological singularity** represents that horizon—the point where many agents, tools, memories, and successive improvements converge into a system whose next generation is meaningfully more capable than the last.

This is direction, not a present-tense product claim. The prototype must not pretend that AOS is autonomous general intelligence, has unlimited physical compute, or has already proven self-improvement.

## What it is not

- Not a B2B content factory.
- Not a flat multi-agent group chat.
- Not a fixed workflow builder where every future task must fit a predefined graph.
- Not a decorative node map that hides who is doing what.
- Not an unsupervised engine that rewrites itself and deploys the result.
- Not one proprietary model pretending to be a swarm.
- Not “unlimited” through unbounded spending or uncontrolled process creation.

The intended use is serious, context-heavy research and problem solving: give the system a difficult objective and the relevant world around it, then let a visible, inspectable organization of specialized minds pursue it.
