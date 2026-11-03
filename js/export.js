// Plain-text army list, for pasting into chats or tournament forms.
import { POINTS_ID } from './config.js';

export function rosterText(r) {
  const lines = [];
  const limit = r.raw.limits?.[POINTS_ID];
  const faction = r.data.catalogueName(r.raw.catalogueId);
  lines.push(`${r.raw.name} — ${faction} — ${r.total()}${limit > 0 ? ' / ' + limit : ''} pts`);
  const optionText = (sel) => {
    const parts = [];
    const walk = (s, depth) => {
      for (const c of s.children) {
        const st = r.selState(c);
        if (st.hidden && !r.selTotal(c, POINTS_ID)) continue;
        const n = c.number > 1 ? `${c.number}× ` : '';
        if (c.node.type === 'model') {
          const inner = [];
          for (const g of c.children) {
            const gs = r.selState(g);
            inner.push((g.number > 1 ? g.number + '× ' : '') + gs.name);
          }
          parts.push(`${n}${st.name}${inner.length ? ' (' + inner.join(', ') + ')' : ''}`);
        } else {
          parts.push(`${n}${st.name}`);
          if (depth < 3) walk(c, depth + 1);
        }
      }
    };
    walk(sel, 0);
    return parts;
  };
  const force = (f, depth) => {
    const pts = r.forceTotal(f);
    lines.push('');
    lines.push(`${depth ? '--' : '=='} ${f.name}${f.catalogueId !== r.raw.catalogueId ? ' (' + r.data.catalogueName(f.catalogueId) + ')' : ''} [${pts} pts] ${depth ? '--' : '=='}`);
    for (const s of f.sels) {
      const st = r.selState(s);
      const cost = r.selTotal(s, POINTS_ID);
      lines.push(`${s.number > 1 ? s.number + '× ' : ''}${st.name} [${cost}]`);
      const opts = optionText(s);
      if (opts.length) lines.push('    ' + opts.join(', '));
    }
    for (const cf of f.forces) force(cf, depth + 1);
  };
  for (const f of r.root.forces) force(f, 0);
  return lines.join('\n');
}
