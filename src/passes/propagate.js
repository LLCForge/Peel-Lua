// Sabit ve takma ad yayılımı: bir kez bildirilen, hiç yeniden atanmayan local'in okumaları değeriyle değişir.
//   local s = "abc"        → okumalar "abc"
//   local ls = loadstring  → ls(x) → loadstring(x)   (yeniden bağlanmamış küresel yerleşik fonksiyon)
//   local sc = string.char → sc(104) → string.char(104)
// Kapsam dinamikse (getfenv/setfenv/_G/_ENV/debug) hiçbir şeye dokunulmaz.
import { tryParse, span, applyEdits } from '../core/lua.js';
import { analyze } from '../core/scope.js';

export const id = 'propagate';

const BUILTINS = new Set(['loadstring', 'load', 'string', 'table', 'math', 'tonumber', 'tostring', 'select', 'pairs', 'ipairs',
  'next', 'type', 'unpack', 'pcall', 'xpcall', 'error', 'assert', 'print', 'rawget', 'rawset', 'setmetatable', 'getmetatable',
  'bit32', 'bit', 'utf8', 'coroutine', 'os', 'io', 'require', 'dofile', 'getfenv', 'setfenv']);
const LIBS = new Set(['string', 'table', 'math', 'bit32', 'bit', 'utf8', 'coroutine', 'os', 'io']);
const MAX = 200_000;

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const { decls, globals, dynamic } = analyze(ast);
  if (dynamic) return code;
  const rebound = (name) => (globals.get(name)?.writes.length ?? 0) > 0;
  const edits = [];
  let n = 0;
  for (const d of decls) {
    if (d.kind !== 'local' || d.writes.length || !d.reads.length || !d.init) continue;
    const v = d.init;
    let text = null;
    if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NilLiteral'].includes(v.type)) text = code.slice(...span(v));
    else if (v.type === 'Identifier' && BUILTINS.has(v.name) && !rebound(v.name) && !decls.some((x) => x.name === v.name && x !== d)) text = v.name;
    else if (v.type === 'MemberExpression' && v.indexer === '.' && v.base.type === 'Identifier' && LIBS.has(v.base.name) && !rebound(v.base.name) && !decls.some((x) => x.name === v.base.name)) text = code.slice(...span(v));
    if (text === null || text.length > MAX) continue;
    // çok satırlı yerleşim: StringLiteral ham metni ([[...]] dahil) olduğu gibi kopyalanır
    const isLit = v.type === 'StringLiteral' || v.type === 'NumericLiteral';
    for (const r of d.reads) {
      // literal yöntem/indeks/çağrı tabanı olamaz ("abc":upper() geçersiz): ardından : . [ ( " { geliyorsa parantez
      const after = code.slice(r.range[1]).match(/^\s*(.)/)?.[1];
      const wrap = isLit && (/[:.[("'{]/.test(after ?? '') || text.startsWith('-')) ? `(${text})` : text;
      edits.push({ start: r.range[0], end: r.range[1], text: wrap });
      n++;
    }
  }
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`propagate: ${n} okuma değeriyle değişti`, 'info');
  ctx.bump('propagate', n);
  return r.code;
}
