// Kapalı ölü bölgeler: obfuscator kurulum kodu (sabit dizisi, karıştırma döngüsü, çözücü tabloları) çoğu kez
// yalnızca kendi local'lerine dokunan bir deyim grubudur. Bir local'den başlanır; aynı bloktaki ona başvuran deyimler
// bölgeye eklenir, bu deyimlerin başvurduğu aynı bloktaki local'ler gruba katılır (sabit nokta). Bölge silinebilir:
//  - grubun her başvurusu bölgede (bölge dışından okunmuyor),
//  - bölge yalnızca zararsız küresellere dokunuyor (string, math, table... ; print/os/io/load/getfenv yok),
//  - bölgedeki her local başvurusu grup üyesine ya da bölgede bildirilmiş local'e (dışarıda kullanılmayan),
//  - grubun her üyesi bloğun deyimiyle bildirilmiş local.
// Bölge çalışırken yalnızca kendi tablolarını değiştirir; silinmesi gözlenebilir bir şeyi değiştirmez (hata ya da
// sonsuz döngü dışında: onları hattın davranış doğrulaması yakalar).
import { walk } from './lua.js';

export const SAFE_GLOBALS = new Set(['string', 'math', 'table', 'bit32', 'bit', 'utf8', 'select', 'type', 'tonumber', 'tostring',
  'ipairs', 'pairs', 'next', 'unpack', 'setmetatable', 'getmetatable', 'rawequal', 'rawlen', 'error', 'assert', 'pcall', 'newproxy']);

const inside = (n, r) => Boolean(n.range) && n.range[0] >= r[0] && n.range[1] <= r[1];
const MAX_GROUP = 200;
const LOOPS = new Set(['WhileStatement', 'RepeatStatement', 'ForNumericStatement', 'ForGenericStatement']);

// deyim akışı dışarı taşıyor mu: iç fonksiyonda olmayan return/goto/etiket, kendi döngüsü dışında break
function escapesFlow(s) {
  let bad = false;
  const visit = (n, inLoop) => {
    if (bad || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, inLoop)); return; }
    if (n.type === 'FunctionDeclaration' && n !== s) return;
    if (n.type === 'ReturnStatement' || n.type === 'GotoStatement' || n.type === 'LabelStatement') { bad = true; return; }
    if (n.type === 'BreakStatement' && !inLoop) { bad = true; return; }
    const loop = inLoop || LOOPS.has(n.type);
    for (const k of Object.keys(n)) if (k !== 'range' && n[k] && typeof n[k] === 'object') visit(n[k], loop);
  };
  if (s.type === 'FunctionDeclaration') return false;
  visit(s, false);
  return bad;
}

/** @param b scope.bind sonucu. Dönüş: silinecek aralıklar [[start, end], ...] */
export function deadRegions(ast, b) {
  const written = new Set([...b.globals].filter(([, g]) => g.writes.length).map(([n]) => n));
  const dirty = [];
  for (const [node, name] of b.globalOf) if (node.range && (!SAFE_GLOBALS.has(name) || written.has(name))) dirty.push(node.range[0]);
  dirty.sort((x, y) => x - y);
  const hasDirty = (r) => {
    let lo = 0;
    let hi = dirty.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dirty[m] < r[0]) lo = m + 1; else hi = m; }
    return lo < dirty.length && dirty[lo] < r[1];
  };
  const parent = new Map();
  const bodyOf = new Map();
  walk(ast, (n, p) => {
    parent.set(n, p);
    const lists = n.type === 'IfStatement' ? n.clauses.map((c) => c.body) : Array.isArray(n.body) ? [n.body] : [];
    for (const list of lists) for (const s of list) { parent.set(s, n); bodyOf.set(s, list); }
    return true;
  });
  const refsOf = (u) => [u.id, ...u.reads, ...u.writes].filter((r) => r.range);
  // her local'in bloktaki kapsayan deyimi
  const topIn = (node, list) => {
    let n = node;
    while (n && bodyOf.get(n) !== list) n = parent.get(n);
    return n ?? null;
  };
  // bölgedeki local başvuruları: konuma göre sıralı (aralık sorgusu için)
  const refs = [...b.declOf].filter(([n]) => n.range).sort((x, y) => x[0].range[0] - y[0].range[0]);
  const refsWithin = (r) => {
    let lo = 0;
    let hi = refs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (refs[m][0].range[0] < r[0]) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < refs.length && refs[i][0].range[0] < r[1]; i++) out.push(refs[i]);
    return out;
  };

  const out = [];
  const done = new Set();
  for (const seed of b.decls) {
    if (done.has(seed) || !['local', 'localfunction'].includes(seed.kind) || !seed.stmt) continue;
    const list = bodyOf.get(seed.stmt);
    if (!list) continue;
    const group = new Set([seed]);
    const region = new Set();
    const queue = [seed];
    let ok = true;
    while (ok && queue.length) {
      const u = queue.pop();
      for (const r of refsOf(u)) {
        const s = topIn(r, list);
        if (!s) { ok = false; break; }
        if (region.has(s)) continue;
        if (hasDirty(s.range) || escapesFlow(s)) { ok = false; break; }
        region.add(s);
        for (const [, dd] of refsWithin(s.range)) {
          if (group.has(dd)) continue;
          if (dd.id.range && inside(dd.id, s.range)) {
            // bölgede bildirilmiş: dışarıdan kullanılmamalı (yeni bölge deyimleri sonra yeniden denetlenir)
            continue;
          }
          if (!['local', 'localfunction'].includes(dd.kind) || bodyOf.get(dd.stmt) !== list || group.size >= MAX_GROUP) { ok = false; break; }
          group.add(dd);
          queue.push(dd);
        }
        if (!ok) break;
      }
    }
    if (!ok) continue;
    const ranges = [...region].map((s) => s.range);
    const inRegion = (n) => ranges.some((r) => inside(n, r));
    // bölgede bildirilen local'ler dışarıda kullanılmamalı
    for (const s of region) {
      for (const [, dd] of refsWithin(s.range)) {
        if (group.has(dd) || !dd.id.range || !inside(dd.id, s.range)) continue;
        if (refsOf(dd).some((r) => !inRegion(r))) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    group.forEach((g) => done.add(g));
    out.push(...ranges);
  }
  return out;
}
