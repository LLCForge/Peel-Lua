// Kullanılmayan kod (canlılık analizi). Açılan katmanlardan ve çözülen dizgelerden sonra açıcı kod, kendini besleyen
// değişkenler, döngüler ve artık çağrılmayan çözücüler kalır:
//   local s = ""; for _, b in ipairs({...}) do s = s .. string.char(b) end
//   local p, L do local m = {} ... L = setmetatable({}, {...}) function p(s, k) ... end end
// Aday deyimler: saf başlangıçlı local bildirimi, local'e saf atama, kaçmayan taze tabloya indeksli yazma
// (t[k] = v, table.insert/remove(t, ...)), gövdesi yalnızca adaylardan oluşan saf kaynaklı döngü (for, while, repeat)
// ve do bloğu, local'e atanan fonksiyon tanımı. Aday dışındaki her okuma bildirimi canlı yapar; canlı bildirime yazan
// aday canlıdır ve okuduklarını canlı yapar (sabit nokta). Kalan adaylar silinir.
// Local'lere yalnızca debug kütüphanesi dolaylı erişebilir: debug kullanılıyorsa dokunulmaz.
import { tryParse, walk, applyEdits } from '../core/lua.js';
import { analyze, bind } from '../core/scope.js';
import { deadRegions } from '../core/regions.js';

export const id = 'unused';

const PURE_LIB = {
  string: new Set(['char', 'byte', 'rep', 'sub', 'reverse', 'upper', 'lower', 'format', 'len']),
  table: new Set(['concat', 'unpack']),
  // math.random yalnızca rastgele durumunu ilerletir; gözlenebilir farkı davranış doğrulaması yakalar
  math: new Set(['floor', 'ceil', 'abs', 'max', 'min', 'fmod', 'modf', 'random']),
  bit32: new Set(['bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift']),
  bit: new Set(['bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift']),
};
// ilk argümanı (taze, kaçmayan local tablo) değiştiren kütüphane fonksiyonları
const MUTATE = { table: new Set(['insert', 'remove']) };

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const { decls, globals } = analyze(ast);
  if (globals.has('debug')) return code;
  const declOf = new Map();
  for (const d of decls) {
    declOf.set(d.id, d);
    for (const r of d.reads) declOf.set(r, d);
    for (const w of d.writes) declOf.set(w, d);
  }
  const libSafe = (name) => !decls.some((d) => d.name === name) && !(globals.get(name)?.writes.length);
  const libCall = (b, table) => b.type === 'MemberExpression' && b.indexer === '.' && b.base.type === 'Identifier' && table[b.base.name]?.has(b.identifier.name) && libSafe(b.base.name);

  // kaçmayan taze tablo: { } ile başlatılmış, başka yazma yok; her okuması indeks tabanı, # işleneni ya da
  // table.insert/remove/concat/unpack, ipairs/pairs argümanı (takma ad yok: içeriğine yalnızca bu adla erişilir)
  const parent = new Map();
  walk(ast, (n, p, key) => { parent.set(n, { p, key }); return true; });
  const fresh = new Map();
  const isFresh = (d) => {
    if (!d) return false;
    if (fresh.has(d)) return fresh.get(d);
    let ok = d.kind === 'local' && d.init?.type === 'TableConstructorExpression' && !d.writes.length;
    if (ok) {
      ok = d.reads.every((r) => {
        const { p, key } = parent.get(r) ?? {};
        if (!p) return false;
        if ((p.type === 'IndexExpression' || p.type === 'MemberExpression') && key === 'base') return true;
        if (p.type === 'UnaryExpression' && p.operator === '#') return true;
        if (p.type === 'CallExpression' && key === 'arguments' && p.arguments[0] === r) {
          if (libCall(p.base, { table: new Set(['insert', 'remove', 'concat', 'unpack']) })) return true;
          if (p.base.type === 'Identifier' && ['ipairs', 'pairs'].includes(p.base.name) && libSafe(p.base.name)) return true;
        }
        return false;
      });
    }
    fresh.set(d, ok);
    return ok;
  };
  // fonksiyon gövdesinin okuduğu bildirimler (canlı fonksiyonun upvalue'ları canlı kalmalı)
  const bodyReads = (fn, reads) => walk(fn, (n) => { if (n.type === 'Identifier') { const d = declOf.get(n); if (d) reads.add(d); } return true; });

  // yan etkisiz ifade; okuduğu local bildirimleri reads kümesine, değiştirdiği taze tabloları writes kümesine eklenir
  function pure(n, reads, writes) {
    if (!n) return true;
    switch (n.type) {
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NilLiteral': case 'VarargLiteral':
        return true;
      case 'FunctionDeclaration': bodyReads(n, reads); return true;
      case 'Identifier': { const d = declOf.get(n); if (d) reads.add(d); return true; }
      case 'TableConstructorExpression': return n.fields.every((f) => (f.type !== 'TableKey' || pure(f.key, reads, writes)) && pure(f.value, reads, writes));
      case 'IndexExpression': return pure(n.base, reads, writes) && pure(n.index, reads, writes) && n.base.type !== 'CallExpression';
      // kütüphane alanı okuma (string.char): kütüphane yeniden bağlanmamışsa yan etkisiz
      case 'MemberExpression': return n.indexer === '.' && n.base.type === 'Identifier' && Boolean(PURE_LIB[n.base.name]) && libSafe(n.base.name);
      case 'BinaryExpression':
        // tablo üzerindeki işlem metamethod çağırabilir: yalnızca local/literal işlenenler
        return ['..', '+', '-', '*', '/', '%', '^', '==', '~=', '<', '>', '<=', '>='].includes(n.operator) && pure(n.left, reads, writes) && pure(n.right, reads, writes);
      case 'LogicalExpression': return pure(n.left, reads, writes) && pure(n.right, reads, writes);
      case 'UnaryExpression': return pure(n.argument, reads, writes);
      case 'CallExpression': {
        const b = n.base;
        const glob = b.type === 'Identifier' && ['tostring', 'tonumber', 'ipairs', 'pairs', 'select', 'type'].includes(b.name) && libSafe(b.name);
        // setmetatable({...}, {...}): taze tablo; __gc sonlandırıcı kaydeder, saf sayılmaz
        const meta = b.type === 'Identifier' && b.name === 'setmetatable' && libSafe(b.name) && n.arguments.length === 2
          && n.arguments.every((a) => a.type === 'TableConstructorExpression')
          && !n.arguments[1].fields.some((f) => f.type === 'TableKeyString' && f.key.name === '__gc');
        if (libCall(b, MUTATE)) {
          const t = n.arguments[0];
          if (!(t?.type === 'Identifier' && isFresh(declOf.get(t)))) return false;
          writes.add(declOf.get(t));
          reads.add(declOf.get(t));
          return n.arguments.slice(1).every((a) => pure(a, reads, writes));
        }
        return Boolean(libCall(b, PURE_LIB) || glob || meta) && n.arguments.every((a) => pure(a, reads, writes));
      }
      default: return false;
    }
  }

  const block = (body, reads, writes) => {
    for (const b of body) {
      const c = candidate(b);
      if (!c) return false;
      c.writes.forEach((w) => writes.add(w));
      c.reads.forEach((r) => reads.add(r));
    }
    return true;
  };

  // aday: { node, writes:Set<decl>, reads:Set<decl> } ya da null
  function candidate(s) {
    const reads = new Set();
    const writes = new Set();
    const done = () => ({ node: s, writes, reads });
    if (s.type === 'LocalStatement') {
      if (!s.init.every((e) => pure(e, reads, writes))) return null;
      s.variables.forEach((v) => writes.add(declOf.get(v)));
      return done();
    }
    if (s.type === 'AssignmentStatement') {
      if (!s.init.every((e) => pure(e, reads, writes))) return null;
      for (const v of s.variables) {
        if (v.type === 'Identifier' && declOf.get(v)) { writes.add(declOf.get(v)); continue; }
        // t[k] = v / t.k = v: kaçmayan taze tabloya yazma
        const t = v.base;
        if ((v.type === 'IndexExpression' || v.type === 'MemberExpression') && t?.type === 'Identifier' && isFresh(declOf.get(t))) {
          if (v.type === 'IndexExpression' && !pure(v.index, reads, writes)) return null;
          writes.add(declOf.get(t));
          reads.add(declOf.get(t));
          continue;
        }
        return null;
      }
      return done();
    }
    if (s.type === 'FunctionDeclaration' && s.identifier?.type === 'Identifier' && declOf.get(s.identifier)) {
      // local function f / function f (f local): local'e fonksiyon değeri atama
      writes.add(declOf.get(s.identifier));
      bodyReads({ type: 'Chunk', body: s.body }, reads);
      return done();
    }
    if (s.type === 'ForNumericStatement' || s.type === 'ForGenericStatement') {
      const heads = s.type === 'ForNumericStatement' ? [s.start, s.end, s.step].filter(Boolean) : s.iterators;
      if (!heads.every((e) => pure(e, reads, writes))) return null;
      // sabit uzunlukta kaynak: ipairs/pairs(tablo) ya da sayısal aralık (bitmeyen döngü silinmez)
      if (s.type === 'ForGenericStatement' && !(s.iterators.length === 1 && s.iterators[0].type === 'CallExpression' && ['ipairs', 'pairs'].includes(s.iterators[0].base.name))) return null;
      return block(s.body, reads, writes) ? { ...done(), loop: true } : null;
    }
    // while/repeat: koşul ve gövde saf; temel çalıştırmada döngü bitmişti (bitmeseydi zaman aşımı olurdu)
    if (s.type === 'WhileStatement' || s.type === 'RepeatStatement') {
      if (!pure(s.condition, reads, writes)) return null;
      return block(s.body, reads, writes) ? { ...done(), loop: true } : null;
    }
    if (s.type === 'DoStatement') return block(s.body, reads, writes) ? done() : null;
    return null;
  }

  const cands = [];
  walk(ast, (n) => {
    const list = n.type === 'Chunk' ? n.body : Array.isArray(n.body) ? n.body : null;
    if (n.type === 'IfStatement') for (const c of n.clauses) for (const s of c.body) { const x = candidate(s); if (x) cands.push(x); }
    if (list) for (const s of list) { const x = candidate(s); if (x) cands.push(x); }
    return true;
  });
  if (!cands.length) return regions(code, ast, ctx);
  const inCand = (node) => cands.some((c) => node.range[0] >= c.node.range[0] && node.range[1] <= c.node.range[1]);
  const live = new Set();
  for (const d of decls) {
    if (d.reads.some((r) => !inCand(r))) live.add(d);
    // parametre, for değişkeni gibi aday dışında yazılanlar zaten aday değil; yalnızca local'ler silinebilir
    if (d.kind !== 'local' && d.kind !== 'localfunction') live.add(d);
  }
  const alive = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cands) {
      if (alive.has(c)) continue;
      if ([...c.writes].some((w) => !w || live.has(w))) {
        alive.add(c);
        c.reads.forEach((r) => live.add(r));
        grew = true;
      }
    }
  }
  const edits = [];
  for (const c of cands) {
    if (alive.has(c)) continue;
    if (cands.some((o) => o !== c && !alive.has(o) && o.node.range[0] <= c.node.range[0] && o.node.range[1] >= c.node.range[1] && o.node !== c.node)) continue;
    edits.push({ start: c.node.range[0], end: c.node.range[1], text: '' });
  }
  if (!edits.length) return regions(code, ast, ctx);
  const r = applyEdits(code, edits);
  ctx.log(`unused: ${r.applied} ölü deyim kaldırıldı`, 'info');
  ctx.bump('unused', r.applied);
  return r.code;
}

// ikinci aşama: kapalı ölü bölgeler (kurulum kodu grupları; bkz. core/regions.js)
function regions(code, ast, ctx) {
  const ranges = deadRegions(ast, bind(ast));
  if (!ranges.length) return code;
  const r = applyEdits(code, ranges.map(([start, end]) => ({ start, end, text: '' })));
  ctx.log(`unused: ${r.applied} deyimlik kapalı ölü bölge kaldırıldı`, 'info');
  ctx.bump('unused', r.applied);
  return r.code;
}
