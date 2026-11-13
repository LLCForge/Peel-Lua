// Analiz raporu testleri: node test/analyze.test.js
// Zararlı benzeri örnekler test/analyze-fixtures/*.lua.x (XOR + base64) ve yalnızca bellekte çözülür; üretici betik
// scripts/make-analyze-fixtures.js (şüpheli dizgeler parçalı). Obfuscator künyeleri zararsızdır, burada düz yazılır.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peel, analyze } from '../src/index.js';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { protection } from '../src/report/protection.js';
import { iocs } from '../src/report/iocs.js';
import { literals, reportText } from '../src/report/text.js';
import { fromText } from '../src/core/bstr.js';
import { decodeFixture } from './fixture-codec.js';

const load = (name) => new Uint8Array(decodeFixture(readFileSync(new URL(`./analyze-fixtures/${name}.lua.x`, import.meta.url), 'utf8')));
const stat = (src, lang = 'tr') => analyze({ input: fromText(src), output: fromText(src), lang });
const ids = (r) => r.detection.map((d) => d.id);
const cls = (r) => r.threat.classes.map((c) => c.id);
const conf = (r, id) => r.detection.find((d) => d.id === id)?.confidence ?? 0;
const dec = (s) => [...Buffer.from(s)].map((x) => `\\${x}`).join('');

// --- statik dizge çözümü: ondalık/onaltılık kaçışlar ve string.char sabitleri ---
assert.equal(literals(`local a = "${dec('hello')}" local b = '\\x68\\x69\\x21\\x21' local c = string.char(119, 111, 114, 108, 100)`), 'hello\nhi!!\nworld');

// --- IOC: zararsız alanlar ayrılır, github ham dosyası indirme adresidir ---
const io = iocs([
  "local a = 'https://users.roblox.com/v1/users/1' local b = 'https://github.com/x/y' local c = 'https://raw.githubusercontent.com/x/y/main/a.lua'",
  "local d = 'https://github.com/x/y/raw/main/b.lua' local e = 'ops@evil-example.net' local f = '203.0.113.20' local g = '127.0.0.1'",
]);
assert.deepEqual(io.benign, ['github.com', 'users.roblox.com']);
assert.deepEqual(io.downloads, ['https://github.com/x/y/raw/main/b.lua', 'https://raw.githubusercontent.com/x/y/main/a.lua']);
assert.deepEqual(io.domains, ['raw.githubusercontent.com']);
assert.deepEqual(io.emails, ['ops@evil-example.net']);
assert.deepEqual(io.ips, ['203.0.113.20']);

// --- ticari korumalar: tanınır, çözülmez, yalnızca açık meta veriler ---
let p = protection('-- This file was protected using Luraph Obfuscator v14.4.1 [https://lura.ph/]\nreturn({...})', 'tr');
assert.equal(p.product, 'Luraph');
assert.equal(p.version, '14.4.1');
assert.equal(p.decodable, false);
assert.ok(p.notes.some((n) => n.includes('bilinçli olarak çözülmez')));
assert.equal(protection('-- protected with MoonSec V3\nlocal a = 1', 'en').product, 'Moonsec V3');
p = protection('script_key = "abcdEFGH12345678"\nloadstring(game:HttpGet("https://api.luarmor.net/files/v3/loaders/0123456789abcdef0123456789abcdef.lua"))()', 'en');
assert.equal(p.product, 'Luarmor');
assert.equal(p.version, 'v3');
assert.ok(p.notes.some((n) => n.includes('abcd…') && !n.includes('abcdEFGH')), 'lisans anahtarı maskelenmeli');
assert.match(protection("-- Obfuscated with PSU\nlocal x = 1", 'tr').product, /^PSU/);
assert.equal(protection("print('x')", 'tr'), null);
let r = stat('-- This file was protected using Luraph Obfuscator v14.4.1 [https://lura.ph/]\nreturn({})', 'en');
assert.equal(r.protection.product, 'Luraph');
assert.ok(!ids(r).includes('luraph'), 'ticari koruma detection listesine girmez');
assert.match(r.summary, /intentionally not decoded/);
assert.deepEqual(r.iocs.urls, []);

// --- obfuscator aileleri (statik) ---
r = stat('--[[ v1.0.0 https://wearedevs.net/obfuscator ]] return(function(...) local a = 1 end)(...)');
assert.ok(conf(r, 'wearedevs') > 0.9);
assert.equal(r.detection[0].version, '1.0.0');
assert.ok(r.iocs.benign.includes('wearedevs.net'));
r = stat('-- This Script is Part of the Prometheus Obfuscator by Levno_710\nreturn(function(...) end)(...)');
assert.ok(conf(r, 'prometheus') > 0.9);
// künyesiz Prometheus: iki yapısal adım (EncryptStrings + ConstantArray) ve VM dağıtıcısı → olası preset
const vm = Array.from({ length: 60 }, (_, i) => `if a < ${i} then b = ${i} end`).join('\n');
r = stat(`return(function(...) local S = setmetatable({}, {__index = R; __metatable = nil})\nfor i, v in ipairs(T) do while v[1] < v[2] do v[1] = v[1] + 1 end end\n${vm}\nend)(...)`);
assert.ok(conf(r, 'prometheus') >= 0.5);
assert.equal(r.detection.find((d) => d.id === 'prometheus').version, 'Medium preset');
assert.ok(ids(r).includes('vm'));
r = stat('local Byte = string.byte\nlocal LDExp = math.ldexp\nlocal GetFEnv = getfenv or function() return _ENV end\nlocal function gBits32() end\nlocal function gBits8() end');
assert.ok(conf(r, 'ironbrew') >= 0.8);
assert.equal(r.detection[0].version, '2');
r = stat('--[[ Obfuscated with Hercules v1.6 ]]\nlocal a = 1');
assert.equal(r.detection[0].id, 'hercules');
assert.equal(r.detection[0].version, '1.6');
r = stat('-- This file was protected with MoonSec V2\nlocal a = 1');
assert.ok(conf(r, 'moonsec-v2') > 0.8);
assert.ok(!ids(stat('-- protected with MoonSec V3')).includes('moonsec-v2'));

// --- basit teknikler ---
r = stat(`loadstring("${dec("print('a') print('b') print('c')")}")()`);
assert.ok(ids(r).includes('decimal-escapes') && ids(r).includes('load-chain'));
r = stat('local s = string.dump(function() end)\nlocal b = "\\27LuaQ"');
assert.ok(ids(r).includes('bytecode'));
r = stat("local t = ('))(tnirp'):reverse()\nloadstring(t)()");
assert.ok(ids(r).includes('reverse-gsub-decoder'));
r = stat("local s = ''\nfor i = 1, #k do s = s .. string.char(k[i]) end\nprint(s)");
assert.ok(ids(r).includes('char-strings'));
const bc = analyze({ input: '\x1bLuaQ\x00\x01\x04print\x00', output: '', lang: 'en' });
assert.deepEqual(bc.bytecode, [{ size: 14, version: '5.1' }]);
assert.ok(ids(bc).includes('bytecode'));

// --- yanlış pozitif denetimi: sıradan oyun kodu ---
r = stat([
  "local Players = game:GetService('Players')",
  "local MarketplaceService = game:GetService('MarketplaceService')",
  "MarketplaceService:PromptGamePassPurchase(Players.LocalPlayer, 12345)",
  "local data = game:GetService('HttpService'):GetAsync('https://games.roblox.com/v1/games')",
  "for i = 1, 10 do print(string.char(65 + i)) end",
].join('\n'));
assert.equal(r.threat.level, 'none');
assert.deepEqual(r.iocs.urls, []);
assert.deepEqual(r.detection, []);

// --- Roblox hediye kandırması (statik): satın alma istemi + yem metni ---
r = stat("local M = game:GetService('MarketplaceService')\nlocal t = 'FREE ROBUX gift, claim now'\nM:PromptProductPurchase(p, 1)");
assert.ok(cls(r).includes('roblox-gift-scam'));
assert.match(reportText(r, 'tr'), /Roblox: sahte hediye/);

// --- sandbox: katmanlar açılır; davranış kayıtları ve katman içeriği analiz edilir ---
const sb = createNodeSandbox();
try {
  r = (await peel(load('fivem-backdoor'), { sandbox: sb })).report;
  assert.equal(r.metrics.platform, 'fivem');
  assert.ok(ids(r).includes('load-chain') && ids(r).includes('char-strings'));
  assert.ok(cls(r).includes('fivem-backdoor') && cls(r).includes('fivem-config-leak'));
  assert.equal(r.threat.level, 'critical');
  assert.ok(r.iocs.domains.includes(['cipher', '-panel.me'].join('')));
  assert.equal(r.behaviour.network.filter((n) => n.api === 'PerformHttpRequest').length, 2);
  assert.match(r.summary, /Tehdit düzeyi kritik/);

  r = (await peel(load('gmod-backdoor'), { sandbox: sb, lang: 'en' })).report;
  assert.equal(r.metrics.platform, 'gmod');
  assert.ok(ids(r).includes('decimal-escapes'));
  assert.ok(cls(r).includes('gmod-backdoor') && cls(r).includes('admin-grant'));
  assert.deepEqual(r.iocs.ips, ['203.0.113.5']);
  assert.match(r.summary, /Threat level critical/);

  r = (await peel(load('roblox-logger'), { sandbox: sb })).report;
  for (const c of ['roblox-remote-load', 'roblox-require-backdoor', 'webhook-logger', 'exfiltration']) assert.ok(cls(r).includes(c), c);
  assert.equal(r.iocs.discordWebhooks.length, 1);
  assert.deepEqual(r.iocs.downloads, ['https://pastebin.com/raw/PeelAb12']);
  assert.ok(r.iocs.benign.includes('users.roblox.com'));
  assert.ok(r.behaviour.network.some((n) => n.api === 'game.HttpGet'));

  r = (await peel(load('generic'), { sandbox: sb })).report;
  assert.ok(ids(r).includes('reverse-gsub-decoder'));
  for (const c of ['command-exec', 'file-delete', 'exfiltration']) assert.ok(cls(r).includes(c), c);
  assert.equal(r.behaviour.commands.length, 2);
  assert.ok(r.iocs.telegram.includes('chat_id:-1001234567'));
  assert.ok(r.iocs.telegram.some((x) => x.startsWith('bot:123456789:')));
  assert.deepEqual(r.iocs.ips, ['198.51.100.9']);

  // zararsız kod: tehdit yok, tespit yok
  const clean = await peel("local function add(a, b) return a + b end\nprint(add(1, 2))\n", { sandbox: sb });
  assert.equal(clean.report.threat.level, 'none');
  assert.deepEqual(clean.report.detection, []);
  console.log('analyze: ok');
} finally {
  sb.close();
}
