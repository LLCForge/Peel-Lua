// Fixture testleri: test/fixtures/*.lua.x tam hattan (sandbox + davranış doğrulaması) geçer. Fixture'lar diskte
// XOR + base64'tür (zararlı koda benzeyen örnekler antivirüsü tetiklemesin), yalnızca bellekte çözülür.
//   node test/run.js              hepsi
//   node test/run.js char-decoder tek fixture, log ve çıktısıyla
// Yönergeler Lua yorumu olarak yazılır ve denetimden önce çıktıdan ayıklanır:
//   -- EXPECT: print('hi')   çıktıda bulunmalı (boşluklar normalize edilir)
//   -- GONE: loadstring      çıktıda bulunmamalı
//   -- KEEP: HttpGet         çıktıda kalmalı (güvenlik: dış etki ve girdiye bağlı kod silinmemeli)
import { readdirSync, readFileSync } from 'node:fs';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { fromBytes } from '../src/core/bstr.js';
import { decodeFixture } from './fixture-codec.js';

const dir = new URL('./fixtures/', import.meta.url);
const filter = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith('.lua.x') && (!filter || f.includes(filter))).sort();

const DIRECTIVE = /^\s*--\s*(EXPECT|GONE|KEEP):\s*(.+)$/gm;
const directives = (src, key) => [...src.matchAll(DIRECTIVE)].filter((m) => m[1] === key).map((m) => m[2].trim());
const norm = (s) => s.replace(DIRECTIVE, '').replace(/\s+/g, ' ').trim();

const sb = createNodeSandbox();
let pass = 0;
const t0 = Date.now();
try {
  for (const f of files) {
    const buf = decodeFixture(readFileSync(new URL(f, dir), 'utf8'));
    const src = buf.toString('utf8');
    const logs = [];
    const r = await deobfuscate(fromBytes(buf), { sandbox: sb, onLog: (m, l) => logs.push(`[${l}] ${m}`) });
    const out = r.error ? '' : norm(r.code);
    const fails = [];
    if (r.error) fails.push(`hata: ${r.error}`);
    if (!r.verified) fails.push('davranış doğrulanamadı');
    for (const e of directives(src, 'EXPECT')) if (!out.includes(norm(e))) fails.push(`EXPECT yok: ${e}`);
    for (const g of directives(src, 'GONE')) if (out.includes(norm(g))) fails.push(`GONE duruyor: ${g}`);
    for (const k of directives(src, 'KEEP')) if (!out.includes(norm(k))) fails.push(`KEEP silinmiş: ${k}`);
    if (!fails.length) pass++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${f} (${r.ms ?? 0} ms)${fails.length ? `\n     ${fails.join('\n     ')}` : ''}`);
    if (filter || fails.length) {
      if (filter) console.log(logs.join('\n'));
      console.log(r.code ?? '');
    }
  }
} finally {
  sb.close();
}
console.log(`\ntoplam ${Date.now() - t0}ms | ${pass}/${files.length}`);
if (pass !== files.length) process.exitCode = 1;
