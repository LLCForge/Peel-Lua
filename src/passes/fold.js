// Sabit katlama: yalnızca literallerden, işleçlerden ve saf kütüphane çağrılarından oluşan ifadeler sandbox'taki gerçek
// Lua ile hesaplanıp literal yazılır: string.char(104,105), ("ab"):rep(2), "a".."b", table.concat({...}), "\104\105".
// Kütüphane adı (string, table, math...) dosyada local ya da küresel olarak yeniden bağlanıyorsa o kütüphaneye dokunulmaz.
import { tryParse, walk, span, applyEdits, luaLiteral } from '../core/lua.js';
import { analyze } from '../core/scope.js';

export const id = 'fold';
export const needsSandbox = true;

const PURE = {
  string: new Set(['char', 'byte', 'rep', 'sub', 'reverse', 'upper', 'lower', 'format', 'len', 'gsub', 'find', 'match']),
  table: new Set(['concat']),
  math: new Set(['floor', 'ceil', 'abs', 'max', 'min', 'fmod', 'modf', 'sqrt', 'pow', 'huge', 'pi', 'tointeger']),
  bit32: new Set(['bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift', 'arshift', 'lrotate', 'rrotate', 'extract']),
  bit: new Set(['bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift', 'arshift', 'tobit', 'tohex']),
  utf8: new Set(['char']),
};
const GLOBAL_FNS = new Set(['tonumber', 'tostring', 'select']);
const STRING_METHODS = PURE.string;
const OPS = new Set(['..', '+', '-', '*', '/', '%', '^', '//', '==', '~=', '<', '>', '<=', '>=', '&', '|', '~', '<<', '>>', 'and', 'or', 'not', '#']);
const MAX_LITERAL = 1_000_000;

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const { decls, globals } = analyze(ast);
  // yeniden bağlanan kütüphane adları
  const shadowed = new Set(decls.map((d) => d.name));
  for (const [name, g] of globals) if (g.writes.length) shadowed.add(name);

  const isLit = (n) => ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NilLiteral'].includes(n?.type);
  function isConst(n) {
    if (!n) return false;
    switch (n.type) {
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NilLiteral': return true;
      case 'BinaryExpression': case 'LogicalExpression': return OPS.has(n.operator) && isConst(n.left) && isConst(n.right);
      case 'UnaryExpression': return OPS.has(n.operator) && isConst(n.argument);
      case 'TableConstructorExpression': return n.fields.every((f) => f.type === 'TableValue' && isConst(f.value));
      case 'MemberExpression': return n.base.type === 'Identifier' && !shadowed.has(n.base.name) && PURE[n.base.name]?.has(n.identifier.name) && n.indexer === '.';
      case 'CallExpression': case 'StringCallExpression': {
        const args = n.type === 'CallExpression' ? n.arguments : [n.argument];
        if (!args.every(isConst)) return false;
        const b = n.base;
        if (b.type === 'Identifier') return GLOBAL_FNS.has(b.name) && !shadowed.has(b.name);
        if (b.type === 'MemberExpression' && b.indexer === '.') return isConst(b) && (b.base.name !== 'table' || args[0]?.type === 'TableConstructorExpression');
        // ("x"):rep(2) — dizge literali üzerinde yöntem
        if (b.type === 'MemberExpression' && b.indexer === ':') return isLit(b.base) && b.base.type === 'StringLiteral' && STRING_METHODS.has(b.identifier.name) && !shadowed.has('string');
        return false;
      }
      default: return false;
    }
  }
  // zaten okunur literal mi? (kaçışlı dizgeler okunur hâle getirilir)
  const plain = (n) => n.type !== 'StringLiteral' || !/\\\d|\\x|\\u\{/.test(n.raw ?? '');

  const targets = [];
  walk(ast, (n, parent, key) => {
    if (!isConst(n)) return true;
    if (n.type === 'TableConstructorExpression' || n.type === 'MemberExpression') return true;
    if (isLit(n) && plain(n)) return false;
    // atama hedefleri ve local adları ifade değildir
    if (key === 'variables' || key === 'identifier') return false;
    targets.push(n);
    return false;
  });
  if (!targets.length) return code;
  const results = await ctx.evaluate(targets.map((n) => code.slice(...span(n))));
  if (!results) return code;
  const edits = [];
  targets.forEach((n, i) => {
    const [ok, type, value] = results[i] ?? [];
    if (!ok || (type === 'string' && value.length > MAX_LITERAL)) return;
    const lit = luaLiteral(type, value);
    if (lit === null) return;
    const [start, end] = span(n);
    if (code.slice(start, end) !== lit) edits.push({ start, end, text: lit });
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`fold: ${r.applied} sabit ifade hesaplandı`, 'info');
  ctx.bump('fold', r.applied);
  return r.code;
}
