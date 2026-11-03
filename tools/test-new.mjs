import fs from 'node:fs'; import path from 'node:path';
import { GameData } from '../js/data.js'; import { Roster, newRosterRaw } from '../js/engine.js';
import { MANIFEST } from '../js/manifest.js';
const dir = process.argv[2]; const data = new GameData(MANIFEST);
const gs = MANIFEST.find(m => m.type === 'gameSystem'); data.addFile(JSON.parse(fs.readFileSync(path.join(dir, gs.file))));
for (const name of ['Solar Auxilia', 'XIII - Ultramarines', 'Mechanicum', 'Blackshields']) {
  const fac = MANIFEST.find(m => m.name === name); for (const m of data.filesNeeded(fac.id)) data.addFile(JSON.parse(fs.readFileSync(path.join(dir, m.file))));
  const r = new Roster(data, newRosterRaw({ name: 'T', catalogueId: fac.id, gameSystemId: gs.id, points: 3000 }));
  r.addForce(r.root, r.childForceChoices(r.root).find(c => c.node.name.startsWith('Crusade')).node);
  console.log('==', name);
  for (const f of r.allForces) console.log('  ', f.name, '->', f.sels.map(s => `${r.selState(s).name}(${s.children.length} picks)`).join(', '), '| slots:', r.slots(f).filter(s => !s.state.hidden).map(s => s.state.name).join(', '));
  console.log('   issues:', r.validate().filter(v => v.level === 'error').map(v => v.msg).join(' | '));
}
