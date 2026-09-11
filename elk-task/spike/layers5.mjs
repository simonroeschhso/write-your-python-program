import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const { buildGraph } = require('../../out/programflow-visualization/graph-model.js');
const elk = new ELK();

function load(file) {
  const src = fs.readFileSync(file, 'utf8');
  const window = {};
  new Function('window', src)(window);
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
  const framesRight = Math.max(...frames.map(c => c.x + c.width));
  const objectsLeft = Math.min(...objects.map(c => c.x));
  return { constraint, ms, framesX: frames.map(c => c.x), objectsLeft, framesRight, clean: framesRight <= objectsLeft };
}

const trace = load('out/programflow-visualization/web/example-trace-content.js');
for (const constraint of ['FIRST', 'FIRST_SEPARATE']) {
  const bad = [];
  let total = 0;
  for (let i = 0; i < trace.length; i++) {
    const r = await run(trace[i], constraint);
    total += r.ms;
    if (!r.clean) { bad.push(`step ${i}: framesRight=${r.framesRight} objectsLeft=${r.objectsLeft}`); }
  }
  console.log(`${constraint.padEnd(15)} steps=${trace.length} totalMs=${total} overlapping=${bad.length}`);
  bad.slice(0, 3).forEach(b => console.log('   ', b));
}
