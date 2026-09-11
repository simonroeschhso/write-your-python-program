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
for (const child of viz.graph.children) {
  child.width = 160;
  child.height = 24 + 20 * Math.max(1, viz.nodes.get(child.id).rows.length);
  for (const p of child.ports ?? []) { p.x = p.id.endsWith(':in') ? 0 : 160; p.y = 12; }
}
const laidOut = await new ELK().layout(viz.graph);
const rows = laidOut.children
  .map(c => ({ id: c.id, x: c.x, kind: viz.nodes.get(c.id).kind, header: viz.nodes.get(c.id).header }))
  .sort((a, b) => a.x - b.x);
console.log(rows.map(r => `${String(r.x).padStart(6)}  ${r.kind.padEnd(14)} ${r.id}`).join('\n'));
console.log('frame options:', JSON.stringify(laidOut.children.find(c => c.id.startsWith('frame')).layoutOptions));
