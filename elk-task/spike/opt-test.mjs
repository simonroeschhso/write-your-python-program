import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const elk = new ELK();

async function probe(label, frameOpts, graphOpts) {
  const g = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', ...graphOpts },
    children: [
      { id: 'F', width: 100, height: 40, layoutOptions: frameOpts },
      { id: 'a', width: 100, height: 40 },
      { id: 'b', width: 100, height: 40 },
      { id: 'c', width: 100, height: 40 },
      { id: 'd', width: 100, height: 40 },
    ],
    edges: [
      { id: 'e1', sources: ['a'], targets: ['b'] },
      { id: 'e2', sources: ['b'], targets: ['c'] },
      { id: 'e3', sources: ['c'], targets: ['d'] },
      { id: 'e4', sources: ['F'], targets: ['d'] },
    ],
  };
  const r = await elk.layout(g);
  const xs = Object.fromEntries(r.children.map(c => [c.id, c.x]));
  console.log(label.padEnd(46), JSON.stringify(xs));
}

await probe('no constraint', undefined, {});
await probe('elk.layered.layering.layerConstraint', { 'elk.layered.layering.layerConstraint': 'FIRST' }, {});
await probe('org.eclipse.elk...layerConstraint', { 'org.eclipse.elk.layered.layering.layerConstraint': 'FIRST' }, {});
await probe('layerConstraint + spacing 60', { 'elk.layered.layering.layerConstraint': 'FIRST' }, { 'elk.layered.spacing.nodeNodeBetweenLayers': '60' });
