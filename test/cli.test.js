// CLI testleri: node test/cli.test.js
// Zararlı koda benzeyen örnekler diske yazılmaz: kodlu fixture bellekte çözülüp stdin'den verilir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFixture } from './fixture-codec.js';

const BIN = fileURLToPath(new URL('../bin/peel-lua.js', import.meta.url));
const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { input, timeout: 240_000 });
const fixture = (name) => decodeFixture(readFileSync(new URL(`./analyze-fixtures/${name}.lua.x`, import.meta.url), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'peel-lua-cli-'));
try {
  // kullanım ve hata çıkış kodları
  assert.equal(cli(['-h']).status, 0);
  assert.match(cli(['--help', '--lang', 'en']).stdout.toString(), /Exit codes/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['x.lua', '--lang', 'de']).status, 2);
  assert.equal(cli(['x.lua', '--fail-on', 'none']).status, 2);
  assert.equal(cli(['x.lua', '--platform', 'xbox']).status, 2);
  assert.equal(cli(['x.lua', '--only', 'layers,nope']).status, 2);
  assert.equal(cli(['x.lua', '--bogus']).status, 2);
  assert.equal(cli([join(tmp, 'yok.lua'), '-q']).status, 1);

  // toplu iş: dizin yapısı korunur, Lua dışı dosyalar atlanır, baytlar korunur
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'a', 'b'), { recursive: true });
  writeFileSync(join(src, 'a', 'b', 'x.lua'), "loadstring(\"print('hi')\")()\n");
  writeFileSync(join(src, 'top.luau'), "print('ü')\n");
  writeFileSync(join(src, 'readme.txt'), 'not lua');
  const out = join(tmp, 'out');
  const rep = join(tmp, 'rep.json');
  let r = cli([src, '-d', out, '-r', rep, '-q']);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(readFileSync(join(out, 'a', 'b', 'x.lua'), 'utf8').trim(), 'print("hi")');
  assert.equal(readFileSync(join(out, 'top.luau'), 'utf8').trim(), 'print("ü")');
  assert.ok(!existsSync(join(out, 'readme.txt')));
  const reports = JSON.parse(readFileSync(rep, 'utf8'));
  assert.deepEqual(reports.map((e) => e.file), ['a/b/x.lua', 'top.luau']);
  assert.ok(reports.every((e) => e.ok && e.report.threat.level === 'none'));
  assert.ok(reports[0].report.detection.some((d) => d.id === 'load-chain'));
  assert.equal(cli([src, '-o', join(tmp, 'x.lua')]).status, 2);

  // tek dosya: çözülmüş kod stdout'a, -o ile dosyaya; --only ile yalnızca seçilen geçiş
  const one = join(src, 'a', 'b', 'x.lua');
  r = cli([one, '-q']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString().trim(), 'print("hi")');
  r = cli([one, '-o', join(tmp, 'one.lua'), '-q']);
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(tmp, 'one.lua'), 'utf8').trim(), 'print("hi")');
  r = cli([one, '--only', 'fold', '-q']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /loadstring/);

  // metin rapor: stdout'a ve .txt dosyasına
  r = cli([one, '-r', 'text', '--lang', 'en']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /^Summary: .*\nThreat: none \(0\/100\)/);
  r = cli([one, '-r', join(tmp, 'rep.txt'), '-q']);
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(tmp, 'rep.txt'), 'utf8'), /^Özet: /);

  // stdin + --json + --fail-on: eşik aşılınca çıkış kodu 4, rapor İngilizce
  r = cli(['-', '--json', '--fail-on', 'high', '--lang', 'en'], fixture('roblox-logger'));
  assert.equal(r.status, 4, r.stderr.toString());
  const j = JSON.parse(r.stdout.toString());
  assert.equal(j.file, '-');
  assert.equal(j.platform, 'roblox');
  assert.equal(j.report.threat.level, 'critical');
  assert.equal(j.report.iocs.discordWebhooks.length, 1);
  assert.match(j.report.summary, /Threat level critical/);
  // --platform: koddan tanınamayan platform zorlanır
  r = cli(['-', '--json', '--platform', 'fivem', '-q'], "print('x')\n");
  assert.equal(JSON.parse(r.stdout.toString()).platform, 'fivem');
  assert.equal(cli(['-', '--fail-on', 'low', '-q'], "print('merhaba')\n").status, 0);
  console.log('cli: ok');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
