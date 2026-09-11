import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const { buildGraph } = require('../../out/programflow-visualization/graph-model.js');

const src = fs.readFileSync('out/programflow-visualization/web/example-trace-content.js', 'utf8');
const window = {};
new Function('window', src)(window);
const elem = window.__PROGRAMFLOW_TRACE__.trace.at(-1);

async function run(label, heightOf, portY) {
  const viz = buildGraph(elem, new Set());
  for (const child of viz.graph.children) {
    child.width = 160;
    child.height = heightOf(viz.nodes.get(child.id));
    for (const p of child.ports ?? []) { p.x = p.id.endsWith(':in') ? 0 : 160; p.y = portY(child.height, p); }
  }
  const laidOut = await new ELK().layout(viz.graph);
  const frame = laidOut.children.find(c => c.id.startsWith('frame'));
  const minX = Math.min(...laidOut.children.map(c => c.x));
  console.log(`${label.padEnd(34)} frame.x=${String(frame.x).padStart(5)}  minX=${minX}  ${frame.x === minX ? 'OK' : '<-- FRAME NOT FIRST'}`);
}

await run('uniform h=40, portY=12', () => 40, () => 12);
await run('rows-based h, portY=12', (m) => 24 + 20 * Math.max(1, m.rows.length), () => 12);
await run('rows-based h, portY spread', (m) => 24 + 20 * Math.max(1, m.rows.length), (h, p) => p.id.endsWith(':in') ? 12 : 24 + 10);
