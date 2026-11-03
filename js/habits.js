// Personal habits, learned only from this browser's saved lists and presets.
// Nothing here ranks units by strength: it only notices what you tend to take.

const unitId = (catalogueId, sel) => catalogueId + '|' + sel.path[0];

// How much a saved preset counts, compared with one unit in a saved list.
const UNIT_PRESET_WEIGHT = 3;
const DETACHMENT_PRESET_WEIGHT = 2;

// Canonical description of the choices under a selection (ignores ids).
export function loadoutSig(raw) {
  const kids = (raw.selections || []).map(c => ({ p: c.path.join('/'), n: c.number ?? 1, c: loadoutSig(c) }));
  kids.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : a.n - b.n));
  return JSON.stringify(kids);
}

// Every option chain picked somewhere under a unit, e.g. "groupKey/entryKey>childKey".
function optionChains(raw, prefix = '', out = new Set()) {
  for (const c of raw.selections || []) {
    const chain = (prefix ? prefix + '>' : '') + c.path.join('/');
    out.add(chain);
    optionChains(c, chain, out);
  }
  return out;
}

export function buildHabits(lists, excludeId, presets = []) {
  const freq = new Map();        // unit -> lists containing it
  const cooc = new Map();        // unit -> Map(other unit -> weight of lists/presets with both)
  const loadouts = new Map();    // unit -> Map(sig -> {count, selections, preset})
  const optCount = new Map();    // unit -> Map(option chain -> weighted builds with it)
  const instances = new Map();   // unit -> weighted builds
  const presetUnits = new Map(); // unit -> preset name
  const names = new Map();
  let listCount = 0;

  const addBuild = (id, s, w, presetName) => {
    if (s.name) names.set(id, s.name);
    instances.set(id, (instances.get(id) || 0) + w);
    const sig = loadoutSig(s);
    if (!loadouts.has(id)) loadouts.set(id, new Map());
    const lm = loadouts.get(id);
    if (!lm.has(sig)) lm.set(sig, { count: 0, selections: s.selections || [], preset: null });
    const e = lm.get(sig);
    e.count += w;
    if (presetName && !e.preset) e.preset = presetName;
    if (!optCount.has(id)) optCount.set(id, new Map());
    const om = optCount.get(id);
    for (const ch of optionChains(s)) om.set(ch, (om.get(ch) || 0) + w);
  };
  const addPairs = (ids, w) => {
    for (const a of ids) {
      if (!cooc.has(a)) cooc.set(a, new Map());
      for (const b of ids) if (a !== b) cooc.get(a).set(b, (cooc.get(a).get(b) || 0) + w);
    }
  };

  for (const l of lists) {
    if (l.id === excludeId) continue;
    listCount++;
    const present = new Set();
    const walkForce = (f, top) => {
      // Army configuration (Allegiance, Rite of War…) sits in a top-level force
      // that holds detachments; it says nothing about which units you like.
      const isConfig = top && (f.forces || []).length > 0;
      if (!isConfig) {
        for (const s of f.selections || []) {
          const id = unitId(f.catalogueId || l.catalogueId, s);
          present.add(id);
          addBuild(id, s, 1, null);
        }
      }
      (f.forces || []).forEach(cf => walkForce(cf, false));
    };
    (l.forces || []).forEach(f => walkForce(f, true));
    for (const a of present) freq.set(a, (freq.get(a) || 0) + 1);
    addPairs(present, 1);
  }

  for (const p of presets) {
    if (p.kind === 'unit') {
      const id = p.catalogueId + '|' + p.key;
      presetUnits.set(id, p.name);
      addBuild(id, p.raw, UNIT_PRESET_WEIGHT, p.name);
    } else if (p.kind === 'detachment') {
      const ids = new Set();
      for (const s of p.raw.selections || []) {
        const id = p.catalogueId + '|' + s.path[0];
        ids.add(id);
        if (!presetUnits.has(id)) presetUnits.set(id, p.name);
        addBuild(id, s, DETACHMENT_PRESET_WEIGHT, p.name);
      }
      addPairs(ids, DETACHMENT_PRESET_WEIGHT);
    }
  }
  return { freq, cooc, loadouts, optCount, instances, presetUnits, names, listCount };
}

// Units to suggest for a force, given the units the current list already holds.
// candidates: [{ id, key, ... }] eligible here. Returns up to `limit` with a reason.
export function suggestUnits(h, currentIds, candidates, limit = 5) {
  const out = [];
  for (const c of candidates) {
    if (currentIds.includes(c.id) && !h.freq.get(c.id)) continue;
    const f = h.freq.get(c.id) || 0;
    const preset = h.presetUnits.get(c.id);
    let best = null, score = 0;
    for (const a of currentIds) {
      const both = h.cooc.get(a)?.get(c.id) || 0;
      const base = (h.freq.get(a) || 0) + (h.presetUnits.has(a) ? 1 : 0);
      if (!both || !base) continue;
      const p = Math.min(1, both / base);
      score += p;
      if (!best || p > best.p) best = { p, both, base, a };
    }
    if (!currentIds.length) score = f / Math.max(1, h.listCount);
    if (preset) score += 1;
    // Need some real evidence: a preset, a repeated pairing, or a unit you take often.
    if (!preset && !(best && best.both >= 2) && !(!currentIds.length && f >= 2)) continue;
    let reason;
    if (best && best.both >= 2) reason = `Often taken with ${h.names.get(best.a) || 'a unit in this list'}`;
    else if (preset) reason = `Saved in your preset “${preset}”`;
    else reason = `In ${f} of your ${h.listCount} lists`;
    out.push({ ...c, score, reason });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// Your most-used loadout for a unit: a preset counts as several builds, so a
// single preset is enough; otherwise it needs two matching builds.
export function usualLoadout(h, id) {
  const lm = h.loadouts.get(id);
  if (!lm) return null;
  let best = null;
  for (const v of lm.values()) if (!best || v.count > best.count) best = v;
  return best && best.count >= 2 ? best : null;
}

// Option chains you take in most builds of this unit.
export function usualOptions(h, id) {
  const n = h.instances.get(id) || 0;
  const om = h.optCount.get(id);
  const out = new Set();
  if (!om || n < 2) return out;
  for (const [ch, k] of om) if (k / n > 0.5) out.add(ch);
  return out;
}

export { unitId };
