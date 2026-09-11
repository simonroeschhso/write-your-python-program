import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const elk = new ELK();

async function probe(label, extraEdges, constraint = 'FIRST') {
  const g = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
    children: ['F', 'a', 'b', 'c', 'd', 'p', 'q'].map(id => ({
      id, width: 100, height: 40,
      layoutOptions: id === 'F' ? { 'elk.layered.layering.layerConstraint': constraint } : undefined,
    })),
    edges: [
      { id: 'e1', sources: ['a'], targets: ['b'] },
      { id: 'e2', sources: ['b'], targets: ['c'] },
      { id: 'e3', sources: ['c'], targets: ['d'] },
      { id: 'e4', sources: ['F'], targets: ['d'] },
      ...extraEdges,
    ],
  };
  const r = await elk.layout(g);
  const xs = Object.fromEntries(r.children.map(c => [c.id, c.x]));
  const minX = Math.min(...r.children.map(c => c.x));
  console.log(label.padEnd(38), `F=${String(xs.F).padStart(4)} minX=${String(minX).padStart(4)} ${xs.F === minX ? 'OK' : '<-- NOT FIRST'}`, JSON.stringify(xs));
}

await probe('acyclic', []);
await probe('+ self loop on p', [{ id: 'c1', sources: ['p'], targets: ['p'] }]);
await probe('+ two-node cycle p<->q', [{ id: 'c1', sources: ['p'], targets: ['q'] }, { id: 'c2', sources: ['q'], targets: ['p'] }]);
await probe('+ two-node cycle, FIRST_SEPARATE', [{ id: 'c1', sources: ['p'], targets: ['q'] }, { id: 'c2', sources: ['q'], targets: ['p'] }], 'FIRST_SEPARATE');
await probe('+ cycle reachable from F', [
  { id: 'c1', sources: ['F'], targets: ['p'] },
  { id: 'c2', sources: ['p'], targets: ['q'] },
  { id: 'c3', sources: ['q'], targets: ['p'] },
]);
