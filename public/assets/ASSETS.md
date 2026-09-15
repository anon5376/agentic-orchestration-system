# Black Atlas asset provenance

These assets are presentation-only visual material for the Black Atlas React/Vite prototype. They are illustrative specimens and diagrams; they do not depict real AOS providers, research evidence, people, or clinical material. Raster specimens were generated with the built-in image-generation workflow, inspected locally, and copied into this directory. No page screenshot is used as a background.

## Palette and constraints

The authored diagrams and the image prompts use the exact visual contract palette: `#070605` near-black, `#F2F1EC` chalk white, `#FF3B12` vermilion, `#A7A39B` gray, and `#1A1714` surface. Vermilion is reserved for active paths, tension, changed rules, or selected nodes. Capabilities contains only sockets, junctions, routes, and patch-bay structures; it contains no human body or operator. Evolution baseline and candidate are separate specimens and contain no syringe, needle, incision, scalpel, wound, or gore. Memory uses a layered sliced-head construction.

## Canonical raster map

| Canonical path | Source / role | Notes |
| --- | --- | --- |
| `specimens/missions-neural.png` | `specimens/missions/nerve-interface-fragment-v1.png` | Neural interface fragment, right-weighted porous shell |
| `specimens/missions-memory.png` | `specimens/missions/memory-substrate-fragment-v1.png` | Layered memory substrate fragment |
| `specimens/missions-emergent.png` | `specimens/missions/planetary-lattice-fragment-v1.png` | Abstract porous cognition lattice |
| `specimens/intake-cranial.png` | `specimens/intake/cranial-nerve-profile-v1.png` | Right-facing faceless cranial/nerve profile |
| `specimens/swarm-root.png` | `specimens/swarm/root-branch-organism-v1.png` | Root sphere with five cascading branches |
| `specimens/evidence-coupling.png` | `specimens/evidence/faceless-coupled-section-v1.png` | Faceless coupled split section |
| `specimens/synthesis-dual.png` | `specimens/synthesis/split-dual-head-organism-v1.png` | Opposed dual-head tension specimen |
| `specimens/synthesis-cell.png` | `specimens/synthesis/cell-mesh-detail-v1.png` | Cell and node support detail |
| `specimens/synthesis-mesh.png` | `specimens/synthesis/cell-mesh-detail-v1.png` | Intentional mesh-detail derivative/alias |
| `specimens/evolution-baseline.png` | `specimens/evolution/baseline-head-v1.png` | Stable baseline faceless head |
| `specimens/evolution-candidate.png` | `specimens/evolution/candidate-head-v1.png` | Rerouted candidate faceless head |
| `specimens/memory-layers.png` | `specimens/memory/layered-sliced-head-v1.png` | Layered sliced memory head |

The generated masters are retained in the Codex generated-image store. The three mission, intake, swarm, evidence, synthesis, evolution, and memory `*-v1.png` files are readable asset-level copies; canonical top-level files are deliberate stable names for page agents.

Generation master paths (all under `/Users/anon5376/.codex/generated_images/01a095bb-4c06-78e1-a4cb-9e0b120eb681/`):

```text
missions-neural       exec-cdf733c1-ddff-41b8-a046-cdea6626efd4.png
missions-memory       exec-f2ee8dbe-504d-45e7-87a4-ada0a03843e6.png
missions-emergent     exec-413b7b37-739c-4d96-b2d9-80cae7655297.png
intake-cranial        exec-667d8eee-e713-4925-a571-e9ef40c0ba2d.png
swarm-root            exec-2e8ed651-f1bc-4756-bc47-a412de9f2201.png
evidence-coupling     exec-9de7a124-8a27-4221-b324-74c44fca6ad2.png
synthesis-dual        exec-40864687-df3d-41b2-9aeb-ef60f4f0c503.png
synthesis-cell/mesh   exec-518cb49b-704a-44ff-a31f-4aa427685ca2.png
evolution-baseline    exec-0bbe3666-eb2d-4c95-ae88-8a2042e8b640.png
evolution-candidate   exec-307bb2b6-b5ac-43a1-8475-04e072577a58.png
memory-layers         exec-64e6d2e1-064b-4468-bb42-cc5e5314b6f4.png
```

## Raster generation prompts

The following are the exact prompts supplied to the built-in image-generation workflow. Every prompt was paired with the built-in `stylized-concept` use case and a no-text/no-logo/no-watermark constraint.

### `missions-neural.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen fragment for a dark research dashboard
Primary request: an abstract bio-synthetic neural interface fragment, shaped like a partial cranial hemisphere with a dense branching nerve lattice attached along one edge. It should feel like a scientific specimen plate, not a human portrait.
Scene/backdrop: pure near-black background, isolated subject with ample negative space and clipped edges acceptable
Subject: porous neural membrane, delicate filaments, branching fibers, dotted matter, one side of a curved hemisphere
Style/medium: monochrome chalk-and-phosphor scientific illustration, high-contrast pointillist etching, tactile grain, archival specimen microscopy
Composition/framing: close crop, subject weighted to the right with branching fibers extending left, transparent-looking black field, usable as a clipped UI plate
Lighting/mood: stark white-on-black, subtle vermilion only in a few active fibers or junctions
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accent only
Materials/textures: stippled dots, etched contour lines, fine wire-like neural branches, controlled paper grain
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no complete body, no recognizable full human face, no UI frame, no medical gore
Avoid: colorful gradients, photorealistic skin, syringe, needle, operator, person, corporate imagery, Nous, Hermes, decorative neon
```

### `missions-memory.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen fragment for the Black Atlas missions page
Primary request: a partial faceless synthetic head fragment made of layered porous memory substrate, like a machine-organic cranial shell with nested cavities and thin branching filaments. This is a specimen crop, not a portrait.
Scene/backdrop: pure near-black background, isolated subject, strong edge falloff and crop-ready negative space
Subject: side-facing cranial shell fragment, porous honeycomb lattice, layered internal channels, scattered signal traces
Style/medium: monochrome chalk-on-black scientific plate, pointillist etching, fine archival grain, high contrast
Composition/framing: close crop with the shell on the left and empty black space on the right; asymmetrical and clipped at one edge for a dashboard row
Lighting/mood: stark white and cool gray; a few tiny vermilion signal marks only at active junctions
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accent only
Materials/textures: stipple, etched contour, fibrous membranes, microscopic porous voids
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no complete human body, no realistic person, no UI, no syringe, no needle
Avoid: color gradients, glossy 3D, neon glow, operator, recognizable face identity, Nous, Hermes, medical gore
```

### `missions-emergent.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen fragment for the Black Atlas missions page
Primary request: a planetary-scale porous cognition specimen, an irregular spherical shell made from cavernous cellular lattice and mineral-like membranes, with a small halo of detached nodes and filaments. It must be an abstract object, not a planet or human.
Scene/backdrop: pure near-black background, isolated spherical fragment with edge clipping
Subject: rough porous sphere, open cellular voids, nested cavities, sparse branching threads and particles
Style/medium: monochrome chalk-on-black scientific illustration, pointillist etching, microscopy plate, distressed grain
Composition/framing: sphere weighted left or center-left, generous black negative space on the right, crop-ready for a mission row
Lighting/mood: high-contrast chalk white and gray with only a few vermilion active channels
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accents only
Materials/textures: porous chalk, fine dots, filament seams, dry-brush edges, sparse registration flecks
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no complete person, no face, no operator, no syringe, no needle
Avoid: colorful space scene, stars, blue/green, glossy sphere, UI frame, decorative neon, Nous, Hermes
```

### `intake-cranial.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Goal Intake interpretation plate
Primary request: a side-profile cranial nerve specimen, an abstract faceless head silhouette built from fine luminous chalk dots and branching nerve fibers. The profile should face right and read as a diagrammatic neural interface specimen, with the head fading into a sparse root-like network.
Scene/backdrop: pure near-black background, isolated subject with large negative space and clean crop edges
Subject: right-facing faceless cranial profile, no eyes or facial features, dense nerve fibers crossing the skull and extending downward like a root system
Style/medium: monochrome chalk-on-black scientific etching, pointillist MRI-like plate, archival grain and fine linework
Composition/framing: large profile occupying the right half, fibers trailing down and left, leave some empty black margin for surrounding UI annotations
Lighting/mood: stark chalk white and gray; sparse vermilion threads at the synthetic-interface boundary only
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion controlled accents
Materials/textures: halftone dots, fine branching filaments, clipped contour, dust-like specimen particles
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no operator, no full body, no skin realism, no eye, no mouth, no syringe, no needle
Avoid: human portrait identity, colorful background, gradient, glow bloom, UI frame, Nous, Hermes
```

### `swarm-root.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Live Swarm hierarchy canvas
Primary request: a monumental root-and-branch organism: one dark spherical root node at the top center, with many branching neural filaments cascading downward into five distinct sub-branches and small glowing node beads. It is a non-human abstract system organism, like an intelligence tree.
Scene/backdrop: pure near-black background, wide composition, isolated network with transparent-looking negative space
Subject: central root sphere, branching nervous-system roots, clusters of small circular nodes, sparse dust and connection points
Style/medium: monochrome chalk-on-black scientific plate, delicate etched filaments, pointillist microscopy, distressed grain
Composition/framing: very wide landscape, root node near upper center, branches fan out and descend to lower edge; leave clear black margins around the organism
Lighting/mood: white and gray structure; active path traces and selected nodes in controlled vermilion, not a general glow
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accents only
Materials/textures: chalk threads, root hairline fibers, dotted nodes, broken lines, subtle registration flecks
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no humans, no faces, no operator, no syringe, no needle, no UI panels
Avoid: colorful graph, generic neon network, sci-fi circuit board, symmetric corporate icon, Nous, Hermes
```

### `evidence-coupling.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Evidence Atlas right-side coupling section
Primary request: a faceless split cranial specimen in profile, built from two coupled halves: a chalk-dotted organic head silhouette on one side and a horizontally sliced, data-ghosted section on the other. Thin nerve fibers cross the split boundary and reconnect, with a few active vermilion traces.
Scene/backdrop: pure near-black background, tall portrait composition, isolated and crop-ready
Subject: non-identifiable faceless head/cranial silhouette, two coupled sections, visible porous tissue and horizontal scanline/data texture, branching neural paths bridging the sections
Style/medium: monochrome chalk-on-black scientific etching, stippled neuroanatomy abstraction, archival microscopy grain
Composition/framing: vertical head fragment weighted to the right, with split boundary near center; generous black negative space on left
Lighting/mood: stark chalk white and gray; controlled vermilion only on the coupling paths and small conflict points
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accents only
Materials/textures: stipple, etched contours, clipped horizontal data bars, sparse dust, brittle scanline interruptions
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no recognizable person, no eyes, no mouth, no operator, no syringe, no needle
Avoid: colorful cyberpunk, generic neon head, glossy skin, UI frame, Nous, Hermes
```

### `synthesis-dual.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Synthesis Gate central tension panel
Primary request: a split dual-head organism: two faceless cranial profiles facing each other in close opposition, one formed from a chalk neural lattice and one from a porous data-memory shell. The profiles nearly touch at a narrow central gap filled with sparse vermilion tension fibers. No human portrait identity.
Scene/backdrop: pure near-black background, isolated pair, vertical composition suitable for a center-right panel
Subject: two faceless side profiles, left and right, layered chalk tissue, branching nerves, porous mesh, separated by a thin unresolved seam
Style/medium: monumental monochrome scientific plate, chalk pointillism, etched contours, archival microscopy grain
Composition/framing: paired heads centered with mirrored tension and clipped lower edges; enough black negative space around the pair for UI labels
Lighting/mood: white and cool gray forms; vermilion concentrated only along central gap and a few connecting fibers
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion only at conflict/tension points
Materials/textures: dotted cranial shells, fine nerve filaments, translucent mesh, interrupted scanline dust
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no operator, no body, no syringe, no needle
Avoid: color gradients, glossy skin, generic neon, smiling faces, distinct human identity, UI frame, Nous, Hermes
```

### `synthesis-cell.png` and `synthesis-mesh.png`

```text
Use case: stylized-concept
Asset type: isolated raster detail for a Synthesis Gate evidence support cell
Primary request: a small field of interconnected biological-style cells and nodes, viewed close-up like a microscopy fragment. Irregular circles and filaments form a dense mesh with one narrow vermilion connection path.
Scene/backdrop: pure near-black background, isolated crop with transparent-looking negative space
Subject: porous cell clusters, branching filaments, small circular junctions, an evidence-like network motif rather than a body
Style/medium: monochrome chalk-on-black microscopy etching, pointillist plate, high contrast grain
Composition/framing: square crop, dense structure toward lower-left with open black negative space toward upper-right
Lighting/mood: chalk white and cool gray; one or two thin vermilion active junctions only
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accents only
Materials/textures: stippled membrane, etched cell walls, delicate filaments, archival specimen dust
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no humans, no faces, no operator, no syringe, no needle
Avoid: colorful biological diagram, glossy 3D, generic neon, UI frame, Nous, Hermes
```

### `evolution-baseline.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Black Atlas Evolution baseline panel
Primary request: a baseline faceless cranial organism, a single side-facing head profile built from dense chalk dots, porous neural tissue, and calm branching filaments. It must read as a stable pre-change reference specimen, not a portrait.
Scene/backdrop: pure near-black background, isolated subject with generous negative space and clean crop edges
Subject: one right-facing faceless cranial profile, no eyes or mouth, layered mesh and root-like nerve branches, subtle baseline markers in the tissue
Style/medium: monumental monochrome chalk-on-black scientific etching, pointillist microscopy, archival grain, high-contrast specimen plate
Composition/framing: portrait crop, head centered and weighted slightly right, lower filaments fading into black; usable as a clipped UI panel
Lighting/mood: white and cool gray structure with only tiny vermilion calibration dots, no active mutation color wash
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion at a few baseline markers only
Materials/textures: stippled cortical shell, fine etched contours, dry filament fibers, sparse particulate dust
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no human identity, no operator, no syringe, no needle, no incision, no scalpel, no wound, no UI frame
Avoid: colorful gradients, glossy skin, neon glow, medical gore, cut flesh, cyberpunk circuit board, Nous, Hermes
```

### `evolution-candidate.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Black Atlas Evolution candidate panel
Primary request: a candidate faceless cranial organism, a single side-facing head profile derived from a baseline neural specimen but visibly reconfigured: porous shell sections shifted, branching nerve paths rerouted, several nodes relocated, and a thin active vermilion line marking functional rule changes. This is a mutation-state specimen, not a portrait.
Scene/backdrop: pure near-black background, isolated subject with generous negative space and clean crop edges
Subject: one right-facing faceless cranial profile, no eyes or mouth, altered mesh topology, rerouted fibers, displaced node clusters, subtle discontinuities that imply version change
Style/medium: monumental monochrome chalk-on-black scientific etching, pointillist microscopy, archival grain, high-contrast specimen plate
Composition/framing: portrait crop, head centered and weighted slightly right, filaments fading into black; usable as a clipped UI panel
Lighting/mood: white and cool gray structure; controlled vermilion only on a narrow mutation trace and changed nodes, no generic glow
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion only for changed paths
Materials/textures: stippled cortical shell, fine etched contours, broken fiber joins, sparse particulate dust, small branch offsets
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no human identity, no operator, no syringe, no needle, no incision, no scalpel, no wound, no medical gore, no UI frame
Avoid: colorful gradients, glossy skin, neon bloom, surgical imagery, generic circuit board, person, Nous, Hermes
```

### `memory-layers.png`

```text
Use case: stylized-concept
Asset type: isolated raster specimen for the Black Atlas Memory & Policies page
Primary request: a layered sliced-head illustration: one faceless side-facing cranial specimen built from several offset horizontal and diagonal slices, each layer showing porous memory substrate, nested cavities, and thin nerve filaments. The slices are clean scientific sections, not wounds or gore.
Scene/backdrop: pure near-black background, isolated tall specimen with strong negative space and clipped edges
Subject: faceless cranial profile, three to five separated layers or strata, porous shell, internal channels, repeated contour echoes, small red policy signal marks at a few junctions
Style/medium: monochrome chalk-on-black archival scientific plate, pointillist etching, high contrast, tactile grain
Composition/framing: portrait crop, layered head centered slightly right with visible slice gaps and dangling filaments; crop-ready for a dashboard panel
Lighting/mood: white and cool gray layers; controlled vermilion only in tiny signal points, no broad glow
Color palette: #070605 black, #F2F1EC chalk white, #A7A39B gray, #FF3B12 vermilion accents only
Materials/textures: stippled bone-like membrane, fine etched cross-sections, fibrous channels, dust-like specimen particles, paper grain
Text (verbatim): none
Constraints: no text, no letters, no numbers, no logos, no watermark, no recognizable human identity, no operator, no body, no syringe, no needle, no incision, no blood, no gore, no scalpel, no UI frame
Avoid: medical gore, surgical cut, glossy skin, colorful gradients, neon cyberpunk, realistic person, Nous, Hermes
```

## Code-native diagrams

- `diagrams/capability-topology.svg` is authored directly in SVG. It is a functional routing field with 16 sockets, patch-bay junctions, passive routes, one active vermilion path, capacity markers, and no human imagery.
- `diagrams/mutation-seam.svg` is authored directly in SVG. It compares baseline/candidate rule lanes, joins changed traces through a central vermilion seam, includes an execution trace, metric delta markers, and a visible rollback checkpoint.

## Self-hosted fonts

The font binaries are copied from the existing local, licensed webfont set at `/Users/anon5376/Projects/Novel Biotech/output/modular-interface-program-20260912-r1/website/source/public/fonts`:

- `fonts/aos-display.woff2` is Archivo Variable (Google Fonts v25; width axis supports condensed display use).
- `fonts/aos-sans.woff2` is the same Archivo Variable binary for body/UI use.
- `fonts/aos-mono.woff2` is IBM Plex Mono Regular.
- `fonts/Archivo-OFL.txt` and `fonts/IBM-Plex-Mono-OFL.txt` retain the applicable SIL Open Font License 1.1 text.

Binary SHA-256: Archivo `4c98b9d490d1698ec95f2ff17a6c7d0e72691864c0c5d7bc2a2c161b45afe5ad`; IBM Plex Mono Regular `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350`.
