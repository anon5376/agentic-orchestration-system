# Dashboard and CLI — proposed interaction model

Status: design discussion. This document proposes interfaces; its commands and behaviours are not implemented.

## One investigation, two interfaces

Use the same stable investigation and task identifiers across the dashboard and CLI. Starting work in one interface should make it visible in the other. Closing a viewer should not implicitly cancel work; the engine's hosting and lifetime still need an implementation decision.

Both clients should display when their view is disconnected or stale and confirm when a requested action has been accepted. Commands pending acknowledgement must not look completed.

## Dashboard structure

### Project workspace

Keep navigation centred on the current project, its investigations, and supplied context. Use a separate system area for reusable capabilities, worker connections, and improvement history. The main workspace should open the current investigation rather than defaulting to aggregate business metrics.

### Active investigation

Keep the research objective, current state, and important unresolved questions visible. Allow switching between a swarm graph, task tree, board, timeline, and research findings. These are different projections of one investigation, not separate task stores.

Primary view: awaiting the user's choice between swarm, research, or mission overview.

Selecting an item opens its assignment, status, inputs, findings, artifacts, dependencies, and relevant activity. Display an agent's identity separately from the task it currently owns, because reassignment must not erase task history.

At large scale, show branches and counts before individual workers; allow expansion, search, filtering, and a breadcrumb back to the full investigation. The graph must not require drawing every agent simultaneously. A tree/list view provides a keyboard-accessible equivalent.

### Start research

Begin with the goal and supplied context. Show the interpreted objective and material unresolved questions before execution begins. Put optional execution and permission settings behind an expandable control, with the effective settings visible before starting.

### Research findings

Present findings, hypotheses, contradictions, missing evidence, and supporting artifacts. Distinguish a completed task from an established scientific conclusion. Make original evidence accessible without requiring a chain of agent summaries.

### Improvements

Present the observed failure, evidence, proposed change, comparison with the previous version, evaluation status, and adoption history. Distinguish proposing a change, evaluating it, and applying it. Display the effective automatic-improvement setting; a prototype must never imply that real self-modification occurred.

### Capabilities and connections

Show workers, tools, skills, plugins, and MCP integrations with their availability and configured access. A missing login or tool should be reachable directly from the blocked task that needs it.

## Proposed CLI vocabulary

These are command-design examples, not usable commands. `R-17` and `T-42` are illustrative IDs.

| User action | Proposed command | Dashboard equivalent |
| --- | --- | --- |
| Start an investigation | `aos run "research goal" --context ./context` | New investigation |
| List investigations | `aos runs` | Investigation list |
| Follow a run | `aos watch R-17` | Open live investigation |
| Inspect a task | `aos inspect T-42` | Select task |
| Give direction | `aos steer R-17 "direction"` | Send direction to lead |
| Pause scheduling | `aos pause R-17` | Pause investigation |
| Resume | `aos resume R-17` | Resume investigation |
| Inspect findings | `aos findings R-17` | Findings view |
| Inspect proposed improvements | `aos improvements R-17` | Run retrospective |

Proposed semantics: pausing stops new task dispatch while showing any work still active. Interrupting an active worker is a distinct action whose behaviour depends on the worker integration. Sending direction records a new instruction and shows whether the lead has received and acted on it.

Use a readable default terminal output and an optional structured output mode for scripts. Watching should be separate from starting so an interrupted terminal connection does not create duplicate work when the user reconnects. These behaviours need validation in implementation.

## State coverage for the first design

- Empty project and first investigation.
- Objective clarification before execution.
- Running investigation with a selected task.
- Task waiting for another branch or user input.
- Worker unavailable or authentication required.
- Requested pause, paused state, and resume.
- Completed investigation, inconclusive findings, and retrospective.
- Disconnected viewer with stale state clearly marked.

## Next design decision

Choose the primary active-investigation view, then explore its visual composition. Colours, typography, specific controls, and graph rendering technology remain undecided.
