// Çalışma anı katmanları. Kaynaktaki doğrudan load/loadstring çağrıları numaralandırılır (araçlama), kod sandbox'ta
// çalıştırılır, her sitenin yüklediği kod kaydedilir. Hep aynı kodu yükleyen site, o kodun fonksiyon hâliyle değişir:
//   loadstring(X)  →  (function(...) KOD end)
// Lua'da yüklenen chunk ...'la argüman alan bir fonksiyondur; bu dönüşüm ona eşdeğerdir. Tek fark kapsam: chunk
// küresel ortamda çalışır, satır içi fonksiyon çevredeki local'leri görür — KOD'un serbest adlarından biri sitede
// local ise site açılmaz. load(..., env) (özel ortam) da açılmaz.
import { parse, tryParse, walk, span, applyEdits, continuedStarts } from './lua.js';
import { freeNames, localsAt } from './scope.js';

const LOADERS = new Set(['loadstring', 'load']);

/** Doğrudan yükleyici çağrılarını __peel_load(N, 'ad', ...) yapar. Dönüş: { code, sites: Map<N, { range, args }> } */
export function instrument(code, version) {
  const ast = tryParse(code, version);
  if (!ast) return null;
  const local = new Set();
  walk(ast, (n) => {
    if (n.type === 'LocalStatement') n.variables.forEach((v) => local.add(v.name));
    if (n.type === 'FunctionDeclaration') n.parameters.forEach((p) => p.name && local.add(p.name));
    return true;
  });
  const edits = [];
  const sites = new Map();
  let next = 1;
  walk(ast, (n) => {
    const base = n.base;
    if (!(n.type === 'CallExpression' || n.type === 'StringCallExpression') || base?.type !== 'Identifier' || !LOADERS.has(base.name) || local.has(base.name)) return true;
    const args = n.type === 'CallExpression' ? n.arguments : [n.argument];
    if (!args.length) return true;
    const site = next++;
    const text = args.map((a) => code.slice(...span(a))).join(', ');
    edits.push({ start: n.range[0], end: n.range[1], text: `__peel_load(${site}, '${base.name}', ${text})` });
    sites.set(site, { range: n.range, args: args.length });
    return false; // iç içe yükleyiciler sonraki turda (kod dıştaki çağrıyla değişmiş olur)
  });
  return { code: applyEdits(code, edits).code, sites };
}

/** @returns {{ code, opened, kept: string[] }} */
export function expandLayers(code, version, sites, loads) {
  const ast = tryParse(code, version);
  if (!ast) return { code, opened: 0, kept: [] };
  const bySite = new Map();
  for (const l of loads) {
    if (!l.site) continue;
    if (!bySite.has(l.site)) bySite.set(l.site, []);
    bySite.get(l.site).push(l.code);
  }
  const edits = [];
  const kept = [];
  const cont = continuedStarts(ast);
  for (const [site, info] of sites) {
    const payloads = bySite.get(site);
    if (!payloads?.length) continue;
    const unique = new Set(payloads);
    if (unique.size !== 1) { kept.push(`${site}: ${unique.size} farklı kod`); continue; }
    if (info.args >= 4) { kept.push(`${site}: özel ortam (env)`); continue; }
    const payload = payloads[0];
    // ikili chunk (string.dump) kaynak değildir
    if (payload.startsWith('\x1bLua')) { kept.push(`${site}: bytecode`); continue; }
    const inner = tryParse(payload, version);
    if (!inner) { kept.push(`${site}: yüklenen kod ayrıştırılamadı`); continue; }
    const free = freeNames(inner);
    const locals = localsAt(ast, info.range[0]);
    const clash = [...free].find((n) => locals.has(n));
    if (clash) { kept.push(`${site}: '${clash}' sitede local`); continue; }
    edits.push({ start: info.range[0], end: info.range[1], text: `${cont.has(info.range[0]) ? ';' : ''}(function(...)\n${payload}\nend)` });
  }
  if (!edits.length) return { code, opened: 0, kept };
  const r = applyEdits(code, edits);
  return { code: r.code, opened: r.applied, kept };
}

export { parse };
