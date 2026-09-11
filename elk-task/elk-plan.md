# ELK-based visualization: plan

Replace the current CSS-flexbox + linkerline rendering of the programflow visualization
with a real graph model laid out by [elkjs](https://github.com/kieler/elkjs), add
collapsible heap nodes, and make the whole thing themable from CSS.

`example.elkt` in the repo root is the hand-written target shape (prototype for
<https://rtsys.informatik.uni-kiel.de/elklive/elkgraph.html>). It is a *specification*,
not a runtime artifact: elkjs consumes a JSON graph, not the `.elkt` text notation.

---

## 1. Where we are today

| Concern | Current implementation |
| --- | --- |
| Model | none — `html-generator.ts` builds two raw HTML strings (`stackHTML`, `heapHTML`) |
| Layout | CSS flex, two floated columns (`.floating-left` = frames 35%, `.floating-right` = objects 65%) |
| Edges | `linkerline`, drawn *after* render by measuring DOM elements found via `id="…Pointer<addr>"` / `id="heapEndPointer<addr>"` regex-scraped out of the HTML strings |
| Styling | hardcoded colors in `webview.css` (`.box`, `.frame`, `.current-frame`, …) |
| Collapsing | not supported |

Blast radius is small: `FrontendTraceElem` / `HTMLGenerator` are referenced **only** by
`web/webview.ts` and `web/html-generator.ts`. The extension host
(`frontend/visualization_panel.ts`) only ships `BackendTraceElem`s, so nothing on the
VS Code side changes.

## 2. Constraints found while checking the code

- **`heap` is not a `Map`.** `types.ts` declares `heap: Map<Address, HeapValue>`, but after
  IPC/JSON it is a plain object — today's code works around this with `Object.keys(...)`.
  Same for `HeapValue.value` / `.keys` on `dict` and `instance`. Use `Object.entries`.
- **CSP blocks Web Workers.** `web/index.html` has `default-src 'none'` and no
  `worker-src`, so `worker-src` falls back to `none`. → Use the synchronous bundled build
  `elkjs/lib/elk.bundled.js` (main thread, no worker). Revisit the worker build only if
  layout is too slow; that would also need `worker-src blob:;` in the CSP.
- **Bundling.** `elk.bundled.js` is plain JS and bundles fine into `webview.js` via esbuild
  (`scripts/build-web.mjs`); elkjs ships its own type declarations, so no `@types/*`
  package. This is a *choice, not a constraint*: `script-src` includes `{{CSP_SOURCE}}` and
  `copyStatic()` in `build-web.mjs` already copies assets into `localResourceRoots`, so if
  elkjs's size hurts webview startup (measure in §7.1) shipping it as a separate
  `<script src>` is an available fallback.
- **`StackElem` has no line number**, so `example.elkt`'s `"createGradeList (line 36)"` is
  not derivable — only `BackendTraceElem.line` (the currently executing line) exists.
  Decided: no per-frame line, frame headers show the name only.
- **Pre-existing bug.** `html-generator.frameItem` marks `index === 0` as `current-frame`,
  but `stack[0]` is `<module>`, the *outermost* frame (the example trace confirms
  `[<module>, generate_bar]`). The current frame is the **last** element. Fix while porting.
- **`linkerline` becomes dead** once edges come from ELK bend points → drop the dependency.

## 3. `example.elkt` vs. the current layout

Structurally faithful, visually different. Node *content* is rendered by us as HTML and
only *placement* comes from ELK (§5), so most differences are free choices.

| Aspect | Current extension | `example.elkt` | Decision |
| --- | --- | --- | --- |
| Overall split | Frames left, Objects right, fixed % columns | `frames` / `objects` containers, `direction: RIGHT` | same idea, see §4 |
| Column grouping | **no box** — `Frames`/`Objects` titles + `.divider` chrome in `index.html` | visible group boxes with labels | keep current (§4) |
| Frame box | `border-left` 4px, grey / blue for the current frame | plain container node | keep current |
| Frame header | `<module>` shown as `Global` | `<module>`, plus `(line 36)` | keep current, no line |
| Variable row | two columns `name` \| `value`, value empty when it's a ref | single label `"tim"` | keep current |
| list / tuple | **horizontal** strip of boxes, index above value | **vertical** text lines `[0] 3.3` | **changed to vertical**, see §5.2 |
| set | wrapping row of value boxes, no index | not modelled | **changed to vertical**, see §5.2 |
| dict | vertical `key` \| `value` pairs, key width from longest key | not modelled | keep current |
| instance | headline = class name, then `key` \| `value` pairs | labels `name = 'Tim'` | keep current |
| Edge labels | none — index/key lives inside the source box | `"students"`, `"0"`, … on the edge | keep current (no labels) |
| Edge colors | per-address hue via `getColor()` | none | **replaced**, see §6.4 |
| Pointed-to objects | `.object-intendation`, flat 65px left margin | real layout | ELK replaces the hack |
| Collapsed summary | not supported | `"list" / "12 elements"` | the new feature, mocked |

So: **take layout from `example.elkt`, keep content rendering as it is today.** Where the
two disagree the current extension wins, with two deliberate exceptions: edge coloring
(§6.4) and list/tuple/set orientation (§5.2, forced by per-cell arrow origins). The visible
change stays close to "same boxes, better placement, real arrows" — far easier to review
than a simultaneous restyle.

`example.elkt` is also wrong twice for runtime use: it hardcodes every label size
(`layout [ size: 90, 16 ]`; real sizes must be measured, §6.2) and it models rows as child
nodes, which lets `layered` reorder them (§5.2).

## 4. Layout shape: flat graph, headers computed after layout

No outer `frames` / `objects` container nodes. The current UI has no box around either
column — the headings and dividers are chrome in `index.html`, outside the content — so
containers would add visual weight that isn't there. Instead pin frame nodes to the leftmost
layer with `elk.layered.layering.layerConstraint: FIRST`: every heap object is then strictly
right of every frame, while ELK compacts the rest freely. Flat also means no
cross-hierarchy edges, so `hierarchyHandling: INCLUDE_CHILDREN` and the lowest-common-
ancestor bookkeeping `example.elkt` needs both disappear. Frames never have incoming edges,
so the constraint is unproblematic for them; and layered guarantees a node sits in a
strictly later layer than any predecessor, so since after the collapse filter (§6.3) every
rendered object has at least one incoming edge, no object can land in layer 0 beside the
frames. The split stays well-defined without containers.

**The `Frames` / `Objects` headers stay above their areas**, recomputed from the layout
instead of fixed percentages: `framesRight = max(x + width)` over frame nodes,
`objectsLeft = min(x)` over object nodes, then two absolutely positioned header divs at
`y = 0` spanning `[0, framesRight]` and `[objectsLeft, canvasWidth]`, reusing the existing
`.title` + `.divider` markup, with all node `y` values shifted down by the header height.
As today they live inside `#viz`, the scroll container, so they scroll with the content
rather than sticking.

Fallback if the computed split looks unstable between steps: switch the model builder to
two container nodes (rendered borderless) and read the extents from their geometry. Keep
that switchable.

## 5. Graph modelling: one node per frame/object, rows as ports

### 5.1 Rows are ports, not child nodes

ELK only places boxes and routes edges; the inside of every box is our HTML, exactly as
rendered today.

`example.elkt` models each variable/field as a **child node**, which makes `layered` run a
layout inside every frame and leaves it free to reorder rows. `veryRoughMockupOfExample.png`
shows the damage: the module frame comes out as `karl2, tim, karl, joerg, tom, gerd, …`
instead of source order. Instead, each referencing row becomes an ELK **port** on its node:

- `elk.portConstraints: FIXED_POS` with explicit port `x`/`y` (row index × measured row
  height) → row order always matches source order, boxes stay compact, no wasted layout.
- Ports get zero width/height; edges reference them directly in `sources` / `targets`, so
  each arrow's origin sits on the exact row holding the reference — what linkerline only
  approximates today.
- Fallback if ports prove awkward: child nodes plus
  `elk.layered.considerModelOrder.strategy: NODES_AND_EDGES` to force ordering.

### 5.2 Consequence: `list` / `tuple` / `set` become vertical

Per-cell arrow origins require one port per cell at that cell's own `y` on the node's
**east** edge. In a horizontal strip all cells share one row, so their ports would land on
the *south* edge and, with `direction: RIGHT`, layered would route every one of them down
and back around — exactly the spaghetti we're removing. Rendering cells vertically (index
in a left column, value in a right column) puts each port on the east edge at its own `y`.
Side effects, all good: one row shape for all five heap types, so the existing
dict/instance `key | value` rendering is reused everywhere with the index playing the role
of the key; long lists become narrow and tall instead of extremely wide, matching the
mockup; and the collapsed one-line summary (§6.3) fits the same box shape.

This is the one content-rendering change versus today — forced by the per-cell arrow
origins requirement, not a free restyle.

## 6. Implementation

```
BackendTraceElem
   │
   ├─ reachability.ts    visibleAddresses / outgoingRefs / rootRefs   (exists already)
   ├─ graph-model.ts     buildGraph(elem, collapsed) -> ElkNode  (no sizes yet)
   ├─ measure.ts         fill width/height/port offsets from real text metrics
   ├─ elk layout         elk.layout(graph)   (elk.bundled.js, main thread)
   └─ graph-renderer.ts  absolutely-positioned divs + one SVG edge overlay

   node-view.ts          renderNode(node) -> HTMLElement
                         the single source of node markup, called by BOTH measure.ts and
                         graph-renderer.ts
```

`node-view.ts` exists because §6.2 sizes a node by rendering its real markup offscreen and
§6.3 then renders that markup again for real. If the two ever build markup independently
they will drift, and every box in the visualization is silently mis-sized. One function,
two call sites, no exceptions.

New files under `src/programflow-visualization/web/`: `graph-model.ts`, `node-view.ts`,
`measure.ts`, `graph-renderer.ts`. Removed at the end: `html-generator.ts`, the `linkerline`
dependency, and the `stackHTML` / `heapHTML` fields of `FrontendTraceElem`.

`src/programflow-visualization/reachability.ts` already exists and is **production code, not
a test helper**: it is the heap traversal §6.1 and §6.3 are built on. It lives one level
above `web/` on purpose — `tsconfig.json` excludes `web/**`, so a copy there would be
bundled by esbuild but never type-checked by `tsc` and not importable from the tests. Where
it is, it is type-checked, unit-tested (§7.7) and still reachable from the bundle: esbuild
resolves `../reachability` exactly as `web/html-generator.ts` already resolves `../types`.

| Export | Use in the implementation |
| --- | --- |
| `visibleAddresses(elem, collapsed)` | which object boxes `buildGraph` emits (§6.3) |
| `outgoingRefs(heapValue)` | which edges to emit, and their per-cell origins (§5.2) |
| `rootRefs(elem)` | the frame-variable → object edges |
| `asRecord(mapLike)` | the `Map`-typed-but-plain-object workaround (§2), needed throughout the renderer |

### 6.1 Graph model (`graph-model.ts`)

`buildGraph(elem: BackendTraceElem, collapsed: Set<Address>): ElkNode`

- Flat graph built from `visibleAddresses(elem, collapsed)`: root → one node per
  `StackElem` + one node per visible address, one edge per `outgoingRefs` pair whose ends
  are both visible, plus the `rootRefs` edges. **Import these from `reachability.ts`; do
  not re-walk the heap inline** — a second traversal would drift from the tested one, and
  the collapse semantics are the subtle part.
- Frame nodes get `layerConstraint: FIRST` and a port per `local` with `type === 'ref'`.
- Object nodes: content per `HeapValue.type` (`list` | `tuple` | `set` | `dict` |
  `instance`), a port per `ref` element/field. A collapsed node has no ports.
- Reference edges are plain `ElkExtendedEdge`s on the root. The **source** is the port of
  the referencing row; the **target** is an explicit zero-size input port at the centre of
  the object node's *west* edge — not the node itself. Under `portConstraints: FIXED_POS` a
  portless endpoint leaves ELK to pick a border point that can move between steps, whereas
  a declared input port makes every arrowhead land in the same place every time.
- Stable ids — `frame:<index>`, `frame:<index>:<varName>`, `obj:<address>`,
  `obj:<address>:<slot>` — so collapse and hover state survive a re-render.
- Every node carries a `data.kind` tag (`frame`, `current-frame`, `list`, `tuple`, `set`,
  `dict`, `instance`, `collapsed`) that the renderer turns into CSS classes.
  **No colors or fonts in TS.**
- Layout options, from `example.elkt`: `algorithm: layered`, `direction: RIGHT`,
  `spacing.nodeNode`, `layered.spacing.nodeNodeBetweenLayers`, plus `edgeRouting: ORTHOGONAL`,
  and `layered.considerModelOrder.strategy: NODES_AND_EDGES` for stability (§6.5).
- Nodes are emitted in a deterministic order — frames by stack index, objects by ascending
  address — so that model order is meaningful and identical across steps (§6.5).

**Self-loops and back-edges are the weak spot of fixed-position ports.** `example-cycles.py`
produces both: a self-referencing list is an ELK self-loop, and a two-object cycle is a
back-edge under `direction: RIGHT`. With zero-size ports pinned to the east edge, layered's
default routing for these may be unreadable. Settle it in the spike (§7.1) rather than at
the end. Fallbacks, cheapest first: let a back-edge attach to the target's east side
instead of the declared west input port, so it does not cross the whole node; for the
self-loops, the `elk.layered.edgeRouting.selfLoop*` options (check the exact names against
the installed elkjs version); and, failing both, route cycle edges by hand in the SVG
overlay, since §6.3 already owns path construction.

### 6.2 Measurement (`measure.ts`)

ELK needs sizes up front, unlike flexbox which measures during render, and content changes
every trace step. So before layout, walk the graph and set `width`/`height` on every node
and `x`/`y` on every port.

Measure by **rendering the real node HTML into one hidden offscreen container** and reading
`offsetWidth` / `offsetHeight` / row offsets in a single batched pass (write all nodes, then
read all sizes — one reflow). Not `canvas.measureText`: the boxes use CSS ellipsis, 50%/50%
`name`/`value` widths and a dict-key width derived from the longest key, and reimplementing
those rules in canvas math would silently drift from the stylesheet. Reading the browser's
own layout is simpler and exact, and it keeps §6.4's promise that all sizing lives in CSS.
Port offsets come from the measured row positions in the same pass, so ports land exactly on
the rows the user sees.

### 6.3 Rendering (`graph-renderer.ts`) and collapsing

Rendering:

- One positioned container `#viz-canvas`; each ELK node becomes an absolutely positioned
  `<div>` at its computed `x`/`y`/`width`/`height`, classed from `data.kind`, with the row
  markup inside.
- Edges: a single `<svg>` overlay, one `<path>` per edge built from its ELK `sections`
  (start point, bend points, end point) plus an arrowhead `<marker>`. This fully replaces
  linkerline — no post-hoc DOM measurement, no regex id scraping.
- Headers placed from the layout extents (§4); node `y` shifted by the header height.
- ELK coordinates are parent-relative → accumulate parent offsets when flattening. A no-op
  for the flat graph, but keep it so the container fallback of §4 works.

Collapsing — state is `collapsed: Set<Address>` in `webview.ts`, **persisted across trace
steps**, toggled by clicking the header of any `list`, `tuple`, `set`, `dict` or `instance`
node, passed into `buildGraph` on every render, no auto-collapse. The filter runs **before**
layout and is already implemented as `visibleAddresses` in `reachability.ts`: traverse from
all `ref` values in all stack frames, but **do not traverse edges leaving a collapsed
node**; then drop every heap object not reached and every edge touching a dropped object.
The collapsed node itself still renders, as a closed box with a one-line summary
(`list, 12 elements`, `dict, 3 entries`, `Student, 2 fields`), just without outgoing edges.
That is the requested semantics exactly: a node disappears only if it is *exclusively*
downstream of the collapsed one; anything reachable by another path stays.

Accepted caveat: collapse state is keyed by heap address and CPython reuses addresses after
GC, so a collapse can "jump" to an unrelated object many steps later. Cheap mitigation if
it becomes annoying — drop an address from the set when the object at that address changes
`type`.

Affordance: nothing in the box tells a learner it can be folded, so every collapsible
header carries a caret (`▾` expanded, `▸` collapsed) and is a real control —
`role="button"`, `tabindex="0"`, Enter/Space toggles — so the feature is discoverable and
usable without a mouse.

### 6.4 Styling

- Class-per-kind in `webview.css`: `.elk-node`, `.elk-frame`, `.elk-current-frame`,
  `.elk-list`, `.elk-tuple`, `.elk-set`, `.elk-dict`, `.elk-instance`, `.elk-row`,
  `.elk-collapsed`, `.elk-edge`.
- Colors from VS Code theme variables (`var(--vscode-editor-foreground)`,
  `var(--vscode-panel-border)`, `var(--vscode-charts-*)`) instead of today's hardcoded
  `rgba(56, 56, 56, 0.8)`, so the visualization follows light/dark/high-contrast themes.

**Edge coloring: neutral + hover highlight**, replacing `getColor()`. The current formula
`((0.618033988749895 + addr / 10) % 1) * 100` → `hsl(h, 60%, 45%)` exists only because
linkerline draws unrouted, overlapping arrows and color was the only way to tell them
apart. It also has two bugs — `* 100` instead of `* 360` squeezes all hues into a red→green
sliver, and `addr / 10` moves the hue by only ~10 per object on small addresses, so
neighbours look identical. Encoding the heap address is meaningless to a learner anyway,
and ELK's orthogonal routing separates edges by construction. Therefore: all edges in one
neutral theme color (`var(--vscode-editor-foreground)`, reduced opacity), and disambiguation
on interaction — hovering a variable row or object node adds `.elk-edge-active` to its
incoming/outgoing edges and `.elk-dimmed` to the rest. That scales to dense heaps, is
theme-friendly and works for color-blind users. The renderer only sets `data-source` /
`data-target` and toggles classes, so going back to per-address hues (or coloring by edge
kind) is a CSS change plus one attribute.

### 6.5 Stability across steps, performance, pan/zoom

**Stability is the biggest UX risk of the whole change.** Layout is recomputed per trace
step, and ELK is free to place objects anywhere, so step *n* → *n+1* can reshuffle the
entire heap side and destroy the user's mental map. Today's flexbox at least keeps heap
insertion order. Mitigations, in order of cost:

1. Deterministic input: emit nodes sorted by stack index / heap address (§6.1) and enable
   `layered.considerModelOrder.strategy: NODES_AND_EDGES`. Identical input then gives
   identical output, and a step that only changes one value doesn't reshuffle anything.
2. If that isn't enough, seed ELK with the previous step's coordinates
   (`elk.interactiveLayout: true` plus `interactiveReferencePoint`), so layout drifts from
   the last picture instead of starting fresh.

Verify in the spike (§7.1) by stepping through `example.py` and watching for jumps.

**Performance.** Layout runs on every navigation click, and the slider fires continuously
while dragging.

- Cache the layout result per `(traceIndex, collapsed-set)` key, LRU-bounded; stepping back
  and forth then costs nothing. Drop the whole cache whenever measurement premises change —
  a theme switch or an editor font-size change alters text metrics, so every cached layout
  becomes wrong. The existing `onDidChangeViewState` → `reset` path is the place to hook it.
- Re-layout on the slider's `change` event, not `input`, so dragging doesn't queue dozens
  of layouts. Keep the line-highlight message on `input` as it is today.
- Budget: if a step exceeds ~100 ms on the largest example, revisit (worker build, or
  `layered.thoroughness` turned down).

**Pan and zoom.** Doable, and probably necessary — `current.png` already exceeds the panel
height and ELK output will be wider. No library needed:

- Everything already lives in one absolutely positioned `#viz-canvas` whose exact bounds
  ELK reports, so a single `transform: translate(px, py) scale(s)` on that element pans and
  zooms the node `<div>`s and the SVG edge overlay together, with no re-layout and no
  coordinate recomputation. It is GPU-composited, so it stays smooth.
- Wheel (or ctrl+wheel) zooms around the cursor, drag pans, plus a "fit" button that solves
  `s = min(viewportW / graphW, viewportH / graphH)` from the ELK bounds — the one thing
  that is easy here and impossible today, because today nothing knows the graph's size.
- Keep the step controls and stdout pane outside the transformed element so they never
  scale. The `Frames` / `Objects` headers (§4) sit inside the canvas and scale with it; if
  they should stay pinned, render them outside the transform and multiply their extents
  by `s`.
- Only real caveat: text can look slightly soft at fractional zoom levels. Snapping to
  sensible zoom steps avoids it.

### 6.6 Three things that will bite during implementation

- **`elk.layout()` is async, navigation is not.** Clicking "next" five times fast starts
  five layouts, and they can resolve out of order and paint a stale graph. Guard with a
  monotonic render token: capture it before awaiting, drop the result if it is no longer
  the current one. The same guard covers the streaming `append` path.
- **Measuring while the panel is hidden yields zeros.** The offscreen container of §6.2
  must use `visibility: hidden` / off-screen positioning, never `display: none`, and
  rendering should be skipped while the webview is not visible and redone on the existing
  `onDidChangeViewState` → `reset` path.
- **Fonts load after first paint.** Measuring before the webview font is ready produces
  sizes that are wrong by a few pixels and a layout that never gets corrected. Await
  `document.fonts.ready` before the first measurement pass.

## 7. Rollout order

Each step keeps the extension working.

1. **Spike.** Add `elkjs`; build a graph from `example-trace-content.js` and render it in
   browser dev mode (`npm run watch:web`, `out/programflow-visualization/web/index.web.html`).
   Answer the four open questions here, not later: bundle size and layout time (§2, §6.5),
   step-to-step stability (§6.5), and self-loop / back-edge routing with fixed-position
   ports (§6.1) — the last one needs a hand-built cycle graph, since the recorded example
   trace has none.
2. **Model + node-view + measure + render** behind a flag; `html-generator.ts` stays as
   fallback. `node-view.ts` comes first: `measure.ts` cannot be written without it.
3. **Switch** `webview.ts` (`updateVisualization` / `updateRefArrows` / `updateIndent`) to
   the new pipeline once output looks right.
4. **Collapsing**: click handling + reachability filter (`visibleAddresses` already exists).
5. **Pan/zoom + layout caching** (§6.5).
6. **Styling pass**: theme variables, per-kind classes, neutral edges + hover highlighting.
7. **Unit tests** in `src/test/unit` for the pure logic — no webview, no ELK run.
   *Done for the collapse filter*: `src/programflow-visualization/reachability.ts` plus
   `src/test/unit/reachability.test.ts` (22 cases), run by `npm run test:unit`, which is
   now part of `npm test`. Still to add once it exists: `buildGraph` structure tests.
8. **Cleanup**: delete `html-generator.ts`, drop `linkerline`, trim `FrontendTraceElem`,
   update `src/programflow-visualization/README.md` (its diagram still shows
   `html-generator.ts` → `innerHTML`).

## 8. Decisions at a glance

| Decision | Where |
| --- | --- |
| Content rendering stays as today, except the two exceptions below | §3 |
| Per-cell arrow origins kept → `list`/`tuple`/`set` become vertical rows | §5.2 |
| Rows modelled as fixed-position ports on the east edge | §5.1 |
| Edge source = row port, target = declared west input port | §6.1 |
| Node markup lives in one `node-view.ts`, shared by measure and render | §6 |
| Flat graph, frames pinned to first layer, no outer containers | §4 |
| `Frames` / `Objects` headers stay, positioned from layout extents | §4 |
| No per-frame line number in frame headers | §2 |
| Collapse persists across steps; address-reuse caveat accepted | §6.3 |
| Collapsible types: `list`, `tuple`, `set`, `dict`, `instance` | §6.3 |
| Collapsible headers show a caret and toggle by keyboard too | §6.3 |
| No auto-collapse for long lists | §6.3 |
| Neutral edges + hover highlighting instead of per-address hues | §6.4 |
| Sizes measured from real DOM offscreen, not canvas text math | §6.2 |
| Deterministic node order + model order for step-to-step stability | §6.5 |
| Layout cached per step; slider re-lays out on `change`, not `input` | §6.5 |
| Pan/zoom via one CSS transform on the canvas, plus zoom-to-fit | §6.5 |
| Sync `elk.bundled.js`, no Web Worker (CSP) | §2 |
| elkjs bundled into `webview.js`; separate-asset fallback stays available | §2 |

Three risks to watch in the spike, all with a prepared fallback: step-to-step layout
stability (§6.5 → interactive layout seeding), header-extent jitter (§4 → borderless
containers), and self-loop / back-edge routing under fixed-position ports (§6.1 → east-side
attachment, self-loop options, or hand-routed paths).

## 9. Definition of done

### 9.1 Test programs

Four programs in `elk-task/`. `example.py` is the main case but **cannot demonstrate
collapsing on its own**: every `Student` is bound to a module-level global (`tim`, `karl`,
…), so it stays reachable from a stack root whatever you collapse — collapsing `aud`'s
student list hides edges but removes no nodes. Hence the other three.

- **`example.py`** — shared objects (`lara`, `quentin`, `jonas`, `fabio`, `hector`, `gerd`
  are in *both* subject lists), a nested frame (`createGradeList`), a growing list, and a
  `return` value. Exercises frames, instances, lists and per-cell arrow origins.
- **`example-anonymous.py`** — `data = [[1, 2], [3, 4]]`, a list of unnamed `Student`s, and
  one named object inside a container for contrast. The only way to verify that collapsing
  actually *removes* exclusively-downstream nodes.
- **`example-cycles.py`** — a self-referencing list, a two-object cycle, dicts with
  reference values and with tuple (reference) keys, a set and a tuple. Covers the types
  `example.py` never produces and proves the traversal terminates.
- **`example-error.py`** — ends in an `IndexError`, so the `traceback` path and a partial
  trace still render.

### 9.2 Functional criteria

1. Steps through all of the above forward and backward, via buttons, slider drag, first and
   last, with **no console errors and no unhandled promise rejections** — including fast
   repeated clicks (the async-layout race of §6.6).
2. **With nothing collapsed**, every `ref` in a step is drawn as exactly one arrow: edge
   count equals ref count, each arrow starts on the row holding the reference and ends at
   the referenced object. Assert the counts programmatically rather than eyeballing. (The
   invariant is stated for the uncollapsed case on purpose — collapsing deliberately
   removes edges, so with a non-empty `collapsed` set the count drops to the refs among
   visible objects.)
3. `example-cycles.py` renders readably: self-loops and back-edges are followable rather
   than crossing their own or neighbouring boxes (§6.1).
4. Collapse behaves per §6.3: collapsing `aud`'s list keeps `lara` (still referenced by
   `prog1`'s list); collapsing a list of anonymous objects removes them; re-expanding
   restores the previous picture; the state survives stepping away and back. Collapsible
   headers show their caret and toggle by keyboard as well as by click.
5. Stepping *n* → *n+1* leaves unrelated nodes in place (§6.5).
6. Pan, wheel-zoom and zoom-to-fit work; step controls and stdout pane do not scale.
7. Readable in light, dark and high-contrast themes, with no hardcoded colors left in the
   new code.
8. No regression in the non-visual behaviour: editor line highlighting, stdout, traceback
   display and trace caching all still work.

### 9.3 Hygiene criteria

9. `npm test` clean — compile, lint and the unit tests of §7.7.
10. Layout stays inside the §6.5 budget on the largest step of `example.py`, and a long
    trace does not grow memory without bound (layout cache is LRU-bounded).
11. `html-generator.ts` deleted, `linkerline` removed from `package.json`,
    `FrontendTraceElem` trimmed, and `src/programflow-visualization/README.md` updated.

"Runs through `example.py` without errors" is criterion 1 of 11 — it proves the pipeline
works, not that the feature does.
