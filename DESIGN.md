---
name: AOS Acceleration Chamber
description: A severe, operable instrument for coordinating research swarms and governing their evolution.
colors:
  cobalt: "#101CFF"
  void: "#050509"
  voidPlate: "#0B0B12"
  voidRaised: "#11111A"
  ultraviolet: "#6B45FF"
  ion: "#B8FF3D"
  vermilion: "#FF3B12"
  mineral: "#9B9AA5"
  coldWhite: "#F4F5FA"
typography:
  display:
    fontFamily: "Archivo Narrow, Archivo, system-ui, sans-serif"
    sizes: ["44px", "64px", "88px", "132px"]
    fontWeight: 600
    lineHeight: 0.94
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    sizes: ["18px", "24px", "32px"]
    fontWeight: 600
    lineHeight: 1.08
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    sizes: ["13px", "14px", "15px"]
    fontWeight: 400
    lineHeight: 1.5
  telemetry:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    sizes: ["11px", "12px", "14px"]
    fontWeight: 400
    lineHeight: 1.35
spacing:
  unit: "4px"
  topRail: "44px"
  bottomRail: "32px"
  inspector: "380px"
shapes:
  radius: "0"
  rule: "1px"
---

# AOS Acceleration Chamber

The dashboard is an instrument for steering coordinated research. It shows what the swarm is doing, why it is doing it, what constrains it, and which decisions remain with the operator. The supplied design-system ZIP is the detailed component reference. This file is the root contract for implementation work.

## Composition

The global shell has a narrow top rail, a working field, a conditional inspector, and a bottom console rail. It has no permanent sidebar. A route may use two or three regions when the task needs them, but one work field must remain dominant.

Synthesis Gate supplies the shared grammar: vertical plates, central tension, explicit evidence, and a decision strip that states consequences before action. Configuration screens use an index, one selected object, and an inspector. They do not become grids of interchangeable cards.

## Visual language

Cobalt and void own whole fields. Ultraviolet marks selection and transition. Ion marks verified or healthy state. Vermilion is reserved for conflict, irreversible consequence, or required intervention. Cold white carries primary content; mineral carries secondary telemetry.

Edges are square. Structure comes from one-pixel rules, spacing, clipping, and field changes. The interface uses no glass, shadows, gradients, rounded cards, decorative grids, or colored halos.

The open convergence aperture is the AOS signature. Diagrams must explain topology, flow, evidence, or memory boundaries. Human figures, anatomical allegory, black holes, and decorative cyberpunk imagery are excluded unless the subject itself requires them.

## Typography

Archivo Narrow or Archivo carries display text. Archivo carries interface text. IBM Plex Mono is reserved for identifiers, values, source paths, state labels, and commands. Telemetry never falls below 11 px.

The first viewport may contain one large state statement. Other headings stay on the title scale. Labels are short, uppercase, and sparse. Product copy uses present-tense instrument language: state first, consequence second, action last.

## Interaction

The dashboard labels illustrative state and live engine state explicitly. A value change shows its scope and provenance. A destructive or irreversible action explains its consequence and asks for confirmation. Built-in presets and templates are forked or versioned; they are never silently overwritten.

Desktop keeps the full work field and inspector. Tablet reduces secondary telemetry. Mobile stacks regions in reading order, turns canvases into lists, and presents the console as a full-width sheet. Keyboard focus remains visible, and reduced-motion preferences disable the aperture rotation and any route transition.

## Current system surfaces

The System Studio exposes five instruments: role presets, subagent templates, swarm blueprints, continuous memory, and settings. The UI reads the engine manifest instead of re-encoding its enumerations. Unlimited hierarchy and concurrency are displayed as unbounded, never as fabricated numbers.

The detailed source package remains at `public/techno-renaissance/design system/AOS Design System.zip`.
