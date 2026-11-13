// (function(...) KOD end)() deyimi → do KOD end. Güvenli olduğu durumlar: argüman yok, KOD'un üst düzeyinde return ve
// ... (vararg) yok (do bloğunda return dıştaki fonksiyondan döner, ... dıştakinin argümanlarına bakar).
import { tryParse, walk, applyEdits, continuedStarts } from '../core/lua.js';

export const id = 'iife';

function topLevelUses(body, test) {
  let hit = false;
  walk(body, (n) => {
    if (n.type === 'FunctionDeclaration') return false;
    if (test(n)) hit = true;
    return !hit;
  });
  return hit;
}

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const edits = [];
  const cont = continuedStarts(ast);
  walk(ast, (n) => {
    // üst düzeyinde local bildirimi olmayan do bloğunun kapsam etkisi yoktur: açılır
    if (n.type === 'DoStatement' && !n.body.some((s) => s.type === 'LocalStatement' || (s.type === 'FunctionDeclaration' && s.isLocal) || s.type === 'LabelStatement' || s.type === 'ReturnStatement' || s.type === 'BreakStatement')) {
      const body = n.body.length ? code.slice(n.body[0].range[0], n.body.at(-1).range[1]) : '';
      edits.push({ start: n.range[0], end: n.range[1], text: cont.has(n.range[0]) && body.startsWith('(') ? `;${body}` : body });
      return false;
    }
    if (n.type !== 'CallStatement') return true;
    const call = n.expression;
    const fn = call?.base;
    if (call?.type !== 'CallExpression' || call.arguments.length || fn?.type !== 'FunctionDeclaration' || fn.identifier) return true;
    if (fn.parameters.some((p) => p.type !== 'VarargLiteral')) return true;
    if (topLevelUses(fn.body, (x) => x.type === 'ReturnStatement' || x.type === 'VarargLiteral' || x.type === 'GotoStatement' || x.type === 'BreakStatement')) return true;
    const body = fn.body.length ? code.slice(fn.body[0].range[0], fn.body.at(-1).range[1]) : '';
    edits.push({ start: n.range[0], end: n.range[1], text: body ? `do\n${body}\nend` : '' });
    return false;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`iife: ${r.applied} satır içi fonksiyon bloğa açıldı`, 'info');
  ctx.bump('iife', r.applied);
  return r.code;
}
