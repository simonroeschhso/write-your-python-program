import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const { buildGraph } = require('../../out/programflow-visualization/graph-model.js');

const src = fs.readFileSync('out/programflow-visualization/web/example-trace-content.js', 'utf8');
const window = {};
new Function('window', src)(window);
const trace = window.__PROGRAMFLOW_TRACE__.trace;
const elem = trace[trace.length - 1];

const viz = buildGraph(elem, new Set());
const portOwner = new Map();
for (const child of viz.graph.children) {
  child.width = 160;
  child.height = 40;
  for (const p of child.ports ?? []) { p.x = p.id.endsWith(':in') ? 0 : 160; p.y = 12; portOwner.set(p.id, child.id); }
}
const laidOut = await new ELK().layout(viz.graph);
const x = new Map(laidOut.children.map(c => [c.id, c.x]));
const label = (id) => `${viz.nodes.get(id).kind}/${viz.nodes.get(id).header}@${x.get(id)}`;
const leftmost = laidOut.children.filter(c => c.x < 400).map(c => c.id);
console.log('--- edges touching nodes left of the frame ---');
for (const e of viz.graph.edges) {
  const s = portOwner.get(e.sources[0]), t = portOwner.get(e.targets[0]);
  if (leftmost.includes(s) || leftmost.includes(t)) { console.log(`${label(s)}  ->  ${label(t)}`); }
}
