// Spike for elk-plan.md §7.1. Throwaway measurement harness — not shipped.
//
// Answers the four questions the plan defers to the spike:
//   1. bundle size          (§2)
//   2. layout time          (§6.5)
//   3. step-to-step stability (§6.5)
//   4. self-loop / back-edge routing with FIXED_POS ports (§6.1)
//
// Run: node elk-task/spike/spike.mjs   (after `npm run compile`)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);
const _dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(_dirname, "../..");

const ELK = require("elkjs/lib/elk.bundled.js");
const { visibleAddresses, outgoingRefs, rootRefs, asRecord } = await import(
  path.join(root, "out/programflow-visualization/reachability.js")
);

// ---------------------------------------------------------------- fake sizes
// No DOM here, so approximate what measure.ts will do for real (§6.2).
const ROW_H = 22;
const HEADER_H = 24;
const CHAR_W = 7.5;
const PAD = 16;

const boxWidth = (lines) =>
  Math.max(90, PAD + CHAR_W * Math.max(...lines.map((l) => l.length), 0));

// ---------------------------------------------------------------- graph build
// Simplified stand-in for graph-model.ts (§6.1): flat graph, frames pinned to
// the first layer, one FIXED_POS east port per referencing row, one west input
// port per object node.

const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "25",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

function valueText(v) {
  return v.type === "ref" ? "" : String(v.value);
}

function rowsOfHeapValue(hv) {
  switch (hv.type) {
    case "dict": {
      const keys = Object.values(asRecord(hv.keys));
      const vals = Object.values(asRecord(hv.value));
      return vals.map((v, i) => ({
        label: `${valueText(keys[i]) || "*"} ${valueText(v)}`,
        ref: v.type === "ref" ? v.value : undefined,
      }));
    }
    case "instance":
      return Object.entries(asRecord(hv.value)).map(([k, v]) => ({
        label: `${k} ${valueText(v)}`,
        ref: v.type === "ref" ? v.value : undefined,
      }));
    default:
      return hv.value.map((v, i) => ({
        label: `[${i}] ${valueText(v)}`,
        ref: v.type === "ref" ? v.value : undefined,
      }));
  }
}

function headerOfHeapValue(hv) {
  return hv.type === "instance" ? hv.name : hv.type;
}

function buildGraph(elem, collapsed = new Set()) {
  const heap = asRecord(elem.heap);
  const visible = visibleAddresses(elem, collapsed);
  const children = [];
  const edges = [];
  let edgeId = 0;

  const nodeFromRows = (id, header, rows, extra) => {
    const labels = [header, ...rows.map((r) => r.label)];
    const ports = rows
      .map((r, i) => ({ row: r, i }))
      .filter(({ row }) => row.ref !== undefined)
      .map(({ i }) => ({
        id: `${id}:${i}`,
        width: 0,
        height: 0,
        x: boxWidth(labels),
        y: HEADER_H + i * ROW_H + ROW_H / 2,
        layoutOptions: { "elk.port.side": "EAST" },
      }));
    return {
      id,
      width: boxWidth(labels),
      height: HEADER_H + rows.length * ROW_H,
      ports,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        ...(extra ?? {}),
      },
    };
  };

  // Frames, in stack order, pinned to the first layer.
  elem.stack.forEach((frame, index) => {
    const rows = frame.locals.map((l) => ({
      label: `${l.name} ${valueText(l)}`,
      ref: l.type === "ref" ? l.value : undefined,
    }));
    const node = nodeFromRows(`frame:${index}`, frame.frameName, rows, {
      "elk.layered.layering.layerConstraint": "FIRST",
    });
    children.push(node);
    rows.forEach((r, i) => {
      if (r.ref !== undefined && visible.has(r.ref)) {
        edges.push({
          id: `e${edgeId++}`,
          sources: [`frame:${index}:${i}`],
          targets: [`obj:${r.ref}:in`],
        });
      }
    });
  });

  // Objects, ascending address.
  const addresses = [...visible].sort((a, b) => a - b);
  for (const address of addresses) {
    const hv = heap[address];
    if (!hv) { continue; }
    const id = `obj:${address}`;
    const isCollapsed = collapsed.has(address);
    const rows = isCollapsed
      ? [{ label: `${rowsOfHeapValue(hv).length} entries` }]
      : rowsOfHeapValue(hv);
    const node = nodeFromRows(id, headerOfHeapValue(hv), rows);
    // Dedicated west input port (§6.1).
    node.ports.unshift({
      id: `${id}:in`,
      width: 0,
      height: 0,
      x: 0,
      y: HEADER_H / 2,
      layoutOptions: { "elk.port.side": "WEST" },
    });
    children.push(node);
    if (isCollapsed) { continue; }
    rows.forEach((r, i) => {
      if (r.ref !== undefined && visible.has(r.ref)) {
        edges.push({
          id: `e${edgeId++}`,
          sources: [`${id}:${i}`],
          targets: [`obj:${r.ref}:in`],
        });
      }
    });
  }

  return { id: "root", layoutOptions: LAYOUT_OPTIONS, children, edges };
}

// ---------------------------------------------------------------- trace load
function loadExampleTrace() {
  const file = path.join(
    root,
    "src/programflow-visualization/web/example-trace-content.js"
  );
  const src = fs.readFileSync(file, "utf8");
  const sandbox = { window: {} };
  new Function("window", src)(sandbox.window);
  return sandbox.window.__PROGRAMFLOW_TRACE__.trace;
}

// ---------------------------------------------------------------- fixtures
function makeCyclicElem() {
  //   selfRef -> [selfRef]            (self-loop)
  //   left <-> right                  (two-object cycle)
  return {
    line: 1,
    filePath: "example-cycles.py",
    stack: [
      {
        frameName: "<module>",
        locals: [
          { name: "selfRef", type: "ref", value: 1 },
          { name: "left", type: "ref", value: 2 },
          { name: "right", type: "ref", value: 3 },
        ],
      },
    ],
    heap: {
      1: { type: "list", value: [{ type: "ref", value: 1 }] },
      2: { type: "instance", name: "Node", value: { other: { type: "ref", value: 3 } } },
      3: { type: "instance", name: "Node", value: { other: { type: "ref", value: 2 } } },
    },
    stdout: "",
  };
}

function syntheticElem(listCount) {
  // A frame holding N lists, each list holding 4 instances. Rough stand-in for
  // a mid-sized student program's heap.
  const heap = {};
  const locals = [];
  let addr = 1;
  for (let i = 0; i < listCount; i++) {
    const listAddr = addr++;
    const items = [];
    for (let j = 0; j < 4; j++) {
      const objAddr = addr++;
      heap[objAddr] = {
        type: "instance",
        name: "Student",
        value: { name: { type: "str", value: `s${objAddr}` }, grade: { type: "float", value: 1.5 } },
      };
      items.push({ type: "ref", value: objAddr });
    }
    heap[listAddr] = { type: "list", value: items };
    locals.push({ name: `list${i}`, type: "ref", value: listAddr });
  }
  return { line: 1, filePath: "synthetic.py", stack: [{ frameName: "<module>", locals }], heap, stdout: "" };
}

// ---------------------------------------------------------------- reporting
const flat = (g) => {
  const out = new Map();
  for (const c of g.children ?? []) { out.set(c.id, { x: c.x, y: c.y }); }
  return out;
};

function report(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

// ---------------------------------------------------------------- 1. bundle
report("1. Bundle size (§2)");
{
  const webSrc = path.join(root, "src/programflow-visualization/web");
  const base = await esbuild.build({
    entryPoints: [path.join(webSrc, "webview.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  const withElk = await esbuild.build({
    stdin: {
      contents: `import ELK from "elkjs/lib/elk.bundled.js"; console.log(new ELK());`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  const minified = await esbuild.build({
    stdin: {
      contents: `import ELK from "elkjs/lib/elk.bundled.js"; console.log(new ELK());`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  const kb = (r) => (r.outputFiles[0].contents.byteLength / 1024).toFixed(0);
  console.log(`  webview.js today            ${kb(base).padStart(6)} KiB`);
  console.log(`  elkjs alone, unminified     ${kb(withElk).padStart(6)} KiB`);
  console.log(`  elkjs alone, minified       ${kb(minified).padStart(6)} KiB`);
}

// ---------------------------------------------------------------- 2./3. trace
const elk = new ELK();
const trace = loadExampleTrace();

report("2. Layout time over the example trace (§6.5)");
const layouts = [];
const times = [];
for (const elem of trace) {
  const graph = buildGraph(elem);
  const t0 = performance.now();
  const laid = await elk.layout(structuredClone(graph));
  times.push(performance.now() - t0);
  layouts.push(laid);
}
{
  const rest = times.slice(1);
  const sorted = [...rest].sort((a, b) => a - b);
  const nodes = Math.max(...layouts.map((l) => l.children.length));
  console.log(`  steps                       ${trace.length}`);
  console.log(`  max nodes in a step         ${nodes}`);
  console.log(`  first call (JIT warm-up)    ${times[0].toFixed(1)} ms`);
  console.log(`  median after warm-up        ${sorted[sorted.length >> 1].toFixed(1)} ms`);
  console.log(`  max after warm-up           ${Math.max(...rest).toFixed(1)} ms`);
  console.log(`  budget (§6.5)               100 ms per step`);
}

report("2b. Scaling: synthetic graphs (does the budget hold for real programs?)");
{
  for (const listCount of [2, 5, 10, 20, 40]) {
    const graph = buildGraph(syntheticElem(listCount));
    const nodeCount = graph.children.length;
    const runs = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      await elk.layout(structuredClone(graph));
      runs.push(performance.now() - t0);
    }
    const best = Math.min(...runs);
    const flag = best > 100 ? "  OVER BUDGET" : "";
    console.log(
      `  ${String(nodeCount).padStart(4)} nodes, ${String(graph.edges.length).padStart(4)} edges` +
        ` -> ${best.toFixed(1).padStart(7)} ms${flag}`
    );
  }
}

report("2c. Performance knobs on a 101-node graph");
{
  const base = buildGraph(syntheticElem(20));
  const knobs = {
    "plan defaults": {},
    "thoroughness 1": { "elk.layered.thoroughness": "1" },
    "no considerModelOrder": { "elk.layered.considerModelOrder.strategy": "NONE" },
    "edgeRouting POLYLINE": { "elk.edgeRouting": "POLYLINE" },
    "crossingMin LAYER_SWEEP off": { "elk.layered.crossingMinimization.strategy": "INTERACTIVE" },
    "thoroughness 1 + no model order": {
      "elk.layered.thoroughness": "1",
      "elk.layered.considerModelOrder.strategy": "NONE",
    },
  };
  for (const [name, options] of Object.entries(knobs)) {
    const graph = { ...base, layoutOptions: { ...LAYOUT_OPTIONS, ...options } };
    const runs = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      await elk.layout(structuredClone(graph));
      runs.push(performance.now() - t0);
    }
    const best = Math.min(...runs);
    console.log(`  ${name.padEnd(32)} ${best.toFixed(1).padStart(7)} ms${best > 100 ? "  OVER BUDGET" : ""}`);
  }
}

report("3. Step-to-step stability (§6.5)");
{
  const measure = (ls) => {
    let compared = 0;
    let moved = 0;
    let worst = { d: 0, id: null, step: -1 };
    for (let i = 1; i < ls.length; i++) {
      const a = flat(ls[i - 1]);
      const b = flat(ls[i]);
      for (const [id, pa] of a) {
        const pb = b.get(id);
        if (!pb) { continue; }
        compared++;
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d > 0.5) { moved++; }
        if (d > worst.d) { worst = { d, id, step: i }; }
      }
    }
    return { compared, moved, worst };
  };

  const plain = measure(layouts);
  console.log(`  deterministic order only (current plan §6.5 step 1):`);
  console.log(`    nodes present in both     ${plain.compared}`);
  console.log(`    of those, moved           ${plain.moved}  (${((100 * plain.moved) / Math.max(1, plain.compared)).toFixed(1)} %)`);
  console.log(`    largest single jump       ${plain.worst.d.toFixed(0)} px  (${plain.worst.id} at step ${plain.worst.step})`);

  // §6.5 step 2: seed each layout with the previous step's coordinates.
  // Several INTERACTIVE combinations, because they are not equally compatible
  // with layerConstraint: FIRST (§4).
  const variants = {
    "all INTERACTIVE": {
      "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.layering.strategy": "INTERACTIVE",
      "elk.layered.nodePlacement.strategy": "INTERACTIVE",
    },
    "placement + crossings only": {
      "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
      "elk.layered.nodePlacement.strategy": "INTERACTIVE",
    },
    "crossings only": {
      "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
    },
  };

  for (const [name, options] of Object.entries(variants)) {
    const seeded = [];
    let previous = null;
    let failure = null;
    for (const elem of trace) {
      const graph = buildGraph(elem);
      graph.layoutOptions = { ...LAYOUT_OPTIONS, ...options };
      if (previous) {
        for (const c of graph.children) {
          const p = previous.get(c.id);
          if (p) { c.x = p.x; c.y = p.y; }
        }
      }
      try {
        const laid = await elk.layout(structuredClone(graph));
        seeded.push(laid);
        previous = flat(laid);
      } catch (err) {
        failure = String(err?.message ?? err).split("\n")[0].slice(0, 200);
        break;
      }
    }
    if (failure) {
      console.log(`  seeded, ${name}: FAILED`);
      console.log(`    ${failure}`);
    } else {
      const m = measure(seeded);
      console.log(
        `  seeded, ${name.padEnd(27)} moved ${String(m.moved).padStart(2)}/${m.compared}` +
          ` (${((100 * m.moved) / Math.max(1, m.compared)).toFixed(0).padStart(3)} %), worst jump ${m.worst.d.toFixed(0)} px`
      );
    }
  }
}

report("3b. Does layerConstraint FIRST survive a heap cycle? (§4)");
{
  // The failure above is about edge reversal. Default (GREEDY) cycle breaking only
  // reverses edges inside cycles, and frames can never be in a cycle because nothing
  // points at them — verify that on the cyclic graph.
  const cyclic = makeCyclicElem();
  try {
    await elk.layout(buildGraph(cyclic));
    console.log("  GREEDY cycle breaking + layerConstraint FIRST: OK");
  } catch (err) {
    console.log(`  FAILED: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
  }
}

report("3c. Stability when only VALUES change (no nodes added or removed)");
{
  // The 33 % above is contaminated: the example trace grows, and inserting a node
  // legitimately shifts its neighbours. The real question is whether a step that
  // changes nothing structural leaves the picture alone.
  const base = syntheticElem(6);
  const steps = [];
  for (let s = 0; s < 8; s++) {
    const elem = structuredClone(base);
    // Mutate one float per step; structure and addresses stay identical.
    const addresses = Object.keys(elem.heap);
    const target = elem.heap[addresses[(s * 3) % addresses.length]];
    if (target.type === "instance") { target.value.grade = { type: "float", value: 1 + s / 10 }; }
    steps.push(elem);
  }

  const laidOut = [];
  for (const elem of steps) {
    laidOut.push(await elk.layout(structuredClone(buildGraph(elem))));
  }

  const churn = (ls) => {
    let compared = 0;
    let moved = 0;
    let worst = 0;
    for (let i = 1; i < ls.length; i++) {
      const a = flat(ls[i - 1]);
      const b = flat(ls[i]);
      for (const [id, pa] of a) {
        const pb = b.get(id);
        if (!pb) { continue; }
        compared++;
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d > 0.5) { moved++; }
        worst = Math.max(worst, d);
      }
    }
    return { compared, moved, worst };
  };

  const withOrder = churn(laidOut);
  console.log(`  value-only steps, nodes compared  ${withOrder.compared}`);
  console.log(`  of those, moved                   ${withOrder.moved}  (${((100 * withOrder.moved) / Math.max(1, withOrder.compared)).toFixed(1)} %)`);
  console.log(`  largest jump                      ${withOrder.worst.toFixed(0)} px`);
  console.log(`  -> ${withOrder.moved === 0 ? "STABLE: identical structure gives identical layout" : "UNSTABLE: layout churns without structural change"}`);

  // considerModelOrder is the expensive option (§2c). Is it what buys the stability?
  const withoutOrder = [];
  for (const elem of steps) {
    const graph = buildGraph(elem);
    graph.layoutOptions = { ...LAYOUT_OPTIONS, "elk.layered.considerModelOrder.strategy": "NONE" };
    withoutOrder.push(await elk.layout(structuredClone(graph)));
  }
  const off = churn(withoutOrder);
  console.log(`  same, considerModelOrder NONE     moved ${off.moved}/${off.compared}, largest ${off.worst.toFixed(0)} px`);

  // Does dropping model order change the row/node ORDER the user sees?
  const orderOf = (l) => l.children.map((c) => c.id).join(",");
  const yOrderOf = (l) =>
    [...l.children].sort((p, q) => p.y - q.y || p.x - q.x).map((c) => c.id).join(",");
  console.log(`  visual top-to-bottom order identical with/without model order: ` +
    `${yOrderOf(laidOut[0]) === yOrderOf(withoutOrder[0])}`);
  void orderOf;
}

report("3d. Stability when ONE node is appended to a list");
{
  // The common case while stepping: a list grows by one element.
  const laidOut = [];
  for (let extra = 0; extra < 5; extra++) {
    const elem = syntheticElem(4);
    const listAddr = Number(Object.keys(elem.heap).find((a) => elem.heap[a].type === "list"));
    for (let k = 0; k < extra; k++) {
      const newAddr = 1000 + k;
      elem.heap[newAddr] = {
        type: "instance",
        name: "Student",
        value: { name: { type: "str", value: `extra${k}` }, grade: { type: "float", value: 2 } },
      };
      elem.heap[listAddr].value.push({ type: "ref", value: newAddr });
    }
    laidOut.push(await elk.layout(structuredClone(buildGraph(elem))));
  }

  let compared = 0;
  let moved = 0;
  let worst = 0;
  for (let i = 1; i < laidOut.length; i++) {
    const a = flat(laidOut[i - 1]);
    const b = flat(laidOut[i]);
    for (const [id, pa] of a) {
      const pb = b.get(id);
      if (!pb) { continue; }
      compared++;
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d > 0.5) { moved++; }
      worst = Math.max(worst, d);
    }
  }
  console.log(`  nodes surviving the append        ${compared}`);
  console.log(`  of those, moved                   ${moved}  (${((100 * moved) / Math.max(1, compared)).toFixed(1)} %)`);
  console.log(`  largest jump                      ${worst.toFixed(0)} px`);
}

// ---------------------------------------------------------------- 4. cycles
report("4. Self-loops and back-edges with FIXED_POS ports (§6.1)");
{
  // The recorded example trace has no cycles, so use the hand-built fixture.
  const laid = await elk.layout(buildGraph(makeCyclicElem()));
  const byId = new Map(laid.children.map((c) => [c.id, c]));
  console.log(`  nodes: ${laid.children.map((c) => `${c.id}@(${c.x|0},${c.y|0})`).join("  ")}`);
  for (const e of laid.edges ?? []) {
    const s = e.sections?.[0];
    if (!s) {
      console.log(`  ${e.id} ${e.sources} -> ${e.targets}: NO SECTION`);
      continue;
    }
    const bends = s.bendPoints?.length ?? 0;
    const selfLoop =
      e.sources[0].split(":").slice(0, 2).join(":") ===
      e.targets[0].split(":").slice(0, 2).join(":");
    const backwards = s.endPoint.x < s.startPoint.x;
    const span = Math.hypot(
      s.endPoint.x - s.startPoint.x,
      s.endPoint.y - s.startPoint.y
    );
    console.log(
      `  ${e.id.padEnd(4)} ${String(e.sources).padEnd(16)} -> ${String(e.targets).padEnd(12)}` +
        ` bends=${bends} span=${span.toFixed(0)}px` +
        `${selfLoop ? "  SELF-LOOP" : ""}${backwards ? "  BACK-EDGE" : ""}`
    );
  }
  // Does any edge path cross a node box it does not belong to?
  const crossings = [];
  for (const e of laid.edges ?? []) {
    const s = e.sections?.[0];
    if (!s) { continue; }
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
    const own = new Set([e.sources[0], e.targets[0]].map((p) => p.split(":").slice(0, 2).join(":")));
    for (const c of laid.children) {
      if (own.has(c.id)) { continue; }
      for (const p of pts) {
        if (p.x > c.x && p.x < c.x + c.width && p.y > c.y && p.y < c.y + c.height) {
          crossings.push(`${e.id} through ${c.id}`);
        }
      }
    }
  }
  console.log(`  bend points inside foreign node boxes: ${crossings.length ? crossings.join(", ") : "none"}`);
  void byId;
}

console.log("");
