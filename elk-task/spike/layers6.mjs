import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const { buildGraph } = require('../../out/programflow-visualization/graph-model.js');
const elk = new ELK();

function load(file) {
  const window = {};
  new Function('window', fs.readFileSync(file, 'utf8'))(window);
  return window.__PROGRAMFLOW_TRACE__.trace;
}

async function run(elem, constraint) {
  const viz = buildGraph(elem, new Set());
  for (const child of viz.graph.children) {
    child.width = 160;
    child.height = 24 + 20 * Math.max(1, viz.nodes.get(child.id).rows.length);
    for (const p of child.ports ?? []) { p.x = p.id.endsWith(':in') ? 0 : 160; p.y = 12; }
    if (child.id.startsWith('frame')) { child.layoutOptions['elk.layered.layering.layerConstraint'] = constraint; }
  }
  const t0 = Date.now();
  const r = await elk.layout(viz.graph);
  const ms = Date.now() - t0;
  const frames = r.children.filter(c => c.id.startsWith('frame'));
  const objects = r.children.filter(c => !c.id.startsWith('frame'));
  if (objects.length === 0) { return { ms, clean: true }; }
  const framesRight = Math.max(...frames.map(c => c.x + c.width));
  const objectsLeft = Math.min(...objects.map(c => c.x));
  return { ms, clean: framesRight <= objectsLeft, nodes: r.children.length };
}

for (const name of ['example', 'example-anonymous', 'example-cycles', 'example-error']) {
  const trace = load(`/tmp/trace-${name}.js`);
  for (const constraint of ['FIRST', 'FIRST_SEPARATE']) {
    let bad = 0, total = 0, maxMs = 0, maxNodes = 0;
    for (const elem of trace) {
      const r = await run(elem, constraint);
      total += r.ms; maxMs = Math.max(maxMs, r.ms); maxNodes = Math.max(maxNodes, r.nodes ?? 0);
      if (!r.clean) { bad++; }
    }
    console.log(`${name.padEnd(18)} ${constraint.padEnd(15)} steps=${String(trace.length).padStart(3)} maxNodes=${String(maxNodes).padStart(3)} totalMs=${String(total).padStart(5)} maxMs=${String(maxMs).padStart(4)} bandOverlap=${bad}`);
  }
}
