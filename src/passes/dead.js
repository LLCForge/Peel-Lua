// Ölü dallar: koşulu literal olan if/elseif/else ve while. Lua'da yalnızca nil ve false yanlıştır (0 ve "" doğrudur).
import { tryParse, walk, applyEdits } from '../core/lua.js';

export const id = 'dead';

const truth = (c) => {
  if (!c) return true; // else
  if (c.type === 'BooleanLiteral') return c.value;
  if (c.type === 'NilLiteral') return false;
  if (c.type === 'NumericLiteral' || c.type === 'StringLiteral') return true;
  return undefined;
};

const bodyText = (code, body) => (body.length ? code.slice(body[0].range[0], body.at(-1).range[1]) : '');

export async function run(code, ctx) {
  const ast = tryParse(code, ctx.version);
  if (!ast) return code;
  const edits = [];
  walk(ast, (n) => {
    if (n.type === 'IfStatement') {
      // baştan itibaren yanlış koşullu dallar atılır; ilk kesin doğru dal seçilir; belirsiz dal görülünce durulur
      for (const c of n.clauses) {
        const t = truth(c.condition);
        if (t === false) continue;
        if (t === true) {
          const body = bodyText(code, c.body);
          edits.push({ start: n.range[0], end: n.range[1], text: body ? `do\n${body}\nend` : '' });
          return false;
        }
        break;
      }
      if (n.clauses.every((c) => truth(c.condition) === false)) { edits.push({ start: n.range[0], end: n.range[1], text: '' }); return false; }
      return true;
    }
    if (n.type === 'WhileStatement' && truth(n.condition) === false) {
      edits.push({ start: n.range[0], end: n.range[1], text: '' });
      return false;
    }
    return true;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`dead: ${r.applied} sabit koşullu dal sadeleştirildi`, 'info');
  ctx.bump('dead', r.applied);
  return r.code;
}
