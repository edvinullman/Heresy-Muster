// Roster engine: hydrates a saved roster against the game data, evaluates
// modifiers/conditions/constraints the way BattleScribe and New Recruit do,
// computes costs and validation messages, and applies edits.

import { Node, ForceNode, topForceNodes, findForceNode } from './data.js';
import { POINTS_ID } from './config.js';
import { REMOVED_IDS } from './corrections.js';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const NUMERIC = new Set(['set', 'increment', 'decrement', 'ceil', 'floor', 'multiply', 'divide']);

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function numericOp(cur, type, v, times) {
  v = num(v);
  switch (type) {
    case 'set': return v;
    case 'increment': return cur + v * times;
    case 'decrement': return cur - v * times;
    case 'ceil': return Math.min(cur, v);
    case 'floor': return Math.max(cur, v);
    case 'multiply': return cur * Math.pow(v, times);
    case 'divide': return v ? cur / Math.pow(v, times) : cur;
    default: return cur;
  }
}

function textOp(cur, m) {
  const join = m.join ?? ' ';
  const v = String(m.value ?? '');
  switch (m.type) {
    case 'set': return v;
    case 'append': return cur ? cur + join + v : v;
    case 'prepend': return cur ? v + join + cur : v;
    case 'replace': return m.arg !== undefined ? String(cur).split(String(m.arg)).join(v) : v;
    default: return cur;
  }
}

class RRoster {
  constructor(raw) { this.raw = raw; this.kind = 'roster'; this.uid = 'roster'; this.forces = []; this.parent = null; }
  get name() { return this.raw.name; }
}
class RForce {
  constructor(raw, node, parent) {
    this.raw = raw; this.node = node; this.parent = parent; this.kind = 'force';
    this.uid = raw.id; this.forces = []; this.sels = [];
    this.catalogueId = raw.catalogueId;
  }
  get name() { return this.node ? this.node.name : 'Unknown detachment'; }
  get children() { return this.sels; }
}
class RSel {
  constructor(raw, node, parent, force, groupNodes) {
    this.raw = raw; this.node = node; this.parent = parent; this.force = force; this.kind = 'sel';
    this.uid = raw.id; this.children = []; this.groupNodes = groupNodes;
    this.groupIds = groupNodes.flatMap(g => g.ids);
    this.scopedMods = [];
  }
  get number() { return this.raw.number ?? 1; }
}

export class Roster {
  constructor(data, raw) {
    this.data = data;
    this.raw = raw;
    raw.forces ||= [];
    raw.limits ||= {};
    this.costTypeIds = new Set(data.costTypes().map(c => c.id));
    this.refresh();
  }

  // ---------- hydration ----------
  refresh() {
    this.cache = new Map();
    this.counts = new Map();
    this.inProgress = new Set();
    this.broken = [];
    const root = new RRoster(this.raw);
    this.root = root;
    this.allSels = [];
    this.allForces = [];
    const hydrateForce = (raw, parent) => {
      raw.forces ||= []; raw.selections ||= [];
      const node = findForceNode(this.data, raw.entryId);
      const f = new RForce(raw, node, parent);
      if (!node) this.broken.push(`Missing detachment type ${raw.entryId}`);
      this.allForces.push(f);
      for (const s of raw.selections) {
        const sel = hydrateSel(s, f, f, null);
        if (sel) f.sels.push(sel);
      }
      for (const cf of raw.forces) f.forces.push(hydrateForce(cf, f));
      return f;
    };
    const hydrateSel = (raw, parent, force, parentNode) => {
      raw.selections ||= [];
      let node = null; const groups = [];
      if (!parentNode) {
        node = this.data.rootNode(force.catalogueId, raw.path[0]);
        if (node) for (const k of raw.path.slice(1)) { node = node?.child(k); }
      } else {
        let n = parentNode;
        for (const k of raw.path) {
          n = n.child(k);
          if (!n) break;
          if (n.isGroup) groups.push(n);
        }
        node = n;
      }
      if (!node || node.isGroup) {
        // Choices removed by a local correction are dropped quietly.
        if (!raw.path.some(k => REMOVED_IDS.has(k))) this.broken.push(`Missing entry ${raw.name || raw.path.join('/')}`);
        else raw._removed = true;
        return null;
      }
      raw.name = node.name;
      const sel = new RSel(raw, node, parent, force, groups);
      this.allSels.push(sel);
      for (const c of raw.selections) {
        const ch = hydrateSel(c, sel, force, node);
        if (ch) sel.children.push(ch);
      }
      return sel;
    };
    for (const f of this.raw.forces) root.forces.push(hydrateForce(f, root));
    const prune = (list) => { for (let i = list.length - 1; i >= 0; i--) { if (list[i]._removed) list.splice(i, 1); else prune(list[i].selections || []); } };
    const pruneForce = (f) => { prune(f.selections || []); (f.forces || []).forEach(pruneForce); };
    this.raw.forces.forEach(pruneForce);
    // Modifiers that act on a parent, unit or model instead of their own entry.
    for (const s of this.allSels) {
      for (const entry of s.node.modifiers()) {
        const sc = entry.mod.scope;
        if (!sc || sc === 'self') continue;
        const target = this.ancestorFor(s, sc);
        if (target && target.kind === 'sel') target.scopedMods.push({ ...entry, source: s });
      }
    }
  }

  ancestorFor(sel, scope) {
    let p = sel.parent;
    if (scope === 'parent') return p;
    while (p && p.kind === 'sel') {
      if (scope === 'unit' && p.node.type === 'unit') return p;
      if (scope === 'model' && p.node.type === 'model') return p;
      if (p.node.ids.includes(scope)) return p;
      p = p.parent;
    }
    return null;
  }

  // ---------- scope helpers ----------
  forceOf(obj) { return obj?.kind === 'sel' ? obj.force : obj?.kind === 'force' ? obj : null; }

  topForce(f) { while (f && f.parent && f.parent.kind === 'force') f = f.parent; return f; }

  resolveScope(scope, ctx) {
    const start = ctx.self || ctx.parent;
    switch (scope) {
      case 'self': return ctx.self;
      case 'parent': return ctx.parent;
      case 'force': return ctx.self?.kind === 'force' ? ctx.self : ctx.force;
      case 'roster': case 'primary-catalogue': case 'ancestor': return this.root;
      case 'unit': case 'model': {
        let p = start;
        while (p && p.kind === 'sel') { if (p.node.type === scope) return p; p = p.parent; }
        return null;
      }
      default: {
        let p = start;
        while (p && p.kind !== 'roster') { if (this.matches(p, scope)) return p; p = p.parent; }
        return null;
      }
    }
  }

  matches(obj, id) {
    if (!id || id === 'any') return true;
    if (obj.kind === 'sel') {
      if (obj.node.ids.includes(id) || obj.groupIds.includes(id)) return true;
      if (id === obj.node.type) return true;
      return this.categoriesOf(obj).includes(id);
    }
    if (obj.kind === 'force') return obj.node?.ids.includes(id) || obj.catalogueId === id;
    return false;
  }

  categoriesOf(sel) {
    if (this.inProgress.has(sel.uid)) return sel.node.categoryLinks().map(c => c.targetId);
    return this.selState(sel).categories;
  }

  // ---------- counting ----------
  count(c, ctx) {
    const field = c.field || 'selections';
    if (field.startsWith('limit::')) return num(this.raw.limits[field.slice(7)] ?? -1);
    const scopeObj = this.resolveScope(c.scope || 'parent', ctx);
    if (!scopeObj) return 0;
    const ics = !!c.includeChildSelections, icf = !!c.includeChildForces;
    const key = `${scopeObj.uid}|${c.childId}|${field}|${ics}|${icf}`;
    if (this.counts.has(key)) return this.counts.get(key);
    let n;
    if (field === 'selections') n = this.sumSel(scopeObj, s => this.matches(s, c.childId), ics, icf);
    else if (field === 'forces') n = this.countForces(scopeObj, c.childId, ics || icf);
    else n = this.sumCost(scopeObj, field, ics, icf, c.childId);
    this.counts.set(key, n);
    return n;
  }

  sumSel(scope, pred, ics, icf) {
    let total = 0;
    const visit = (list, factor) => {
      for (const s of list) {
        if (pred(s)) total += s.number * factor;
        if (ics) visit(s.children, factor * s.number);
      }
    };
    const visitForce = (f) => { visit(f.sels, 1); if (icf) f.forces.forEach(visitForce); };
    if (scope.kind === 'sel') visit(scope.children, 1);
    else if (scope.kind === 'force') visitForce(scope);
    else scope.forces.forEach(visitForce);
    return total;
  }

  countForces(scope, childId, deep) {
    let n = 0;
    const visit = (list) => {
      for (const f of list) {
        if (this.matches(f, childId)) n++;
        if (deep) visit(f.forces);
      }
    };
    if (scope.kind === 'force' || scope.kind === 'roster') visit(scope.forces);
    return n;
  }

  // Sum a cost type in a scope. Detachments carry costs too (e.g. "Apex Detachment(s)").
  sumCost(scope, typeId, ics, icf, childId) {
    const all = !childId || childId === 'any';
    let total = 0;
    const visitSel = (s, inMatch) => {
      if (inMatch || all) { total += ics ? this.selTotal(s, typeId) : s.number * this.ownCost(s, typeId); return; }
      if (this.matches(s, childId)) { total += this.selTotal(s, typeId); return; }
      if (ics) s.children.forEach(c => visitSel(c, false));
    };
    const visitForce = (f, inMatch) => {
      const m = inMatch || all || this.matches(f, childId);
      if (m) total += this.forceOwnCost(f, typeId);
      f.sels.forEach(s => visitSel(s, m));
      if (icf || ics) f.forces.forEach(cf => visitForce(cf, m));
    };
    if (scope.kind === 'sel') visitSel(scope, false);
    else if (scope.kind === 'force') visitForce(scope, false);
    else scope.forces.forEach(f => visitForce(f, false));
    return total;
  }

  forceOwnCost(f, typeId) {
    const st = this.forceState(f);
    return st ? (st.costs.get(typeId) || 0) : 0;
  }

  ownCost(sel, typeId) { return this.selState(sel).costs.get(typeId) || 0; }

  selTotal(sel, typeId) {
    let t = this.ownCost(sel, typeId);
    for (const c of sel.children) t += this.selTotal(c, typeId);
    return t * sel.number;
  }

  forceTotal(f, typeId = POINTS_ID) {
    let t = 0;
    for (const s of f.sels) t += this.selTotal(s, typeId);
    for (const cf of f.forces) t += this.forceTotal(cf, typeId);
    return t;
  }

  total(typeId = POINTS_ID) { return this.root.forces.reduce((a, f) => a + this.forceTotal(f, typeId), 0); }

  // ---------- conditions ----------
  condition(c, ctx) {
    if (c.type === 'instanceOf' || c.type === 'notInstanceOf') {
      const r = this.instanceCheck(c.scope, c.childId, ctx);
      return c.type === 'instanceOf' ? r : !r;
    }
    const n = this.count(c, ctx);
    const v = num(c.value);
    switch (c.type) {
      case 'atLeast': return n >= v;
      case 'atMost': return n <= v;
      case 'greaterThan': return n > v;
      case 'lessThan': return n < v;
      case 'equalTo': return n === v;
      case 'notEqualTo': return n !== v;
      default: return true;
    }
  }

  instanceCheck(scope, childId, ctx) {
    if (scope === 'primary-catalogue') {
      const f = this.topForce(ctx.force || this.forceOf(ctx.self));
      const cat = f ? f.catalogueId : this.raw.catalogueId;
      return cat === childId;
    }
    if (scope === 'ancestor') {
      let p = ctx.parent;
      while (p && p.kind !== 'roster') { if (this.matches(p, childId)) return true; p = p.parent; }
      return false;
    }
    if (scope === 'self' && !ctx.self) {
      const n = ctx.node;
      if (!n) return false;
      if (n.ids.includes(childId) || (ctx.groupIds || []).includes(childId) || n.type === childId) return true;
      return n.categoryLinks().some(c => c.targetId === childId);
    }
    const obj = this.resolveScope(scope, ctx);
    return obj ? this.matches(obj, childId) : false;
  }

  conditionsPass(holder, ctx) {
    for (const c of holder.conditions || []) if (!this.condition(c, ctx)) return false;
    for (const g of holder.conditionGroups || []) if (!this.groupPass(g, ctx)) return false;
    return true;
  }

  groupPass(g, ctx) {
    const parts = [];
    for (const c of g.conditions || []) parts.push(() => this.condition(c, ctx));
    for (const sg of g.conditionGroups || []) parts.push(() => this.groupPass(sg, ctx));
    if (!parts.length) return true;
    return g.type === 'or' ? parts.some(p => p()) : parts.every(p => p());
  }

  repeatTimes(holder, ctx) {
    const reps = holder.repeats;
    if (!Array.isArray(reps) || !reps.length) return 1;
    let times = 0;
    for (const r of reps) {
      const n = this.count(r, ctx);
      const v = num(r.value);
      const per = v > 0 ? (r.roundUp ? Math.ceil(n / v) : Math.floor(n / v)) : 0;
      times += per * num(r.repeats ?? 1);
    }
    return times;
  }

  // ---------- state computation ----------
  computeState(node, ctx, extra = []) {
    const st = {
      name: node.name,
      hidden: node.hiddenBase,
      costs: node.costs(),
      constraints: node.constraints().map(c => ({ ...c, value: num(c.value) })),
      categories: [],
      primary: null,
      errors: [], warnings: [], infos: [],
      charMods: [],
      defaultAmount: node.link?.defaultAmount ?? node.target.defaultAmount ?? 0,
      defaultSelectionEntryId: node.target.defaultSelectionEntryId,
      description: undefined,
    };
    for (const cl of node.categoryLinks()) {
      if (!st.categories.includes(cl.targetId)) st.categories.push(cl.targetId);
      if (cl.primary) st.primary = cl.targetId;
    }
    const apply = (entry, c) => {
      const { mod, groups } = entry;
      for (const g of groups) if (!this.conditionsPass(g, c)) return;
      if (!this.conditionsPass(mod, c)) return;
      let times = this.repeatTimes(mod, c);
      for (const g of groups) if (Array.isArray(g.repeats) && g.repeats.length) times *= this.repeatTimes(g, c);
      if (times <= 0) return;
      this.applyMod(st, mod, times);
    };
    for (const e of node.modifiers()) {
      if (e.mod.scope && e.mod.scope !== 'self' && ctx.self) continue; // handled on the target
      apply(e, ctx);
    }
    for (const e of extra) apply(e, this.selCtx(e.source));
    return st;
  }

  applyMod(st, m, times) {
    const f = m.field;
    switch (f) {
      case 'hidden': st.hidden = m.value === true || m.value === 'true'; return;
      case 'name': st.name = textOp(st.name, m); return;
      case 'description': st.description = textOp(st.description || '', m); return;
      case 'defaultAmount': st.defaultAmount = num(m.value); return;
      case 'defaultSelectionEntryId': st.defaultSelectionEntryId = m.value; return;
      case 'tracked': case 'page': case 'publication': return;
      case 'error': case 'warning': case 'info':
        if (m.type === 'add' || m.type === 'set') st[f + 's'].push(String(m.value));
        return;
      case 'category': {
        const id = m.value;
        if (m.type === 'add') { if (!st.categories.includes(id)) st.categories.push(id); }
        else if (m.type === 'remove') { st.categories = st.categories.filter(x => x !== id); if (st.primary === id) st.primary = null; }
        else if (m.type === 'set-primary' || m.type === 'set') { if (!st.categories.includes(id)) st.categories.push(id); st.primary = id; }
        else if (m.type === 'unset-primary') { if (st.primary === id) st.primary = null; }
        return;
      }
    }
    const con = st.constraints.find(c => c.id === f);
    if (con) { if (NUMERIC.has(m.type)) con.value = numericOp(con.value, m.type, m.value, times); return; }
    if (this.costTypeIds.has(f) || st.costs.has(f)) {
      if (NUMERIC.has(m.type)) st.costs.set(f, numericOp(st.costs.get(f) || 0, m.type, m.value, times));
      return;
    }
    st.charMods.push({ ...m, times });
  }

  selCtx(sel) { return { self: sel, parent: sel.parent, force: sel.force, node: sel.node, groupIds: sel.groupIds }; }

  selState(sel) {
    const key = 's:' + sel.uid;
    if (this.cache.has(key)) return this.cache.get(key);
    this.inProgress.add(sel.uid);
    const st = this.computeState(sel.node, this.selCtx(sel), sel.scopedMods);
    this.inProgress.delete(sel.uid);
    this.cache.set(key, st);
    return st;
  }

  candState(node, parent, groupNodes = []) {
    const key = 'c:' + parent.uid + ':' + groupNodes.map(g => g.key).join('/') + '/' + node.key;
    if (this.cache.has(key)) return this.cache.get(key);
    const ctx = { self: null, parent, force: this.forceOf(parent), node, groupIds: groupNodes.flatMap(g => g.ids) };
    const st = this.computeState(node, ctx);
    this.cache.set(key, st);
    return st;
  }

  forceState(f) {
    const key = 'f:' + f.uid;
    if (this.cache.has(key)) return this.cache.get(key);
    const st = f.node ? this.computeState(f.node, { self: f, parent: f.parent, force: f, node: f.node }) : null;
    this.cache.set(key, st);
    return st;
  }

  forceCandState(fnode, parent) {
    const key = 'fc:' + parent.uid + ':' + fnode.key;
    if (this.cache.has(key)) return this.cache.get(key);
    const st = this.computeState(fnode, { self: null, parent, force: parent.kind === 'force' ? parent : null, node: fnode });
    this.cache.set(key, st);
    return st;
  }

  // Detachment slots (category links on a force) with their limits.
  slots(f) {
    const key = 'sl:' + f.uid;
    if (this.cache.has(key)) return this.cache.get(key);
    const out = [];
    for (const cl of f.node?.categoryLinks() || []) {
      // A slot is hidden if its category is hidden by default or the link hides it;
      // modifiers on either can switch it back on.
      const cat = this.data.resolve(cl.targetId, f.catalogueId);
      const pseudo = {
        name: cat?.name || cl.targetId,
        hiddenBase: !!(cl.hidden || cat?.hidden),
        ids: [cl.targetId], key: cl.id, link: null, target: cl,
        constraints: () => [...(cat?.constraints || []), ...(cl.constraints || [])].map(c => ({ ...c, owner: cl.targetId })),
        modifiers: () => [...(cat?.modifiers || []), ...(cl.modifiers || [])].map(m => ({ mod: m, groups: [] })),
        costs: () => new Map(), categoryLinks: () => [],
        type: 'category',
      };
      const st = this.computeState(pseudo, { self: null, parent: f, force: f, node: pseudo });
      out.push({ categoryId: cl.targetId, link: cl, state: st, node: pseudo });
    }
    this.cache.set(key, out);
    return out;
  }

  // ---------- profiles and rules ----------
  profileView(p, ctx, entryMods = [], via = null) {
    const st = { name: via?.name || p.name, hidden: !!(p.hidden || via?.hidden), chars: (p.characteristics || []).map(c => ({ name: c.name, typeId: c.typeId, value: c.$text ?? '' })) };
    const applyChar = (m, times) => {
      if (m.field === 'name') { st.name = textOp(st.name, m); return; }
      if (m.field === 'hidden') { st.hidden = m.value === true || m.value === 'true'; return; }
      const ch = st.chars.find(c => c.typeId === m.field);
      if (!ch) return;
      if (NUMERIC.has(m.type) && m.type !== 'set') {
        const cur = parseFloat(ch.value);
        if (!Number.isFinite(cur)) return;
        const suffix = String(ch.value).replace(/^[-\d.]+/, '');
        ch.value = String(numericOp(cur, m.type, m.value, times)) + suffix;
      } else ch.value = textOp(ch.value, m);
    };
    for (const m of entryMods) applyChar(m, m.times || 1);
    for (const e of [...(via?.modifiers || []), ...(p.modifiers || [])].map(m => ({ mod: m, groups: [] })).concat(
      (p.modifierGroups || []).flatMap(g => (g.modifiers || []).map(m => ({ mod: m, groups: [g] }))))) {
      if (e.groups.some(g => !this.conditionsPass(g, ctx))) continue;
      if (!this.conditionsPass(e.mod, ctx)) continue;
      const t = this.repeatTimes(e.mod, ctx);
      if (t > 0) applyChar(e.mod, t);
    }
    return st;
  }

  ruleView(r, ctx, via = null) {
    const st = { name: via?.name || r.name, hidden: !!(r.hidden || via?.hidden), description: r.description || '', page: r.page, id: r.id };
    for (const m of [...(via?.modifiers || []), ...(r.modifiers || [])]) {
      if (!this.conditionsPass(m, ctx)) continue;
      if (m.field === 'name') st.name = textOp(st.name, m);
      else if (m.field === 'hidden') st.hidden = m.value === true || m.value === 'true';
      else if (m.field === 'description') st.description = textOp(st.description, m);
    }
    return st;
  }

  infoFor(sel) {
    const ctx = this.selCtx(sel);
    const st = this.selState(sel);
    const { profiles, rules } = sel.node.info();
    const prof = profiles.map(({ obj, via }) => ({ obj, view: this.profileView(obj, ctx, st.charMods, via) })).filter(p => !p.view.hidden);
    const rul = rules.map(({ obj, via }) => ({ obj, view: this.ruleView(obj, ctx, via) })).filter(r => !r.view.hidden);
    return { profiles: prof, rules: rul };
  }

  // ---------- options available under a parent ----------
  // Returns a tree: [{kind:'entry'|'group', node, groups, state, count, children?}]
  options(parent) {
    const parentNode = parent.kind === 'sel' ? parent.node : null;
    if (!parentNode) return [];
    const build = (nodes, groups) => nodes.map(n => {
      const state = this.candState(n, parent, groups);
      if (n.isGroup) {
        const g2 = groups.concat([n]);
        const kids = build(n.children(), g2);
        const count = parent.children
          .filter(s => s.groupNodes[groups.length]?.key === n.key && sameGroups(s.groupNodes.slice(0, groups.length), groups))
          .reduce((a, s) => a + s.number, 0);
        return { kind: 'group', node: n, groups, state, count, children: kids };
      }
      const sels = parent.children.filter(s => s.node.key === n.key && sameGroups(s.groupNodes, groups));
      return { kind: 'entry', node: n, groups, state, count: sels.reduce((a, s) => a + s.number, 0), sels };
    });
    return build(parentNode.children(), []);
  }

  limitsOf(state, scopeName = 'parent') {
    let min = 0, max = -1;
    for (const c of state.constraints) {
      if ((c.field || 'selections') !== 'selections' || c.scope !== scopeName) continue;
      if (c.type === 'min') min = Math.max(min, c.value);
      if (c.type === 'max' && c.value >= 0) max = max < 0 ? c.value : Math.min(max, c.value);
    }
    return { min, max };
  }

  // Root entries a force can take, grouped by its visible slots.
  rootChoices(f) {
    const visibleSlots = this.slots(f).filter(s => !s.state.hidden).map(s => s.categoryId);
    const out = [];
    for (const n of this.data.rootNodes(f.catalogueId)) {
      const st = this.candState(n, f);
      if (st.hidden) continue;
      const cat = st.primary;
      if (!cat || !visibleSlots.includes(cat)) continue;
      out.push({ node: n, state: st, categoryId: cat });
    }
    return out;
  }

  childForceChoices(parent) {
    const nodes = parent.kind === 'roster' ? topForceNodes(this.data) : (parent.node?.childForces() || []);
    return nodes.map(n => ({ node: n, state: this.forceCandState(n, parent) })).filter(c => !c.state.hidden);
  }

  // ---------- validation ----------
  validate() {
    const out = [];
    const seen = new Set();
    const push = (level, msg, where) => {
      const k = level + msg + (where?.uid || '');
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ level, msg, where });
    };
    const scopeLabel = (obj) => !obj ? 'army' : obj.kind === 'roster' ? 'the army' : obj.kind === 'force' ? obj.name : this.selState(obj).name;
    const checkConstraints = (name, state, ctx, where, present, withMessages = true) => {
      for (const c of state.constraints) {
        if (c.percentValue) continue;
        const field = c.field || 'selections';
        if (field.startsWith('limit::')) continue;
        if (c.value < 0) continue;
        if (state.hidden && c.type === 'min') continue;
        const scopeObj = this.resolveScope(c.scope || 'parent', ctx);
        if (!scopeObj) continue;
        const dk = c.id + '|' + scopeObj.uid;
        if (seen.has(dk)) continue;
        const n = this.count({ ...c, childId: c.owner }, ctx);
        if (c.type === 'min' && n < c.value && (present || c.value > 0)) {
          seen.add(dk);
          const what = field === 'selections' ? '' : field === 'forces' ? ' detachment(s)' : ' ' + this.costName(field);
          const inside = scopeObj.kind === 'sel' && field === 'selections';
          push('error', inside ? `${name}: pick at least ${c.value} (has ${fmt(n)})` : `${name}: needs at least ${c.value}${what} in ${scopeLabel(scopeObj)} (has ${fmt(n)})`, where);
        }
        if (c.type === 'max' && n > c.value) {
          seen.add(dk);
          const what = field === 'selections' ? '' : field === 'forces' ? ' detachment(s)' : ' ' + this.costName(field);
          const inside = scopeObj.kind === 'sel' && field === 'selections';
          push('error', inside ? `${name}: pick at most ${c.value} (has ${fmt(n)})` : `${name}: at most ${c.value}${what} allowed in ${scopeLabel(scopeObj)} (has ${fmt(n)})`, where);
        }
      }
      if (!withMessages) return;
      for (const e of state.errors) push('error', e, where);
      for (const w of state.warnings) push('warning', w, where);
    };

    // Detachments
    for (const c of this.childForceChoices(this.root).concat(topForceNodes(this.data).filter(n => n.hiddenBase).map(n => ({ node: n, state: this.forceCandState(n, this.root) })))) {
      checkConstraints(c.state.name, c.state, { self: null, parent: this.root, force: null, node: c.node }, null, false, false);
    }
    for (const f of this.allForces) {
      const st = this.forceState(f);
      if (!st) continue;
      checkConstraints(st.name, st, { self: f, parent: f.parent, force: f, node: f.node }, f, true);
      for (const cn of f.node.childForces()) {
        const cst = this.forceCandState(cn, f);
        checkConstraints(cst.name, cst, { self: null, parent: f, force: f, node: cn }, f, false, false);
      }
      for (const slot of this.slots(f)) {
        if (slot.state.hidden && !this.sumSel(f, s => this.matches(s, slot.categoryId), false, false)) continue;
        checkConstraints(slot.state.name, slot.state, { self: null, parent: f, force: f, node: slot.node }, f, false);
      }
      const eligible = new Set(this.rootChoices(f).map(c => c.node.key));
      for (const s of f.sels) eligible.add(s.node.key);
      for (const n of this.data.rootNodes(f.catalogueId)) {
        if (!n.constraints().length || !eligible.has(n.key)) continue;
        const st2 = this.candState(n, f);
        checkConstraints(st2.name, st2, { self: null, parent: f, force: f, node: n }, f, false, false);
      }
    }
    // Selections and their options
    for (const s of this.allSels) {
      const st = this.selState(s);
      if (st.hidden) push('warning', `${st.name} is not available with the current choices`, s);
      for (const e of st.errors) push('error', e, s);
      for (const w of st.warnings) push('warning', w, s);
      const walk = (items) => {
        for (const it of items) {
          const ctx = { self: null, parent: s, force: s.force, node: it.node, groupIds: it.groups.flatMap(g => g.ids) };
          if (!(it.state.hidden && !it.count)) checkConstraints(it.state.name, it.state, ctx, s, false);
          if (it.children) walk(it.children);
        }
      };
      walk(this.options(s));
    }
    for (const b of this.broken) push('warning', b, null);
    return out;
  }

  costName(id) {
    return this.data.costTypes().find(c => c.id === id)?.name || 'points';
  }

  // ---------- edits ----------
  addForce(parent, fnode, catalogueId) {
    const raw = { id: uid(), entryId: fnode.key, catalogueId: catalogueId || (parent.kind === 'force' ? parent.catalogueId : this.raw.catalogueId), forces: [], selections: [] };
    (parent.kind === 'roster' ? this.raw.forces : parent.raw.forces).push(raw);
    this.refresh();
    this.addMandatory(this.allForces.find(x => x.raw === raw));
    const f = this.allForces.find(x => x.raw === raw);
    // Add required sub-detachments that are visible.
    for (const cn of fnode.childForces()) {
      const st = this.forceCandState(cn, f);
      if (st.hidden) continue;
      const min = st.constraints.filter(c => c.type === 'min' && c.field === 'forces' && c.scope === 'parent').reduce((a, c) => Math.max(a, c.value), 0);
      for (let i = 0; i < min; i++) this.addForce(f, cn);
    }
    return this.allForces.find(x => x.raw === raw);
  }

  removeForce(f) {
    const list = f.parent.kind === 'roster' ? this.raw.forces : f.parent.raw.forces;
    const i = list.indexOf(f.raw);
    if (i >= 0) list.splice(i, 1);
    this.refresh();
  }

  addRoot(f, node, number = 1, { fill = true } = {}) {
    const raw = { id: uid(), path: [node.key], name: node.name, number, selections: [] };
    f.raw.selections.push(raw);
    this.refresh();
    if (fill) this.autofill(raw);
    return raw;
  }

  // Add the entries a force must contain (e.g. Allegiance, Rite of War), leaving
  // their own choices blank so validation asks for them.
  addMandatory(f) {
    for (let guard = 0; guard < 20; guard++) {
      f = this.allForces.find(x => x.raw === f.raw);
      if (!f) return;
      const need = this.rootChoices(f).find(c => {
        const min = c.state.constraints
          .filter(k => k.type === 'min' && (k.field || 'selections') === 'selections' && (k.scope === 'parent' || k.scope === 'force'))
          .reduce((a, k) => Math.max(a, k.value), 0);
        if (!min) return false;
        const have = f.sels.filter(s => s.node.key === c.node.key).reduce((a, s) => a + s.number, 0);
        return have < min;
      });
      if (!need) return;
      this.addRoot(f, need.node, 1, { fill: false });
    }
  }

  addChild(parent, node, groups, number = 1) {
    const raw = { id: uid(), path: groups.map(g => g.key).concat([node.key]), name: node.name, number, selections: [] };
    parent.raw.selections.push(raw);
    this.refresh();
    this.autofill(raw);
    return raw;
  }

  selByRaw(raw) { return this.allSels.find(s => s.raw === raw); }

  removeSel(sel) {
    const list = sel.parent.raw.selections;
    const i = list.indexOf(sel.raw);
    if (i >= 0) list.splice(i, 1);
    this.refresh();
  }

  setNumber(sel, n) {
    if (n <= 0) return this.removeSel(sel);
    sel.raw.number = n;
    this.refresh();
  }

  // Set how many of an option entry the parent has (merging into one selection).
  setOptionCount(parent, item, n) {
    const existing = item.sels;
    const current = existing.reduce((a, s) => a + s.number, 0);
    if (n === current) return;
    if (n > current) {
      // New models join the largest loadout group (the "default" loadout).
      if (existing.length) { const s = existing.reduce((a, b) => (b.number > a.number ? b : a)); s.raw.number = s.number + (n - current); this.refresh(); }
      else this.addChild(parent, item.node, item.groups, n);
      return;
    }
    let drop = current - n;
    for (const s of [...existing].reverse()) {
      if (drop <= 0) break;
      const take = Math.min(drop, s.number);
      drop -= take;
      if (take === s.number) { const l = parent.raw.selections; l.splice(l.indexOf(s.raw), 1); }
      else s.raw.number = s.number - take;
    }
    this.refresh();
  }

  // Pick one entry of a group that allows only one, replacing the others.
  chooseInGroup(parent, groupItem, item) {
    const g = groupItem.node;
    parent.raw.selections = parent.raw.selections.filter(r => {
      const s = this.selByRaw(r);
      return !(s && s.groupNodes.some(x => x.key === g.key));
    });
    this.refresh();
    const p = this.allSels.find(s => s.uid === parent.uid);
    if (item) this.addChild(p, item.node, item.groups, 1);
  }

  // Move models between loadout groups of the same entry, keeping the total.
  // d = +1 takes one from the largest other group; d = -1 gives one back to it.
  moveModels(sel, d) {
    const key = sel.raw.path.join('/');
    const others = sel.parent.children.filter(c => c !== sel && c.raw.path.join('/') === key);
    if (!others.length) return;
    const other = others.reduce((a, b) => (b.number > a.number ? b : a));
    const [from, to] = d > 0 ? [other, sel] : [sel, other];
    if (from.number < 1) return;
    to.raw.number = to.number + 1;
    if (from.number === 1) {
      const list = from.parent.raw.selections;
      list.splice(list.indexOf(from.raw), 1);
    } else from.raw.number = from.number - 1;
    this.refresh();
  }

  splitOne(sel) {
    if (sel.number < 2) return;
    sel.raw.number = sel.number - 1;
    const copy = cloneRaw(sel.raw);
    copy.number = 1;
    const list = sel.parent.raw.selections;
    list.splice(list.indexOf(sel.raw) + 1, 0, copy);
    this.refresh();
    return copy;
  }

  duplicate(sel) {
    const copy = cloneRaw(sel.raw);
    const list = sel.parent.raw.selections;
    list.splice(list.indexOf(sel.raw) + 1, 0, copy);
    this.refresh();
    return copy;
  }

  // Add the minimum required options (and defaults) under a new selection.
  // One addition at a time, re-reading the options after each, so nested
  // group minimums are never satisfied twice.
  autofill(raw, depth = 0) {
    if (depth > 6) return;
    const created = [];
    for (let guard = 0; guard < 60; guard++) {
      const sel = this.selByRaw(raw);
      if (!sel) return;
      const step = this.nextFill(this.options(sel));
      if (!step) break;
      created.push(this.addRawChild(sel, step.node, step.groups, step.n));
    }
    for (const r of created) this.autofill(r, depth + 1);
  }

  nextFill(items, allowDefaults = true) {
    for (const it of items) {
      if (it.state.hidden) continue;
      const { min, max } = this.limitsOf(it.state);
      if (max === 0) continue;
      if (it.kind === 'group') {
        if (min > it.count) {
          const pick = pickDefault(it, this);
          if (pick) return { node: pick.node, groups: pick.groups, n: min - it.count };
        }
        const inner = this.nextFill(it.children, allowDefaults && it.count === 0);
        if (inner) return inner;
        continue;
      }
      let want = min;
      if (!want && allowDefaults && it.state.defaultAmount > 0) want = it.state.defaultAmount;
      if (want > it.count) return { node: it.node, groups: it.groups, n: want - it.count };
    }
    return null;
  }

  addRawChild(parent, node, groups, number) {
    const raw = { id: uid(), path: groups.map(g => g.key).concat([node.key]), name: node.name, number, selections: [] };
    parent.raw.selections.push(raw);
    this.refresh();
    return raw;
  }
}

function pickDefault(groupItem, r) {
  const want = groupItem.state.defaultSelectionEntryId;
  const flat = [];
  const usable = (it) => !it.state.hidden && r.limitsOf(it.state).max !== 0;
  const walk = (items) => { for (const it of items) { if (!usable(it)) continue; if (it.kind === 'entry') flat.push(it); else walk(it.children); } };
  walk(groupItem.children);
  if (want) {
    const hit = flat.find(i => i.node.ids.includes(want));
    if (hit) return hit;
  }
  return flat.find(i => i.state.defaultAmount > 0) || flat[0] || null;
}

function sameGroups(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].key !== b[i].key) return false;
  return true;
}

function cloneRaw(raw) {
  const c = JSON.parse(JSON.stringify(raw));
  const reid = (r) => { r.id = uid(); (r.selections || []).forEach(reid); };
  reid(c);
  return c;
}

function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }

export function newRosterRaw({ name, catalogueId, gameSystemId, points }) {
  return {
    id: uid(), name, catalogueId, gameSystemId,
    limits: { [POINTS_ID]: points },
    forces: [], created: Date.now(), updated: Date.now(),
  };
}

export { RSel, RForce, RRoster };
