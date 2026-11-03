// Run: node tools/test-engine.mjs <path-to-data-folder>
import fs from 'node:fs';
import path from 'node:path';
import { GameData } from '../js/data.js';
import { Roster, newRosterRaw } from '../js/engine.js';
import { MANIFEST } from '../js/manifest.js';
import { POINTS_ID } from '../js/config.js';

const dir = process.argv[2];
const data = new GameData(MANIFEST);
const load = (m) => data.addFile(JSON.parse(fs.readFileSync(path.join(dir, m.file), 'utf8')));
const gs = MANIFEST.find(m => m.type === 'gameSystem');
load(gs);
const um = MANIFEST.find(m => m.name.includes('Ultramarines'));
for (const m of data.filesNeeded(um.id)) load(m);

const t0 = Date.now();
const raw = newRosterRaw({ name: 'Test', catalogueId: um.id, gameSystemId: gs.id, points: 3000 });
const r = new Roster(data, raw);
console.log('top forces:', r.childForceChoices(r.root).map(c => c.node.name));
const foc = r.childForceChoices(r.root).find(c => c.node.name.startsWith('Crusade'));
let f = r.addForce(r.root, foc.node);
console.log('after FOC, forces:', r.allForces.map(x => x.name));
console.log('FOC slots:', r.slots(f).map(s => `${s.state.name}${s.state.hidden ? '(hidden)' : ''}`));
console.log('FOC root choices:', r.rootChoices(f).map(c => c.node.name));
console.log('FOC child detachments:', r.childForceChoices(f).map(c => c.node.name));
console.log('validate:', r.validate().map(v => v.level + ': ' + v.msg).slice(0, 15));

// Pick allegiance
const alleg = r.rootChoices(f).find(c => c.node.name === 'Allegiance');
if (alleg) {
  r.addRoot(f, alleg.node);
  const s = r.allSels.find(x => x.node.name === 'Allegiance');
  const opts = r.options(s);
  const show = (items, d = 0) => items.forEach(i => { console.log(' '.repeat(d * 2) + `${i.kind} ${i.state.name} hidden=${i.state.hidden} count=${i.count}`); if (i.children) show(i.children, d + 1); });
  show(opts);
}
f = r.allForces.find(x => x.node.name.startsWith('Crusade'));
console.log('child detachments now:', r.childForceChoices(f).map(c => c.node.name));
let prim = r.allForces.find(x => x.node.name === 'Crusade Primary Detachment');
if (!prim) {
  const pc = r.childForceChoices(f).find(c => c.node.name === 'Crusade Primary Detachment');
  if (pc) prim = r.addForce(f, pc.node);
}
if (prim) {
  const choices = r.rootChoices(prim);
  const byCat = {};
  for (const c of choices) (byCat[data.categoryName(c.categoryId)] ||= []).push(c.node.name);
  for (const [k, v] of Object.entries(byCat)) console.log(`  [${k}] ${v.length}: ${v.slice(0, 6).join(', ')}`);
  const tac = choices.find(c => c.node.name === 'Tactical Squad');
  r.addRoot(prim, tac.node);
  const ts = r.allSels.find(x => x.node.name === 'Tactical Squad');
  const dump = (s, d = 0) => { console.log(' '.repeat(d * 2) + `${s.number}x ${r.selState(s).name} = ${r.selTotal(s, POINTS_ID)}`); s.children.forEach(c => dump(c, d + 1)); };
  dump(ts);
  console.log('unit options:');
  const show = (items, d = 1) => items.forEach(i => { if (i.state.hidden) return; const l = r.limitsOf(i.state); console.log(' '.repeat(d * 2) + `${i.kind} ${i.state.name} ${l.min}-${l.max} n=${i.count} pts=${i.state.costs.get(POINTS_ID) ?? ''}`); if (i.children && d < 3) show(i.children, d + 1); });
  show(r.options(ts));
  const leg = ts.children.find(c => c.node.type === 'model' && c.number > 1) || ts.children.find(c => c.node.type === 'model');
  if (leg) { console.log('model options for', leg.node.name); show(r.options(leg)); }
  const info = r.infoFor(ts);
  console.log('rules:', info.rules.map(x => x.view.name));
  console.log('profiles:', info.profiles.map(x => x.view.name));
  const lg = ts.children.find(c => c.node.type === 'model');
  console.log('model profiles:', r.infoFor(lg).profiles.map(p => p.view.name + ' ' + p.view.chars.map(c => c.name + '=' + c.value).join(' ')));
}
console.log('TOTAL', r.total());
console.log('validate:', r.validate().map(v => v.level + ': ' + v.msg));
console.log('ms', Date.now() - t0);
fs.writeFileSync('/tmp/claude-0/-home-claude/5011640b-6406-592f-bcfe-35870935dbb8/scratchpad/roster.json', JSON.stringify(raw, null, 1));
