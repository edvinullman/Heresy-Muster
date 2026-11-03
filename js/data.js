// Indexes BattleScribe/New Recruit JSON data and turns entries and links into
// "nodes" the engine can walk. No DOM or network code lives here, so the same
// file runs in the browser and in Node tests.

import { REMOVED_IDS } from './corrections.js';

const DEF_KEYS = new Set([
  'selectionEntries', 'selectionEntryGroups', 'sharedSelectionEntries',
  'sharedSelectionEntryGroups', 'sharedRules', 'sharedProfiles', 'rules',
  'profiles', 'categoryEntries', 'forceEntries', 'costTypes', 'profileTypes',
  'publications', 'sharedInfoGroups', 'infoGroups',
]);

export class GameData {
  constructor(manifest) {
    this.manifest = manifest;                 // [{id,name,file,type,library,links}]
    this.files = new Map();                   // catalogue id -> root object
    this.defs = new Map();                    // catalogue id -> Map(id -> obj)
    this.objCat = new WeakMap();              // obj -> catalogue id it lives in
    this.global = new Map();                  // id -> obj (first wins)
    this.gameSystem = null;
    this._scopeCache = new Map();
    this._rootNodes = new Map();
  }

  addFile(json) {
    const kind = Object.keys(json)[0];
    const root = json[kind];
    const catId = root.id;
    if (this.files.has(catId)) return;
    stripRemoved(root);
    this.files.set(catId, root);
    if (kind === 'gameSystem') this.gameSystem = root;
    const map = new Map();
    this.defs.set(catId, map);
    const walk = (o, key) => {
      if (Array.isArray(o)) { for (const x of o) walk(x, key); return; }
      if (!o || typeof o !== 'object') return;
      this.objCat.set(o, catId);
      if (o.id && DEF_KEYS.has(key)) {
        if (!map.has(o.id)) map.set(o.id, o);
        if (!this.global.has(o.id)) this.global.set(o.id, o);
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') walk(v, k);
      }
    };
    walk(root, '');
    this._scopeCache.clear();
    this._rootNodes.clear();
  }

  manifestEntry(id) { return this.manifest.find(m => m.id === id); }

  // Catalogue ids a catalogue can see: itself, everything it links (transitively), the game system.
  scopeOf(catId) {
    if (this._scopeCache.has(catId)) return this._scopeCache.get(catId);
    const seen = [];
    const visit = id => {
      if (!id || seen.includes(id)) return;
      seen.push(id);
      const root = this.files.get(id);
      const links = root ? (root.catalogueLinks || []).map(l => l.targetId) : (this.manifestEntry(id)?.links || []);
      for (const t of links) visit(t);
    };
    visit(catId);
    if (this.gameSystem && !seen.includes(this.gameSystem.id)) seen.push(this.gameSystem.id);
    this._scopeCache.set(catId, seen);
    return seen;
  }

  // Every file a catalogue needs loaded.
  filesNeeded(catId) {
    const out = [];
    const visit = id => {
      const m = this.manifestEntry(id);
      if (!m || out.includes(m)) return;
      out.push(m);
      for (const t of m.links) visit(t);
    };
    visit(catId);
    return out;
  }

  resolve(id, fromCat) {
    if (!id) return null;
    if (fromCat) {
      for (const c of this.scopeOf(fromCat)) {
        const hit = this.defs.get(c)?.get(id);
        if (hit) return hit;
      }
    }
    return this.global.get(id) || null;
  }

  catOf(obj) { return this.objCat.get(obj) || this.gameSystem?.id; }

  catalogueName(id) {
    const m = this.manifestEntry(id);
    return m ? m.name : (this.files.get(id)?.name || '').trim();
  }

  categoryName(id, fromCat) {
    const c = this.resolve(id, fromCat);
    return c ? c.name : id;
  }

  costTypes() { return this.gameSystem?.costTypes || []; }

  // Root entries a force of this catalogue can pick from.
  rootNodes(catId) {
    if (this._rootNodes.has(catId)) return this._rootNodes.get(catId);
    const nodes = [];
    const seenCats = new Set();
    const addFrom = (id) => {
      if (seenCats.has(id)) return;
      seenCats.add(id);
      const root = this.files.get(id);
      if (!root) return;
      for (const e of root.selectionEntries || []) nodes.push(new Node(this, e, null, null));
      for (const l of root.entryLinks || []) {
        const t = this.resolve(l.targetId, this.catOf(l));
        if (t) nodes.push(new Node(this, t, l, null));
      }
      for (const cl of root.catalogueLinks || []) if (cl.importRootEntries) addFrom(cl.targetId);
    };
    addFrom(catId);
    if (this.gameSystem) addFrom(this.gameSystem.id);
    this._rootNodes.set(catId, nodes);
    return nodes;
  }

  rootNode(catId, key) {
    return this.rootNodes(catId).find(n => n.key === key) || null;
  }
}

// Apply local corrections: drop removed entries, groups and links.
const LIST_KEYS = ['selectionEntries', 'selectionEntryGroups', 'entryLinks', 'sharedSelectionEntries', 'sharedSelectionEntryGroups'];
function stripRemoved(o) {
  if (!REMOVED_IDS.size || !o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(stripRemoved); return; }
  for (const k of LIST_KEYS) {
    if (Array.isArray(o[k])) o[k] = o[k].filter(x => !REMOVED_IDS.has(x.id));
  }
  for (const k in o) { const v = o[k]; if (v && typeof v === 'object') stripRemoved(v); }
}

function flatModifiers(obj) {
  const out = [];
  for (const m of obj.modifiers || []) out.push({ mod: m, groups: [] });
  const walkGroups = (groups, chain) => {
    for (const g of groups || []) {
      const c = chain.concat([g]);
      for (const m of g.modifiers || []) out.push({ mod: m, groups: c });
      walkGroups(g.modifierGroups, c);
    }
  };
  walkGroups(obj.modifierGroups, []);
  return out;
}

// An entry or group as reached through an optional link.
export class Node {
  constructor(data, target, link, parent) {
    this.data = data;
    this.target = target;
    this.link = link;
    this.parent = parent;
    this.key = link ? link.id : target.id;
    this.ids = link ? [link.id, target.id] : [target.id];
    // Groups have no "type" field; entries always have unit/model/upgrade.
    this.isGroup = link ? link.type === 'selectionEntryGroup' : !target.type;
    this._children = null;
  }

  get name() { return this.target.name; }
  get type() { return this.isGroup ? 'group' : this.target.type; }
  get collective() { return !!(this.target.collective || this.link?.collective); }
  get hiddenBase() { return !!(this.target.hidden || this.link?.hidden); }
  get sortIndex() { return this.link?.sortIndex ?? this.target.sortIndex ?? 0; }

  children() {
    if (this._children) return this._children;
    const out = [];
    const addFrom = (obj) => {
      if (!obj) return;
      const cat = this.data.catOf(obj);
      for (const e of obj.selectionEntries || []) out.push(new Node(this.data, e, null, this));
      for (const g of obj.selectionEntryGroups || []) out.push(new Node(this.data, g, null, this));
      for (const l of obj.entryLinks || []) {
        const t = this.data.resolve(l.targetId, cat);
        if (t) out.push(new Node(this.data, t, l, this));
      }
    };
    addFrom(this.target);
    addFrom(this.link);
    out.sort((a, b) => (a.sortIndex - b.sortIndex) || a.name.localeCompare(b.name));
    this._children = out;
    return out;
  }

  child(key) { return this.children().find(c => c.key === key) || null; }

  // Constraints, each tagged with the id selections are counted against.
  constraints() {
    if (this._cons) return this._cons;
    const out = [];
    for (const c of this.target.constraints || []) out.push({ ...c, owner: this.target.id });
    for (const c of this.link?.constraints || []) out.push({ ...c, owner: this.link.id });
    this._cons = out;
    return out;
  }

  modifiers() {
    if (this._mods) return this._mods;
    this._mods = [...flatModifiers(this.target), ...(this.link ? flatModifiers(this.link) : [])];
    return this._mods;
  }

  costs() {
    const m = new Map();
    for (const c of this.target.costs || []) m.set(c.typeId, Number(c.value) || 0);
    for (const c of this.link?.costs || []) m.set(c.typeId, Number(c.value) || 0);
    return m;
  }

  categoryLinks() { return [...(this.target.categoryLinks || []), ...(this.link?.categoryLinks || [])]; }

  // Profiles and rules attached directly or through info links.
  info() {
    if (this._info) return this._info;
    const profiles = [], rules = [];
    const addFrom = (obj) => {
      if (!obj) return;
      const cat = this.data.catOf(obj);
      for (const p of obj.profiles || []) profiles.push({ obj: p, via: null });
      for (const r of obj.rules || []) rules.push({ obj: r, via: null });
      for (const il of obj.infoLinks || []) {
        const t = this.data.resolve(il.targetId, cat);
        if (!t) continue;
        if (il.type === 'profile') profiles.push({ obj: t, via: il });
        else if (il.type === 'rule') rules.push({ obj: t, via: il });
        else if (il.type === 'infoGroup') {
          for (const p of t.profiles || []) profiles.push({ obj: p, via: il });
          for (const r of t.rules || []) rules.push({ obj: r, via: il });
        }
      }
    };
    addFrom(this.target);
    addFrom(this.link);
    this._info = { profiles, rules };
    return this._info;
  }

  // Walk a path of keys starting below this node.
  walk(path) {
    let n = this;
    for (const k of path) { n = n.child(k); if (!n) return null; }
    return n;
  }
}

// Force entries as nodes, so the engine can treat them uniformly.
export class ForceNode {
  constructor(data, entry) {
    this.data = data;
    this.target = entry;
    this.link = null;
    this.key = entry.id;
    this.ids = [entry.id];
    this.isGroup = false;
  }
  get name() { return this.target.name; }
  get type() { return 'force'; }
  get hiddenBase() { return !!this.target.hidden; }
  get sortIndex() { return this.target.sortIndex ?? 0; }
  constraints() {
    if (!this._cons) this._cons = (this.target.constraints || []).map(c => ({ ...c, owner: this.target.id }));
    return this._cons;
  }
  modifiers() { if (!this._mods) this._mods = flatModifiers(this.target); return this._mods; }
  costs() { return new Map((this.target.costs || []).map(c => [c.typeId, Number(c.value) || 0])); }
  categoryLinks() { return this.target.categoryLinks || []; }
  childForces() {
    if (!this._kids) this._kids = (this.target.forceEntries || []).map(f => new ForceNode(this.data, f))
      .sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
    return this._kids;
  }
  info() {
    if (this._info) return this._info;
    const profiles = [], rules = [];
    const cat = this.data.catOf(this.target);
    for (const p of this.target.profiles || []) profiles.push({ obj: p, via: null });
    for (const r of this.target.rules || []) rules.push({ obj: r, via: null });
    for (const il of this.target.infoLinks || []) {
      const t = this.data.resolve(il.targetId, cat);
      if (t && il.type === 'profile') profiles.push({ obj: t, via: il });
      if (t && il.type === 'rule') rules.push({ obj: t, via: il });
    }
    this._info = { profiles, rules };
    return this._info;
  }
}

export function topForceNodes(data) {
  return (data.gameSystem?.forceEntries || []).map(f => new ForceNode(data, f));
}

export function findForceNode(data, id) {
  const visit = (list) => {
    for (const f of list) {
      if (f.key === id) return f;
      const hit = visit(f.childForces());
      if (hit) return hit;
    }
    return null;
  };
  return visit(topForceNodes(data));
}
