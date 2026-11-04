// Builds the content of a printed army sheet from a roster: one entry per unit with
// plain-English model lines, the weapons used, and every rule that could be explained.
// Output formats: InDesign Tagged Text (for the layout) and JSON (for scripts).

import { POINTS_ID } from './config.js';
import { ruleKey, splitRules } from './rule-names.js';

// ---------- wording ----------
const NO_PLURAL = /(armour|armor|auxilia|vexilla|s|equipment|gear|ammunition|plating|glands)$/i;
export function plural(name) {
  const n = String(name);
  if (NO_PLURAL.test(n)) return n;
  if (/man$/i.test(n)) return n.slice(0, -3) + 'men';
  if (/[^aeiou]y$/i.test(n)) return n.slice(0, -1) + 'ies';
  if (/(x|ch|sh)$/i.test(n)) return n + 'es';
  return n + 's';
}
// "a, b and c"
function joinAnd(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
const clean = (s) => String(s).replace(/\s*\(default\)\s*$/i, '').trim();

// ---------- collecting ----------
// Gear every model of this kind must take (its own min = max, e.g. frag grenades).
function mandatory(roster, c) {
  if (c.children.length) return false;
  const lim = roster.limitsOf(roster.candState(c.node, c.parent, c.groupNodes));
  return lim.min >= 1 && lim.max === lim.min && c.number === lim.min && !c.groupNodes.length;
}

function leaves(roster, sel) {
  // Names of the actual picks under a selection; containers are replaced by their contents.
  const out = [];
  for (const c of sel.children) {
    if (c.node.type === 'model' || mandatory(roster, c)) continue;
    if (c.children.length) out.push(...leaves(roster, c));
    else out.push({ name: clean(roster.selState(c).name), n: c.number });
  }
  return out;
}

function wearList(items, many) {
  return items.map(l => (l.n > 1 ? `${l.n} ${plural(l.name)}` : many ? plural(l.name) : l.name));
}

function modelLine(roster, unit, m) {
  const name = clean(roster.selState(m).name);
  const lim = roster.limitsOf(roster.candState(m.node, m.parent, m.groupNodes));
  const siblings = unit.children.filter(x => x.node.key === m.node.key).length;
  const showNum = m.number > 1 || siblings > 1 || lim.max !== 1;
  const kit = wearList(leaves(roster, m), m.number > 1);
  return `${showNum ? m.number + ' ' : ''}${m.number > 1 ? plural(name) : name}${kit.length ? ' with ' + joinAnd(kit) : ''}`;
}

function unitLines(roster, unit) {
  const lines = [];
  const models = unit.children.filter(c => c.node.type === 'model');
  if (unit.node.type === 'model' || !models.length) {
    // The unit is itself the model (characters, vehicles without model entries).
    const kit = wearList(leaves(roster, unit), false);
    lines.push(`${clean(roster.selState(unit).name)}${kit.length ? ' with ' + joinAnd(kit) : ''}`);
    return lines;
  }
  for (const m of models) lines.push(modelLine(roster, unit, m));
  // Unit-wide picks, skipping gear every unit of this kind must take.
  for (const c of unit.children) {
    if (c.node.type === 'model') continue;
    if (mandatory(roster, c)) continue;
    const name = clean(roster.selState(c).name);
    const inner = leaves(roster, c).map(l => l.name);
    lines.push(inner.length ? `${name}: ${joinAnd(inner)}` : name);
  }
  return lines;
}

function allSels(sel) { return [sel, ...sel.children.flatMap(allSels)]; }

const isMelee = (view) => view.chars.some(c => /^(IM|AM|SM)$/.test(c.name));
const charText = (view, re) => view.chars.find(c => re.test(c.name))?.value || '';

// Everything the sheet needs. resolveRule(label) fetches a rule's text if needed.
export async function collectSheet(roster, data, resolveRule) {
  const isConfig = (s) => s.force.parent.kind === 'roster' && s.force.forces.length > 0;
  const units = [], config = [];
  const weapons = new Map();
  const cands = new Map(); // key -> { key, name, text, from:Set }

  const addCand = (key, name, text, from) => {
    if (!text) return;
    if (!cands.has(key)) cands.set(key, { key, name, text, from: new Set() });
    if (from) cands.get(key).from.add(from);
  };
  const ruleLabels = []; // [label, from] from weapon columns, resolved after

  const walkForce = (f) => {
    for (const s of f.sels) {
      const st = roster.selState(s);
      if (isConfig(s)) {
        const picks = leaves(roster, s).map(l => l.name);
        config.push({ name: clean(st.name), picks });
      } else {
        units.push({
          id: s.uid,
          heading: s.raw.printName || clean(st.name),
          unitName: clean(st.name),
          image: clean(st.name).replace(/[\\/:*?"<>|]+/g, ''),
          points: roster.selTotal(s, POINTS_ID),
          lines: unitLines(roster, s),
        });
      }
      for (const x of allSels(s)) {
        const info = roster.infoFor(x);
        const from = clean(roster.selState(x).name);
        for (const r of info.rules) addCand('r:' + (r.obj.id || ruleKey(r.view.name)), r.obj.name || r.view.name, r.obj.description || r.view.description, from);
        for (const p of info.profiles) {
          const type = p.obj.typeName || '';
          if (/weapon/i.test(type)) {
            if (isConfig(s)) continue;
            if (!weapons.has(p.view.name)) weapons.set(p.view.name, { type, view: p.view });
            for (const label of splitRules(charText(p.view, /special/i))) if (label && label !== '-') ruleLabels.push([label, p.view.name]);
          } else {
            const text = charText(p.view, /^description$/i) || charText(p.view, /^summary$/i);
            if (text) addCand('p:' + p.obj.id, p.view.name, text, from);
          }
        }
      }
    }
    f.forces.forEach(walkForce);
  };
  roster.root.forces.forEach(walkForce);

  for (const [label, from] of ruleLabels) {
    let r = data.ruleByName(label);
    if (!r && resolveRule) { try { r = await resolveRule(label); } catch { r = null; } }
    if (r) addCand('r:' + (r.id || ruleKey(r.name)), r.name, r.description, from);
  }

  const toRow = (w) => {
    const v = w.view;
    const col = (re) => v.chars.find(c => re.test(c.name))?.value ?? '';
    return isMelee(v)
      ? { name: v.name, IM: col(/^IM$/), AM: col(/^AM$/), SM: col(/^SM$/), AP: col(/^AP$/), D: col(/^D$/), rules: col(/special/i), traits: col(/trait/i) }
      : { name: v.name, R: col(/^R$/), FP: col(/^FP$/), RS: col(/^RS$/), AP: col(/^AP$/), D: col(/^D$/), rules: col(/special/i), traits: col(/trait/i) };
  };
  const ws = [...weapons.values()].sort((a, b) => a.view.name.localeCompare(b.view.name));
  return {
    units,
    config,
    weapons: {
      ranged: ws.filter(w => !isMelee(w.view)).map(toRow),
      melee: ws.filter(w => isMelee(w.view)).map(toRow),
    },
    candidates: [...cands.values()]
      .map(c => ({ ...c, from: [...c.from].slice(0, 3), match: ruleKey(c.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------- InDesign Tagged Text ----------
// Paragraph and character style names the template should define. Anything not in the
// template is created by InDesign on place, so a mismatch shows up rather than failing.
export const STYLES = {
  section: 'HM Section Heading',
  unitImage: 'HM Unit Image',
  unitHeading: 'HM Unit Heading',
  unitLine: 'HM Unit Line',
  ruleBody: 'HM Rule',
  ruleCont: 'HM Rule Continued',
  ruleName: 'HM Rule Name',       // character style
  ruleLead: 'HM Rule Lead',       // character style, for the bold opening sentence
  weaponHead: 'HM Weapon Header',
  weaponLine: 'HM Weapon Line',
};

function tt(s) {
  // Escape for Tagged Text: specials get a backslash, anything beyond ASCII becomes <0xXXXX>.
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '<' || ch === '>' || ch === '\\') out += '\\' + ch;
    else if (c > 126) out += `<0x${c.toString(16).toUpperCase().padStart(4, '0')}>`;
    else out += ch;
  }
  return out;
}

function ruleText(text) {
  // Data rule text uses **bold** for the lead sentence and blank lines between paragraphs.
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => tt(p).replace(/\*\*(.+?)\*\*/g, `<cstyle:${STYLES.ruleLead}>$1<cstyle:>`).replace(/\*\*/g, ''));
}

export function taggedText(sheet, rules) {
  const S = STYLES;
  const L = [];
  const p = (style, text) => L.push(`<pstyle:${style}>${text}`);
  for (const u of sheet.units) {
    p(S.unitImage, '');
    p(S.unitHeading, tt(u.heading));
    for (const line of u.lines) p(S.unitLine, tt(line));
  }
  if (rules.length) {
    p(S.section, 'Special Rules');
    for (const r of rules) {
      const [first, ...more] = ruleText(r.text);
      p(S.ruleBody, `<cstyle:${S.ruleName}>${tt(r.name)}<cstyle:> <0x2013> ${first || ''}`);
      for (const m of more) p(S.ruleCont, m);
    }
  }
  const table = (title, cols, rows) => {
    if (!rows.length) return;
    p(S.section, title);
    p(S.weaponHead, ['Weapon', ...cols.map(c => c[0]), 'Special Rules', 'Traits'].map(tt).join('\t'));
    for (const r of rows) p(S.weaponLine, [r.name, ...cols.map(c => r[c[1]]), r.rules || '-', r.traits || '-'].map(tt).join('\t'));
  };
  table('Ranged Weapons', [['R', 'R'], ['FP', 'FP'], ['RS', 'RS'], ['AP', 'AP'], ['D', 'D']], sheet.weapons.ranged);
  table('Close Combat Weapons', [['IM', 'IM'], ['AM', 'AM'], ['SM', 'SM'], ['AP', 'AP'], ['D', 'D']], sheet.weapons.melee);
  return '<ASCII-WIN>\r\n<Version:16><FeatureSet:InDesign-Roman>\r\n' + L.join('\r\n') + '\r\n';
}

// Rules on this list are left out of new sheets unless ticked. Edit freely in the app.
export const DEFAULT_ALWAYS_EXCLUDED = [
  'breaching', 'rending', 'shred', 'pistol', 'heavy', 'assault', 'blast', 'twin-linked',
  'precision', 'critical hit', 'armourbane', 'reach', 'sunder', 'pinning', 'deflagrate',
  'fleshbane', 'barrage', 'two-handed', 'line', 'deep strike', 'outflank', 'infiltrate',
];
