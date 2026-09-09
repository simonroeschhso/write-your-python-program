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
- **Bundling.** `localResourceRoots` contains only `out/programflow-visualization/web`, so
  elkjs must be bundled *into* `webview.js` by esbuild (`scripts/build-web.mjs`), not
  loaded as a separate asset. `elk.bundled.js` is plain JS and bundles fine; elkjs ships
  its own type declarations, so no `@types/*` package.
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
| list / tuple | **horizontal** strip of boxes, index above value | **vertical** text lines `[0] 3.3` | keep current |
| set | wrapping row of value boxes, no index | not modelled | keep current |
| dict | vertical `key` \| `value` pairs, key width from longest key | not modelled | keep current |
| instance | headline = class name, then `key` \| `value` pairs | labels `name = 'Tim'` | keep current |
| Edge labels | none — index/key lives inside the source box | `"students"`, `"0"`, … on the edge | keep current (no labels) |
| Edge colors | per-address hue via `getColor()` | none | **replaced**, see §6.4 |
| Pointed-to objects | `.object-intendation`, flat 65px left margin | real layout | ELK replaces the hack |
| Collapsed summary | not supported | `"list" / "12 elements"` | the new feature, mocked |

So: **take layout from `example.elkt`, keep content rendering as it is today.** Where the
two disagree, the current extension wins; edge coloring (§6.4) is the one deliberate
exception. That keeps the visible change to "same boxes, better placement, real arrows",
which is much easier to review than a simultaneous restyle.

Two further things `example.elkt` gets wrong for runtime use: it hardcodes every label size
(`layout [ size: 90, 16 ]` — real sizes must be measured, §6.2), and it models rows as
child nodes, which lets `layered` reorder them (§5.2).

## 4. Layout shape: flat graph, headers computed after layout

No outer `frames` / `objects` container nodes:

- The current UI has no box around either column — the headings and dividers are chrome in
  `index.html`, outside the content. Containers would add visual weight that isn't there.
- Instead pin frame nodes to the leftmost layer with
  `elk.layered.layering.layerConstraint: FIRST`. Every heap object is then strictly right
  of every frame — same split, but ELK can compact the rest freely.
- No hierarchy means no cross-hierarchy edges, so `hierarchyHandling: INCLUDE_CHILDREN`
  and the lowest-common-ancestor bookkeeping that `example.elkt` needs both disappear.
- `layerConstraint: FIRST` only admits nodes without incoming edges. After the collapse
  filter (§6.3) every rendered object is reachable from a frame, i.e. has at least one
  incoming edge, so no object can slip into the frames layer. The split stays well-defined.

**The `Frames` / `Objects` headers stay above their areas**, recomputed from the layout
instead of fixed percentages:

- `framesRight = max(x + width)` over frame nodes, `objectsLeft = min(x)` over object nodes.
- Two absolutely positioned header divs at `y = 0` in the canvas, spanning `[0, framesRight]`
  and `[objectsLeft, canvasWidth]`, reusing the existing `.title` + `.divider` markup. All
  node `y` values shift down by the header height.
- Matches today's behaviour: the headers live inside `#viz`, the scroll container, so they
  scroll with the content rather than sticking.
- Fallback if the computed split looks unstable between steps: switch the model builder to
  the two container nodes (rendered borderless) and read the extents from their geometry.
  Keep that switchable.

## 5. Graph modelling decisions

### 5.1 One node per frame / object, content rendered by us

ELK only places boxes and routes edges; the inside of every box is our HTML, exactly as
rendered today.

### 5.2 Rows are **ports**, not child nodes

`example.elkt` models each variable/field as a child node, which makes `layered` run a
layout inside every frame and is free to reorder rows. Instead, each referencing row
becomes an ELK **port** on its node:

- `elk.portConstraints: FIXED_POS` with explicit port `x`/`y` (row index × measured row
  height) → row order always matches source order, boxes stay compact, no wasted layout.
- Ports get zero width/height; edges reference them directly in `sources` / `targets`,
  which puts each arrow's origin on the exact row holding the reference — what linkerline
  only approximates today.
- Fallback if ports prove awkward: child nodes plus
  `elk.layered.considerModelOrder.strategy: NODES_AND_EDGES` to force ordering.

## 6. Implementation

```
BackendTraceElem
   │
   ├─ graph-model.ts     buildGraph(elem, collapsed) -> ElkNode  (no sizes yet)
   ├─ measure.ts         fill width/height/port offsets from real text metrics
   ├─ elk layout         elk.layout(graph)   (elk.bundled.js, main thread)
   └─ graph-renderer.ts  absolutely-positioned divs + one SVG edge overlay
```

New files under `src/programflow-visualization/web/`: `graph-model.ts`, `measure.ts`,
`graph-renderer.ts`. Removed at the end: `html-generator.ts`, the `linkerline` dependency,
and the `stackHTML` / `heapHTML` fields of `FrontendTraceElem`.

### 6.1 Graph model (`graph-model.ts`)

`buildGraph(elem: BackendTraceElem, collapsed: Set<Address>): ElkNode`

- Flat graph: root → one node per `StackElem` + one node per heap address.
- Frame nodes get `layerConstraint: FIRST` and a port per `local` with `type === 'ref'`.
- Object nodes: content per `HeapValue.type` (`list` | `tuple` | `set` | `dict` |
  `instance`), a port per `ref` element/field. A collapsed node has no ports.
- Reference edges are plain `ElkExtendedEdge`s on the root.
- Stable ids — `frame:<index>`, `frame:<index>:<varName>`, `obj:<address>`,
  `obj:<address>:<slot>` — so collapse and hover state survive a re-render.
- Every node carries a `data.kind` tag (`frame`, `current-frame`, `list`, `tuple`, `set`,
  `dict`, `instance`, `collapsed`) that the renderer turns into CSS classes.
  **No colors or fonts in TS.**
- Layout options, from `example.elkt`: `algorithm: layered`, `direction: RIGHT`,
  `spacing.nodeNode`, `layered.spacing.nodeNodeBetweenLayers`, plus `edgeRouting: ORTHOGONAL`.

### 6.2 Measurement (`measure.ts`)

Before layout, walk the graph and set `width`/`height` on every node and `x`/`y` on every
port — ELK needs sizes up front, unlike flexbox which measures during render, and content
changes every trace step. Text width via a cached `CanvasRenderingContext2D.measureText`
using the font resolved from the webview's computed style, so it matches VS Code's editor
font. Row height comes from a single CSS custom property, so CSS and layout can't drift.

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
node, and passed into `buildGraph` on every render. No auto-collapse. The filter runs
**before** layout:

1. Roots = all `ref` values in all stack frames.
2. Traverse the reference graph, **but do not traverse edges leaving a collapsed node**.
   The collapsed node still renders, as a closed box with a one-line summary
   (`list, 12 elements`, `dict, 3 entries`, `Student, 2 fields`), just without its
   outgoing edges.
3. Drop every heap object not reached, and every edge touching a dropped object.

This gives the requested semantics exactly: a node disappears only if it is *exclusively*
downstream of the collapsed node; anything reachable by another path stays.

Accepted caveat: collapse state is keyed by heap address and CPython reuses addresses after
GC, so a collapse can "jump" to an unrelated object many steps later. Cheap mitigation if
it becomes annoying — drop an address from the set when the object at that address changes
`type`.

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
apart. It also has two bugs: `* 100` instead of `* 360` squeezes all hues into a red→green
sliver, and `addr / 10` on small addresses moves the hue by ~10 per object, so neighbouring
objects look identical. Encoding the heap address is meaningless to a learner anyway, and
ELK's orthogonal routing separates edges by construction. Therefore:

- All edges in one neutral theme color (`var(--vscode-editor-foreground)`, reduced opacity).
- Disambiguation on interaction: hovering a variable row or object node adds
  `.elk-edge-active` to its incoming/outgoing edges and `.elk-dimmed` to the rest. Scales
  to dense heaps, theme-friendly, works for color-blind users.
- The renderer only sets `data-source` / `data-target` and toggles classes, so going back
  to per-address hues (or coloring by edge kind) is a CSS change plus one attribute.

## 7. Rollout order

Each step keeps the extension working.

1. **Spike.** Add `elkjs`; build a graph from `example-trace-content.js` and render it in
   browser dev mode (`npm run watch:web`, `out/programflow-visualization/web/index.web.html`).
   Check bundle size and layout time on the largest example step.
2. **Model + measure + render** behind a flag; `html-generator.ts` stays as fallback.
3. **Switch** `webview.ts` (`updateVisualization` / `updateRefArrows` / `updateIndent`) to
   the new pipeline once output looks right.
4. **Collapsing**: click handling + reachability filter.
5. **Styling pass**: theme variables, per-kind classes, neutral edges + hover highlighting.
6. **Cleanup**: delete `html-generator.ts`, drop `linkerline`, trim `FrontendTraceElem`,
   update `src/programflow-visualization/README.md` (its diagram still shows
   `html-generator.ts` → `innerHTML`).

## 8. Decisions at a glance

| Decision | Where |
| --- | --- |
| Content rendering stays as today; current extension wins over `example.elkt` | §3 |
| Flat graph, frames pinned to first layer, no outer containers | §4 |
| `Frames` / `Objects` headers stay, positioned from layout extents | §4 |
| Rows modelled as fixed-position ports | §5.2 |
| No per-frame line number in frame headers | §2 |
| Collapse persists across steps; address-reuse caveat accepted | §6.3 |
| Collapsible types: `list`, `tuple`, `set`, `dict`, `instance` | §6.3 |
| No auto-collapse for long lists | §6.3 |
| Neutral edges + hover highlighting instead of per-address hues | §6.4 |
| Sync `elk.bundled.js`, no Web Worker (CSP) | §2 |

Nothing blocking is open. Revisit only if the spike shows the computed header extents
jittering between steps → fall back to the borderless-container variant (§4).
