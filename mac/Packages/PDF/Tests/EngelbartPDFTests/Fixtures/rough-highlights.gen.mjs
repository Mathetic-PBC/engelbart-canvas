import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rough = require('/Users/hudsonmitchell-pullman/engelbart-canvas/node_modules/roughjs/bundled/rough.cjs.js');
const g = rough.generator();
const cases = [[10, 20, 100, 14, 12345], [0, 0, 300.5, 9.12, 1], [87.2, 547.6, 388.35, 16.5, 2147483646], [5, 5, 3, 2, 777]];
const out = cases.map(([x, y, w, h, seed]) => {
  const d = g.rectangle(x, y + h * 0.12, w, h * 0.76, { fill: 'rgba(0,112,243,.16)', fillStyle: 'zigzag', fillWeight: 1.3, hachureGap: 2.4, hachureAngle: -4, stroke: 'none', roughness: 0.9, seed });
  return { x, y, w, h, seed, sets: d.sets.length, type: d.sets[0].type, path: g.opsToPath(d.sets[0]) };
});
console.log(JSON.stringify(out));
