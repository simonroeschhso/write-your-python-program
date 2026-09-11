import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const { buildGraph } = require('../../out/programflow-visualization/graph-model.js');

const src = fs.readFileSync('out/programflow-visualization/web/example-trace-content.js', 'utf8');
const window = {};
new Function('window', src)(window);
const elem = window.__PROGRAMFLOW_TRACE__.trace.at(-1);
const elk = new ELK();

async function run(label, mutate) {
  const viz = buildGraph(elem, new Set());
  for (const child of viz.graph.children) {
    child.width = 160;
    child.height = 24 + 20 * Math.max(1, viz.nodes.get(child.id).rows.length);
    for (const p of child.ports ?? []) { p.x = p.id.endsWith(':in') ? 0 : 160; p.y = 12; }
  }
  mutate?.(viz);
  const r = await elk.layout(viz.graph);
  const frame = r.children.find(c => c.id.startsWith('frame'));
  const minX = Math.min(...r.children.map(c => c.x));
  console.log(label.padEnd(40), `frame.x=${String(frame.x).padStart(5)} minX=${String(minX).padStart(5)} ${frame.x === minX ? 'OK' : '<-- NOT FIRST'}`);
}

await run('as built', undefined);
await run('without ports', (viz) => {
  const owner = new Map();
  for (const c of viz.graph.children) { for (const p of c.ports ?? []) { owner.set(p.id, c.id); } delete c.ports; delete c.layoutOptions['elk.portConstraints']; }
  for (const e of viz.graph.edges) { e.sources = [owner.get(e.sources[0])]; e.targets = [owner.get(e.targets[0])]; }
});
await run('ports, portConstraints FREE', (viz) => {
  for (const c of viz.graph.children) { c.layoutOptions['elk.portConstraints'] = 'FREE'; }
});
await run('ports, FIXED_ORDER', (viz) => {
  for (const c of viz.graph.children) { c.layoutOptions['elk.portConstraints'] = 'FIXED_ORDER'; }
});
await run('FIXED_POS + explicit port side', (viz) => {
  for (const c of viz.graph.children) {
    for (const p of c.ports ?? []) { p.layoutOptions = { 'elk.port.side': p.id.endsWith(':in') ? 'WEST' : 'EAST' }; }
  }
});
