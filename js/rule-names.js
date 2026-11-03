// Matching rule names as written on weapons to the rule that defines them.
// Special rules are universal: "Breaching (5+)" is Breaching (X). The data also
// has small spelling slips, handled here so the right rule is still found.

// Known slips in the data, by normalised name.
const ALIASES = {
  'duelists edge': 'duellists edge',
  'poison': 'poisoned',
  'critical hits': 'critical hit',
};

// "Duellist’s Edge (1)" -> "duellists edge"; also copes with a missing ")".
export function ruleKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/\s*\([^)]*\)?\s*$/, '')
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keys to try, most specific first.
export function ruleKeys(name) {
  const k = ruleKey(name);
  const out = [k];
  if (ALIASES[k]) out.push(ALIASES[k]);
  if (k.endsWith('s')) out.push(k.slice(0, -1));
  return out;
}

// Split "Heavy (FP), Blast (3\"), Breaching (5+)" into rules; commas inside brackets
// stay put, and "Shred (4+) Reaping Blow" (missing comma) still splits in two.
export function splitRules(text) {
  const out = [];
  let depth = 0, cur = '';
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      cur += ch;
      if (depth === 0 && /^\s+[A-Z]/.test(s.slice(i + 1))) { out.push(cur.trim()); cur = ''; }
      continue;
    }
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
