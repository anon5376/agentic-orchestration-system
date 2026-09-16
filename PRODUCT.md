# AOS

<!-- impeccable:product-schema 1 -->

## Platform

web

The current design proposal pairs a web dashboard with a CLI. The user has confirmed both interfaces; browser delivery, local hosting, and any later native desktop packaging remain open implementation decisions.

## Users

Initially the founder conducting research with documents, existing project context, and an objective. The intended audience may later include small teams and external users.

## Product Purpose

AOS is intended to coordinate a hierarchy of specialised agents around research objectives. It should interpret the initial request, narrow material ambiguities, organise and adapt the work, integrate results, and evaluate its own execution.

The user values research quality, speed, efficiency, a unified engine, and extensive customisation. The repository now contains a functioning local orchestration engine, dashboard, and CLI. Native integrations, distributed execution, and cross-harness quality benchmarks remain incomplete.

## Operating Context

- The user provides a research goal and relevant documents or other context.
- A lead agent analyses that material and assigns roles, prompts, tools, and subgoals.
- Branch leads can delegate further, with a mix of persistent and temporary roles.
- Workers should collaborate without overwriting or interrupting one another's work.
- Completion combines lead-agent judgement with automated checks.
- The system should reconsider failed approaches and seek user input when it cannot resolve the obstacle itself.

## Capabilities and Constraints

- Coordinate existing harnesses initially, with the possibility of a native AOS harness later.
- Support API credentials and provider-supported account login integrations. Exact integrations remain to be selected and verified during implementation.
- Avoid an arbitrary product-level agent-count cap. Execution capacity and practical scaling remain engineering questions.
- Use skills, plugins, and MCP integrations; create specialised tools when useful.
- Keep a retrospective after each run, describing failures, possible causes, and proposed improvements.
- Support user-approved improvements and an optional configurable automatic-improvement policy. No such policy has been enabled in this project.
- Explore specialised local models as a later efficiency mechanism. Their benefit has not been established.
- Offer configurable memory and retention, with separate global, project, and agent contexts.
- Offer configurable permissions, context sharing, and evidence traceability.
- Be open source and highly customisable. A specific licence is undecided.

## Interface Intent

The user has confirmed a dashboard and a CLI. Both interfaces act on the same investigations and expose consistent state, identifiers, and control meanings.

The dashboard defaults to a calm research docket: an electric editorial masthead, a concise question, a textual delegation outline, evidence state, and one next decision. Dense logs and configuration remain available through progressive disclosure instead of filling the first viewport.

## Brand Commitments

The Hermes Agent work by Nous Research remains the explicit mood reference: electric cobalt, white editorial type, severe contrast, subtle print texture, and strange scientific diagrams. It is not a source to copy. AOS needs its own marks, plate system, compositions, language, and interactions.

- Less crowded, less theatrical, and visibly designed by people who use research tools.
- Cobalt, paper, and ink replace the rejected red-on-black science-fiction treatment.
- No anatomical allegory, faux specimens, scanlines, or decorative chaos. Grain is confined to the cobalt masthead.
- White editorial serif titles create atmosphere; plain sans carries the actual work; mono is reserved for navigation and provenance.
- No generated artwork in the interface. Each route uses an original code-drawn technical plate tied to that page's subject.
- Dashboard and CLI remain first-class views over the same illustrative run state.

## Evidence on Hand

The product brief and the user-selected Hermes Agent screenshots are the design references. There are no real run traces, research datasets, or benchmark results in this repository. Any later prototype data must be explicitly illustrative.

## Open Decisions

- Exact interaction model for moving between the research docket, branch detail, and execution history.
- First research example and what evidence will demonstrate progress.
- Detailed intervention, approval, completion, and retry behaviour.
- Local versus remote execution and deployment.
- Credential ownership, storage, and sharing for multiple users.
- Persistence and default retention policy.
- Languages, dependencies, and implementation framework.
- Scope and evaluation rules for automatic improvement.
