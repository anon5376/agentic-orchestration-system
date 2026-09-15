<!-- SEED: established with the user before implementation; re-run design-system extraction after the new interface exists. -->
---
name: AOS / Acceleration Chamber
description: A restrained research interface in which a coordinated intelligence visibly accelerates, converges, mutates, and reaches beyond its previous generation.
---

# Design System: AOS / Acceleration Chamber

## Overview

### North star

The dashboard is **The Acceleration Chamber**: the control surface of an intelligence accelerating beyond its previous form.

It combines two different sources without turning either into costume:

- **Nous/Hermes discipline:** severe cobalt and white fields, thin contemporary typography, editorial scale, hard boundaries, sparse image rhythm, and a strong contrast between calm frame and strange content.
- **Technological accelerationism:** recursive branching, compressed time, competing hypotheses, machine mutation, convergence, and the feeling that each completed run creates a more capable next generation.

This is not retro-futurism, Renaissance cosplay, a generic cyberpunk HUD, or an AI-themed admin dashboard. The mood is current, difficult, and purposeful. It should feel like serious research infrastructure whose internal velocity occasionally becomes visible.

### Spatial thesis

**Per aspera ad astra** is expressed as a system, not as a slogan or Roman motif:

1. A constrained objective enters at the bottom.
2. Work branches upward through agents and specialist sub-swarms.
3. Evidence and dissent compress toward a convergence point.
4. A decision mutates the system into a new generation.
5. The interface opens onto the unresolved frontier above.

The shared spatial narrative is:

```text
FRONTIER / UNRESOLVED UNKNOWN
             ↑
CONVERGENCE / SYNTHESIS / SINGULARITY
             ↑
MUTATION / NEW GENERATION
             ↑
SWARM / BRANCHES / SPECIALISTS
             ↑
CONSTRAINT / INITIAL OBJECTIVE
```

### Singularity

The singularity is a **functional convergence state**, never stock space wallpaper. It appears when many branches, models, evidence paths, and generations compress into one consequential decision.

It may be shown through gravitational hierarchy, lensing of nearby traces, a narrow aperture, compressed timestamps, convergent paths, or a dense core that can be opened back into inspectable sources. The metaphor must reveal system state.

### Restraint rule

The perimeter is calm; the work field can become violent.

- Navigation, labels, inspectors, and inactive regions remain quiet and precise.
- Visual intensity is localized to active reasoning, conflicts, bottlenecks, mutation, and convergence.
- Every unusual mark must correspond to data, state, causality, or an action.
- A screen has at most three major visual regions and one dominant focal event.
- Density comes through progressive disclosure, not by displaying everything at once.

## Colors

### Core palette

| Token | Value | Use |
|---|---:|---|
| Acceleration Cobalt | `#101CFF` | Full-field active state, selected branches, primary action |
| Void | `#050509` | Dark operational surfaces and deep negative space |
| Ultraviolet Transit | `#6B45FF` | Phase transitions, model handoffs, temporal depth |
| Ion Signal | `#B8FF3D` | Verified success, healthy execution, recovered path |
| Intervention Vermilion | `#FF3B12` | Conflict, human gate, failure, rollback, irreversible consequence |
| Mineral White | `#F4F4F0` | Warm editorial canvas and primary light text |
| Cold White | `#FAFBFF` | High-contrast labels and active controls |
| Graphite | `#15151B` | Secondary dark plates |
| Quiet Metal | `#7F818C` | Secondary text and inactive telemetry |
| Rule | `#CFD0D6` | Dividers and structural outlines |

### Application rules

- Use cobalt or void as a committed field, not as card decoration.
- Mineral white is the default calm surface; void is the default operational surface.
- Cobalt communicates active computation or selection.
- Ultraviolet communicates transition, distance, or an adjacent generation. It does not decorate static panels.
- Ion green is reserved for verified states. It never means “cool.”
- Vermilion is rare and consequential. If everything is red, nothing is urgent.
- Use one dominant field, one signal colour, and neutrals on a normal screen.
- No rainbow neon, teal-magenta cyberpunk palette, multicolour glow, gradients-as-content, or arbitrary decorative colour.

## Typography

### Families

- **Display:** a narrow contemporary grotesk with high vertical force. It should feel engineered, not nostalgic.
- **Interface:** a neutral modern sans with excellent small-size rendering.
- **Telemetry:** a disciplined monospace for IDs, runtime state, models, token counts, cost, timestamps, and CLI output.

Use self-hosted fonts when implemented. Choose families with regular and medium weights; the hierarchy comes from scale and position more than excessive weight.

### Scale and hierarchy

- One monumental title or system state may dominate the viewport.
- Section titles are compact, narrow, and aligned to the governing grid.
- Body copy stays readable and direct. Avoid fashion-editorial line lengths that damage comprehension.
- Telemetry may be small but never microscopic.
- Uppercase is reserved for rails, labels, state, and terse actions. Do not uppercase paragraphs.

### Distortion

Typography can stretch, shear, split, or phase-shift only while representing:

- a live model handoff;
- a branch divergence;
- a generation boundary;
- temporal compression;
- a system fault.

Static titles remain crisp. No permanent glitch font, blackletter, faux terminal type, serif classicism, or Y2K “techno” lettering.

## Layout

### Shell

- A narrow global rail anchors the top.
- A narrow CLI/status rail anchors the bottom and expands only when requested.
- There is no permanent left sidebar.
- Route identity, prototype/live state, connection state, and the command aperture remain visible without dominating the page.
- Hard boundaries, cropped fields, and edge-to-edge colour blocks replace floating cards.

### Desktop composition

- The primary work field occupies roughly two thirds of the viewport.
- A context inspector occupies the remaining third only when an item is selected.
- Use no more than three major regions: primary field, context/evidence, and decision/action.
- Large negative space is functional. It establishes hierarchy and gives active traces somewhere to move.
- A bottom decision strip appears only when a meaningful gate exists.

### Density

The system may coordinate an unlimited number of agents, but the interface never attempts to draw unlimited nodes.

- Show the active path and the nearby causal neighbourhood.
- Aggregate dormant branches into named clusters with counts.
- Expand a cluster in place or enter it as a new scale.
- Summarize repeated low-value workers as a lane, bundle, or density field.
- Preserve lineage when moving between scales.
- Move secondary metrics into the inspector, not onto every node.

### Route character

- **Missions:** few large active objectives; velocity and generation shown before metadata.
- **Goal Intake:** one clear aperture for the initial objective, documents, constraints, and ambiguity.
- **Swarm:** hierarchical work topology, active path, model choice, tokens, cost, time, and dependency state.
- **Evidence:** inspectable source plates and traceable claims, with dissent kept visible.
- **Synthesis:** branches visibly compress toward a conclusion; objections remain attached.
- **Evolution:** baseline and candidate generations, changed rules, execution traces, metric deltas, rollback points.
- **Capabilities:** nonhuman routing topology for workers, models, skills, MCP, plugins, and generated tools.
- **Memory:** layered global, project, and agent memory with explicit inheritance and boundaries.

### Responsive behaviour

- Above 1200px, retain the full dominant field plus conditional inspector.
- Between 760px and 1200px, reduce peripheral telemetry and collapse aggregate branches while retaining the central causal path.
- Below 760px, convert the spatial field into ordered stages and hierarchical lists.
- On mobile, the inspector becomes a bottom sheet and the CLI becomes a full-width sheet.
- Do not produce a miniature unreadable desktop graph.

## Elevation & Depth

The interface is structurally flat. Depth comes from relationships, not card shadows.

- Use adjacency, occlusion, crop, scale, density, and controlled parallax.
- Lensing and spatial compression are allowed only around an active convergence core.
- A selected branch may pull forward while unrelated branches recede in contrast.
- Evidence must remain reversible: opening the core reveals the branches and sources that produced it.
- Generation changes leave a visible scar or seam so improvement never looks magical.

Do not use glassmorphism, glossy cards, soft drop shadows, floating panels, bevels, or decorative 3D chrome.

## Shapes

- Primary geometry is rectangular, cropped, and edge-aligned.
- Corners are square or at most 2px.
- Dividers are 1px and may be interrupted by labels or connection ports.
- Circular geometry is reserved for convergence, apertures, time, capacity, and connection sockets.
- Crosshairs and registration marks may identify coordinates, selected evidence, or lineage points; they must not be scattered as filler.
- Connectors have clear direction, source, and destination.

### Signature shape: open convergence aperture

The recurring AOS mark is an **open convergence aperture**: asymmetric paths compress toward a centre but do not terminate there. A new path exits on the far side as the next generation.

The aperture may become:

- the AOS sigil;
- the goal input focus state;
- the centre of the swarm field;
- the synthesis gate;
- the mutation boundary;
- the loading/progress indicator.

It must remain legible at 16px and expressive at viewport scale.

## Components

### Global Rail

A narrow edge-to-edge strip containing the AOS aperture, current route, live/illustrative state, connection health, command trigger, and essential navigation. It is an instrument rail, not a marketing header.

### Objective Aperture

The initial goal enters through a single high-contrast field. Attached constraints, files, definitions of done, uncertainties, and required human decisions orbit the objective by importance. The prompt is dominant; setup controls are secondary.

### Acceleration Field

The central working surface. It shows the currently relevant portion of the agent hierarchy and its movement through time. Its geometry is driven by causal depth and delegation, not decorative network physics.

At minimum, the selected view makes these facts readable:

- which objective is being pursued;
- which agent or aggregate owns each visible task;
- parent and child relationships;
- worker harness and model;
- running, waiting, blocked, failed, or complete state;
- tokens, estimated cost, and elapsed time;
- evidence produced and the next gate.

### Agent Trace

A trace is a directional line with a source, destination, state, and temporal character.

- Stable execution: crisp cobalt or white.
- Verified completion: ion endpoint.
- Waiting: low-contrast broken segment.
- Conflict or intervention: vermilion interruption.
- Model handoff: brief ultraviolet phase shift.

The trace thickens or accelerates only when backed by throughput or urgency data.

### Convergence Core

The singularity component. It summarizes how many branches, agents, models, evidence items, and generations are converging. It never hides provenance. Selecting it expands the core into its competing inputs, confidence, unresolved objections, and proposed decision.

### Generation Rift

A functional mutation seam separating baseline from candidate. It contains:

- changed rules or prompts;
- changed task topology;
- execution trace differences;
- metric deltas;
- new regressions;
- safety checks;
- rollback point;
- adoption state.

No syringe, human body, or mystical transformation allegory.

### Evidence Plate

A bounded source or finding with claim, provenance, freshness, confidence, contradiction state, and downstream consumers. Images can be dithered or thresholded, but source text and citation controls remain crisp.

### Context Inspector

A conditional detail region for the current selection. It carries the metadata that would otherwise overcrowd the work field. It disappears when nothing is selected and becomes a bottom sheet on narrow screens.

### Decision Gate

A bottom strip shown only when a decision changes the run or a future generation. Each choice states action, consequence, reversibility, and required authority. Destructive or self-modifying actions use vermilion and require an explicit gate.

### CLI Sheet

A collapsible, keyboard-first command surface. It shows the precise command, output source, current working context, and whether an action is simulated or real. It does not imitate a terminal when no executable action exists.

### Imagery

Use nonhuman technological imagery that carries meaning:

- infrastructure, machinery, fibres, chips, servers, optical systems;
- scans, material structures, robotic mechanisms, signal fields;
- dithered evidence fragments and severe documentary crops;
- abstract topology generated from real task structure.

Human imagery is exceptional and must be necessary to the research subject. Do not use statues, Renaissance figures, AI faces, disembodied hands, humanoid robots, brains, or generic anatomical heads as brand decoration.

### Motion

Motion is causal and brief:

- branches split when work is delegated;
- traces travel upward or inward as evidence accumulates;
- the core compresses during synthesis;
- a handoff phase-shifts once;
- a mutation opens a seam and leaves a scar;
- a new generation copies forward, then resolves into its differences.

No ambient particle field, endlessly pulsing neon, auto-scrolling telemetry, random jitter, or decorative glitch loop. Respect `prefers-reduced-motion`; replace transformations with discrete state changes.

## Do's and Don'ts

### Do

- Borrow the confidence of Nous/Hermes: committed whole-field colour, extreme contrast, thin type, sparse rhythm, strange but controlled imagery.
- Use the accelerationist sources for topology, temporal pressure, recursion, convergence, and mutation—not as an ideological mood board.
- Make hierarchy, ownership, model, state, tokens, cost, evidence, and intervention more visible than atmosphere.
- Let one composition or event dominate a screen.
- Keep inactive regions almost austere so activity has force.
- Make singularity inspectable and reversible into its inputs.
- Scale unlimited swarms through aggregation, hierarchy, and drill-down.
- Use “ad astra per aspera” as upward causal structure: constraint below, frontier above.
- Label demo state honestly.

### Don't

- Do not copy Nous artwork, marks, copy, page layouts, or exact compositions.
- Do not use retro-futurism, Y2K nostalgia, green CRT terminals, steampunk, classical ornament, or Renaissance costume.
- Do not use rainy neon streets, scanline overlays, holographic glass, chrome skulls, glowing circuit brains, or generic cyberpunk clichés.
- Do not import NRx, racial, fascist, occult, or cultic symbolism from accelerationist source material.
- Do not use a stock black hole, galaxy, astronaut, AI brain, or humanoid robot to mean “singularity.”
- Do not fall back to a sidebar plus a grid of rounded metric cards.
- Do not render every worker simultaneously.
- Do not use microscopic text to simulate complexity.
- Do not keep glitch effects permanently active.
- Do not use multiple accent colours merely to make the screen feel technical.
- Do not add a visual element whose system meaning cannot be stated in one sentence.

### Final test

If all imagery is removed, the interface must still communicate:

```text
goal → decomposition → active work → evidence → convergence → decision → next generation
```

If all data is removed, the remaining structure must still feel specifically like AOS: constrained intelligence branching, compressing, mutating, and moving toward a frontier. It must not resemble a generic analytics product, game HUD, or AI marketing page.
