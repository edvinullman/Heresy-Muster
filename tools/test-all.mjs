import fs from 'node:fs'; import path from 'node:path';
import { GameData } from '../js/data.js'; import { Roster, newRosterRaw } from '../js/engine.js';
import { MANIFEST } from '../js/manifest.js';
const dir = process.argv[2]; const data = new GameData(MANIFEST);
for (const m of MANIFEST) data.addFile(JSON.parse(fs.readFileSync(path.join(dir, m.file), 'utf8')));
const gs = MANIFEST.find(m => m.type === 'gameSystem');
let problems = 0;
for (const fac of MANIFEST.filter(m => m.type === 'catalogue' && !m.library)) {
  const t0 = Date.now();
  try {
    const r = new Roster(data, newRosterRaw({ name: 'T', catalogueId: fac.id, gameSystemId: gs.id, points: 3000 }));
    r.addForce(r.root, r.childForceChoices(r.root).find(c => c.node.name.startsWith('Crusade')).node);
    let prim = r.allForces.find(x => x.node.name === 'Crusade Primary Detachment');
    const foc = r.allForces[0];
    if (!prim) { const pc = r.childForceChoices(foc).find(c => c.node.name === 'Crusade Primary Detachment'); if (pc) prim = r.addForce(foc, pc.node); }
    const target = prim || foc;
    const choices = r.rootChoices(target);
    let units = 0;
    for (const c of choices) {
      const f = r.allForces.find(x => x.uid === target.uid);
      r.addRoot(f, c.node); units++;
    }
    const v = r.validate();
    // exercise every unit's option tree and info
    let opts = 0;
    for (const s of r.allSels) { const walk = (it) => it.forEach(i => { opts++; if (i.children) walk(i.children); }); walk(r.options(s)); r.infoFor(s); }
    console.log(`${fac.name.padEnd(28)} units=${String(units).padStart(3)} sels=${String(r.allSels.length).padStart(4)} pts=${String(r.total()).padStart(6)} issues=${String(v.length).padStart(3)} broken=${r.broken.length} ${Date.now() - t0}ms`);
    if (r.broken.length) { problems++; console.log('   ', r.broken.slice(0, 3)); }
  } catch (e) { problems++; console.log(fac.name, 'CRASH', e.stack.split('\n').slice(0, 4).join(' | ')); }
}
console.log('problems', problems);
