// Kullanılmayan kod (canlılık analizi). Açılan katmanlardan sonra açıcı kod, kendini besleyen değişkenler ve döngüler
// olarak kalır: local s = ""; for _, b in ipairs({...}) do s = s .. string.char(b) end
// Aday deyimler: saf başlangıçlı local bildirimi, local'e saf atama, gövdesi yalnızca adaylardan oluşan ve saf bir
// kaynak üzerinde dönen döngü, hiç başvurulmayan local function. Aday dışındaki her okuma bildirimi canlı yapar;
// canlı bildirime yazan aday canlıdır ve okuduklarını canlı yapar (sabit nokta). Kalan adaylar silinir.
// Kapsam dinamikse (getfenv/_G/debug) dokunulmaz.
import { tryParse, walk, applyEdits } from '../core/lua.js';
import { analyze } from '../core/scope.js';

export const id = 'unused';

const PURE_LIB = {
  string: new Set(['char', 'byte', 'rep', 'sub', 'reverse', 'upper', 'lower', 'format', 'len']),
  table: new Set(['concat', 'insert', 'unpack']),
  math: new Set(['floor', 'ceil', 'abs', 'max', 'min', 'fmod', 'modf']),
  bit32: new Set(['bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift']),
  bit: new Set(['bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift']),
};

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const { decls, globals, dynamic } = analyze(ast);
  if (dynamic) return code;
  const declOf = new Map();
  for (const d of decls) {
    declOf.set(d.id, d);
    for (const r of d.reads) declOf.set(r, d);
    for (const w of d.writes) declOf.set(w, d);
  }
  const libSafe = (name) => !decls.some((d) => d.name === name) && !(globals.get(name)?.writes.length);

  // yan etkisiz ifade; okuduğu local bildirimleri reads kümesine eklenir
  function pure(n, reads) {
    if (!n) return true;
    switch (n.type) {
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NilLiteral': case 'VarargLiteral': case 'FunctionDeclaration':
        return true;
      case 'Identifier': { const d = declOf.get(n); if (d) reads.add(d); return true; }
      case 'TableConstructorExpression': return n.fields.every((f) => (f.type !== 'TableKey' || pure(f.key, reads)) && pure(f.value, reads));
      case 'IndexExpression': return pure(n.base, reads) && pure(n.index, reads) && n.base.type !== 'CallExpression';
      // kütüphane alanı okuma (string.char): kütüphane yeniden bağlanmamışsa yan etkisiz
      case 'MemberExpression': return n.indexer === '.' && n.base.type === 'Identifier' && Boolean(PURE_LIB[n.base.name]) && libSafe(n.base.name);
      case 'BinaryExpression':
        // tablo üzerindeki işlem metamethod çağırabilir: yalnızca local/literal işlenenler
        return ['..', '+', '-', '*', '%', '^', '==', '~=', '<', '>', '<=', '>='].includes(n.operator) && pure(n.left, reads) && pure(n.right, reads);
      case 'UnaryExpression': return pure(n.argument, reads);
      case 'CallExpression': {
        const b = n.base;
        const lib = b.type === 'MemberExpression' && b.indexer === '.' && b.base.type === 'Identifier' && PURE_LIB[b.base.name]?.has(b.identifier.name) && libSafe(b.base.name);
        const glob = b.type === 'Identifier' && ['tostring', 'tonumber', 'ipairs', 'pairs', 'select', 'type'].includes(b.name) && libSafe(b.name);
        return Boolean(lib || glob) && n.arguments.every((a) => pure(a, reads));
      }
      default: return false;
    }
  }

  // aday: { node, writes:Set<decl>, reads:Set<decl> } ya da null
  function candidate(s) {
    const reads = new Set();
    if (s.type === 'LocalStatement') {
      if (!s.init.every((e) => pure(e, reads))) return null;
      return { node: s, writes: new Set(s.variables.map((v) => declOf.get(v))), reads };
    }
    if (s.type === 'AssignmentStatement') {
      if (!s.variables.every((v) => v.type === 'Identifier' && declOf.get(v))) return null;
      if (!s.init.every((e) => pure(e, reads))) return null;
      return { node: s, writes: new Set(s.variables.map((v) => declOf.get(v))), reads };
    }
    if (s.type === 'FunctionDeclaration' && s.isLocal && s.identifier) {
      return { node: s, writes: new Set([declOf.get(s.identifier)]), reads: new Set() };
    }
    if (s.type === 'ForNumericStatement' || s.type === 'ForGenericStatement') {
      const heads = s.type === 'ForNumericStatement' ? [s.start, s.end, s.step].filter(Boolean) : s.iterators;
      if (!heads.every((e) => pure(e, reads))) return null;
      // sabit uzunlukta kaynak: ipairs/pairs(tablo) ya da sayısal aralık (bitmeyen döngü silinmez)
      if (s.type === 'ForGenericStatement' && !(s.iterators.length === 1 && s.iterators[0].type === 'CallExpression' && ['ipairs', 'pairs'].includes(s.iterators[0].base.name))) return null;
      const writes = new Set();
      for (const b of s.body) {
        const c = candidate(b);
        if (!c) return null;
        c.writes.forEach((w) => writes.add(w));
        c.reads.forEach((r) => reads.add(r));
      }
      return { node: s, writes, reads, loop: true };
    }
    return null;
  }

  const cands = [];
  walk(ast, (n) => {
    const list = n.type === 'Chunk' ? n.body : Array.isArray(n.body) ? n.body : null;
    if (n.type === 'IfStatement') for (const c of n.clauses) for (const s of c.body) { const x = candidate(s); if (x) cands.push(x); }
    if (list) for (const s of list) { const x = candidate(s); if (x) cands.push(x); }
    return true;
  });
  if (!cands.length) return code;
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
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`unused: ${r.applied} ölü deyim kaldırıldı`, 'info');
  ctx.bump('unused', r.applied);
  return r.code;
}
