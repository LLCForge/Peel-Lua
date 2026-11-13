// Gerçek Lua obfuscator çıktılarıyla uçtan uca ölçüm (örnekler: scripts/make-bench.js ile üretilir, test/bench/*.lua.x).
//   npm run bench               hepsi
//   npm run bench vmify         adı filtreyi içerenler
//   npm run bench -- --show ad  tek örneğin girdisini ve çıktısını yazdırır (diske düz yazılmaz)
// Sütunlar: same (çözülmüş kodun sandbox stdout'u özgün kaynağınkiyle aynı mı; gizlenmiş program özgünden farklı
// yazıyorsa beklenen onunkidir: "self"), needles (özgün literallerin kaçı çıktıda), char/load/vm (kalan string.char,
// loadstring/load çağrısı ve VM dağıtıcı izi: girdi → çıktı), names (anlamsız local adı: girdi → çıktı), kb, ms.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { tryParse } from '../src/core/lua.js';
import { analyze } from '../src/core/scope.js';
import { meaningless } from '../src/passes/rename.js';
import { fromText } from '../src/core/bstr.js';
import { decodeFixture, encodeFixture } from './fixture-codec.js';
import { SOURCES } from './bench/sources.js';

const dir = new URL('./bench/', import.meta.url);
const outDir = new URL('./bench-out/', import.meta.url);
const args = process.argv.slice(2);
const show = args[0] === '--show' ? args[1] : null;
const filter = show ?? args[0];
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const names = readdirSync(dir).filter((f) => f.endsWith('.lua.x')).map((f) => f.slice(0, -6))
  .filter((n) => manifest[n] && (!filter || n.includes(filter))).sort();

// izler: kod metninden (yorumlar dahil değil; luaparse yorumları atlar ama sayım kaba bir metin sayımıdır)
const count = (code, re) => (code.match(re) ?? []).length;
const charCalls = (c) => count(c, /\bstring\s*\.\s*char\b|:char\b/g);
const loadCalls = (c) => count(c, /\b(loadstring|load)\s*\(/g);
// VM dağıtıcısı: aynı değişkenin 16'dan çok sayısal karşılaştırması (if N<=28 then if N<=14 ...)
function vmTrace(c) {
  const by = new Map();
  for (const m of c.matchAll(/\b([A-Za-z_]\w*)\s*(<=|<|==)\s*-?\d+\s*then\b/g)) by.set(m[1], (by.get(m[1]) ?? 0) + 1);
  return Math.max(0, ...by.values()) >= 16 ? 1 : 0;
}
function badNames(code) {
  const ast = tryParse(code, '5.1') ?? tryParse(code, '5.3');
  if (!ast) return NaN;
  return new Set(analyze(ast).decls.map((d) => d.name).filter(meaningless)).size;
}

const sb = createNodeSandbox();
const rows = [];
const expectCache = new Map();
mkdirSync(outDir, { recursive: true });
try {
  for (const name of names) {
    const meta = manifest[name];
    const src = SOURCES[meta.source];
    const platform = src.platform ?? null;
    const input = decodeFixture(readFileSync(new URL(`${name}.lua.x`, dir), 'utf8')).toString('latin1');
    const logs = [];
    const t0 = Date.now();
    let r;
    try {
      r = await deobfuscate(input, { sandbox: sb, platform, onLog: (m, l) => logs.push(`[${l}] ${m}`) });
    } catch (e) {
      rows.push({ name, same: 'NO', why: e.message });
      continue;
    }
    const ms = Date.now() - t0;
    if (r.error) { rows.push({ name, same: 'NO', why: r.error }); continue; }
    if (!expectCache.has(meta.source)) expectCache.set(meta.source, (await sb.run({ code: fromText(src.code), version: '5.1', platform })).stdout);
    const expected = expectCache.get(meta.source);
    const own = (await sb.run({ code: input, version: r.version, platform })).stdout;
    const got = (await sb.run({ code: r.code, version: r.version, platform })).stdout;
    const self = own !== expected;
    const found = src.needles.filter((n) => r.code.includes(n));
    rows.push({
      name,
      same: got === (self ? own : expected) ? (self ? 'self' : 'yes') : 'NO',
      needles: `${found.length}/${src.needles.length}`,
      char: `${charCalls(input)}→${charCalls(r.code)}`,
      load: `${loadCalls(input)}→${loadCalls(r.code)}`,
      vm: `${vmTrace(input)}→${vmTrace(r.code)}`,
      names: `${badNames(input)}→${badNames(r.code)}`,
      kb: `${(input.length / 1024).toFixed(1)}→${(r.code.length / 1024).toFixed(1)}`,
      ms,
      back: logs.filter((l) => l.includes('geri alındı')).length,
    });
    writeFileSync(new URL(`${name}.out.lua.x`, outDir), encodeFixture(Buffer.from(r.code, 'latin1')));
    writeFileSync(new URL(`${name}.log`, outDir), logs.join('\n'));
    if (show) {
      console.log(`---- girdi (${meta.tool} ${meta.preset})\n${input.slice(0, 6000)}\n---- log\n${logs.join('\n')}\n---- çıktı\n${r.code}`);
      if (got !== expected) console.log(`---- beklenen stdout\n${expected}\n---- çıktının stdout'u\n${got}`);
      const missing = src.needles.filter((n) => !r.code.includes(n));
      if (missing.length) console.log(`---- eksik literaller: ${missing.join(' | ')}`);
    }
  }
} finally {
  sb.close();
}
console.table(rows);
const same = rows.filter((r) => r.same === 'yes' || r.same === 'self').length;
const all = (r) => r.needles && r.needles.split('/')[0] === r.needles.split('/')[1];
console.log(`aynı davranış: ${same}/${rows.length} | tüm literaller: ${rows.filter(all).length}/${rows.length} | VM izi kalmayan: ${rows.filter((r) => r.vm?.endsWith('→0')).length}/${rows.length}`);
if (same !== rows.length) process.exitCode = 1;
