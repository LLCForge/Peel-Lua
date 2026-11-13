// Lua ayrıştırma ve yardımcılar (luaparse). Girdi bstr'dir (her karakter bir bayt): konumlar bayt konumudur, dizge
// literallerinin değeri baytlar olarak okunur (pseudo-latin1).
import luaparse from 'luaparse';

const PARSE_VERSION = { '5.1': '5.1', '5.2': '5.2', '5.3': '5.3', '5.4': '5.3', LuaJIT: 'LuaJIT' };

export function parse(code, version = '5.1') {
  return luaparse.parse(code, {
    ranges: true, locations: false, comments: false, scope: false,
    luaVersion: PARSE_VERSION[version] ?? '5.1', encodingMode: 'pseudo-latin1',
  });
}

export function tryParse(code, version) {
  try {
    return parse(code, version);
  } catch {
    return null;
  }
}

/** Sürüm sırasıyla ayrıştırmayı dener: { ast, version } ya da null */
export function parseAny(code, versions = ['5.1', '5.3', '5.2', 'LuaJIT']) {
  for (const v of versions) {
    const ast = tryParse(code, v);
    if (ast) return { ast, version: v };
  }
  return null;
}

/** visit(node, parent, key) false dönerse alt düğümlere inilmez */
export function walk(root, visit, parent = null, key = null) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) { for (const n of root) walk(n, visit, parent, key); return; }
  if (root.type && visit(root, parent, key) === false) return;
  for (const k of Object.keys(root)) {
    if (k === 'range' || k === 'loc' || k === 'raw') continue;
    const v = root[k];
    if (v && typeof v === 'object') walk(v, visit, root, k);
  }
}

export const span = (n) => n.range;

/** Bloğun ilk deyimi olmayan deyimlerin başlangıç ofsetleri. Böyle bir yerde '(' ile başlayan kod, önceki deyimin
 *  çağrı devamı sayılır (a()\n(f)() → a()(f)()); başına ';' gerekir (5.1'de de ';' önceki deyimin ayırıcısıdır). */
export function continuedStarts(ast) {
  const out = new Set();
  walk(ast, (n) => {
    if (Array.isArray(n.body)) for (let i = 1; i < n.body.length; i++) out.add(n.body[i].range[0]);
    return true;
  });
  return out;
}

/** Deyim aralarındaki ';' işaretlerini düzenler: yalnızca '(' ile başlayan ve bloğun ilki olmayan deyimin önünde bir
 *  tane kalır. Deyim silen geçişler 5.1'de geçersiz yetim ';' bırakabilir (blok başında, art arda). 5.2 dilbilgisiyle
 *  ayrıştırılır (boş deyime izin verir); ayrıştırılamazsa kod olduğu gibi döner. */
export function fixSemicolons(code, version) {
  const ast = tryParse(code, version === '5.1' || version === 'LuaJIT' ? '5.2' : version);
  if (!ast) return code;
  const edits = [];
  walk(ast, (n) => {
    if (!Array.isArray(n.body)) return true;
    n.body.forEach((s, i) => {
      // ifadenin önündeki boşluk/';' aralığı (yorumlar aralığı keser; yorum ötesine dokunulmaz)
      let a = s.range[0];
      while (a > 0 && /[\s;]/.test(code[a - 1])) a--;
      const gap = code.slice(a, s.range[0]);
      if (!gap.includes(';')) return;
      const need = i > 0 && code[s.range[0]] === '(';
      const text = need ? `${gap.replace(/;/g, '').replace(/\s+$/, '')}\n;` : gap.replace(/;/g, '');
      if (text !== gap) edits.push({ start: a, end: s.range[0], text });
    });
    return true;
  });
  return edits.length ? applyEdits(code, edits).code : code;
}

/** Yerine yazılan metin komşu sözcüğe yapışmasın: return(5) → return5 olmaz, return 5 olur */
export function pad(code, start, end, text) {
  const word = /[\w.]/;
  let t = text;
  if (start > 0 && /\w/.test(code[start - 1]) && word.test(t[0] ?? '')) t = ` ${t}`;
  if (end < code.length && /\w/.test(code[end]) && word.test(t.at(-1) ?? '')) t = `${t} `;
  // a - -1 → a--1 yorum olur
  if (start > 0 && code[start - 1] === '-' && t[0] === '-') t = ` ${t}`;
  return t;
}

export function applyEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  let floor = Infinity;
  let applied = 0;
  for (const e of sorted) {
    if (e.end > floor) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
    applied++;
  }
  return { code: out, applied };
}

// --- Lua literalleri ---
const printable = (c) => c >= 0x20 && c < 0x7f;
function utf8Len(s, i) {
  const c = s.charCodeAt(i);
  const n = c >= 0xf0 && c < 0xf5 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 && c < 0xe0 ? 2 : 0;
  if (!n || i + n > s.length) return 0;
  for (let k = 1; k < n; k++) { const d = s.charCodeAt(i + k); if (d < 0x80 || d > 0xbf) return 0; }
  return n;
}

/** bstr → Lua dizge literali (çift tırnak; kontrol/ikili baytlar \ddd; geçerli UTF-8 okunur kalır) */
export function luaString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (printable(c)) out += ch;
    else {
      const n = c >= 0x80 ? utf8Len(s, i) : 0;
      if (n) { out += s.slice(i, i + n); i += n - 1; continue; }
      // sonraki karakter rakamsa \ddd üç haneli yazılır (\0 + "1" → \01 karışmasın)
      out += `\\${String(c).padStart(3, '0')}`;
    }
  }
  return `${out}"`;
}

/** sandbox değerlendirme sonucu → Lua literali; yazılamazsa null. Negatif sayılar parantezlenir. */
export function luaLiteral(type, value) {
  if (type === 'string') return luaString(value);
  if (type === 'boolean') return value === 'true' ? 'true' : 'false';
  if (type === 'nil') return 'nil';
  if (type === 'number' || type === 'integer') {
    if (!/^-?(\d+(\.\d+)?(e[+-]?\d+)?)$/i.test(value)) return null; // inf, nan
    let v = value;
    // %.17g tam sayıyı ondalıksız yazar: Lua 5.3+ için float olduğunu korumak gerekirse .0 eklenir
    if (type === 'number' && /^-?\d+$/.test(v) && Math.abs(Number(v)) < 2 ** 53) v = String(Number(v));
    return v.startsWith('-') ? `(${v})` : v;
  }
  return null;
}
