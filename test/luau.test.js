// Luau → Lua indirmesinin öz-denetimi: node test/luau.test.js
import assert from 'node:assert/strict';
import { lowerLuau } from '../src/core/luau.js';
import { tryParse } from '../src/core/lua.js';

const ok = (src, want, version = '5.1') => {
  const r = lowerLuau(src);
  assert.ok(!r.error, `${src}: ${r.error}`);
  // boşluklar karşılaştırılmaz (atılan tipler boşluk bırakır)
  const squash = (x) => x.replace(/\s+/g, '');
  assert.equal(squash(r.code), squash(want), src);
  assert.ok(tryParse(r.code, version), `ayrıştırılmalı: ${r.code}`);
};

ok('local x: number = 1', 'local x = 1');
ok('local function f<T>(a: T, ...: any): (T, number) return a end', 'local function f(a , ...) return a end');
ok('type A = { b: string }\nexport type F<T> = (T) -> T?\nprint(1)', 'print(1)');
ok('x += 1', 'x = x + ( 1)');
ok('t.a ..= "s"', 'do local __peel_t, __peel_k = t, "a"; __peel_t[__peel_k] = __peel_t[__peel_k] .. ( "s") end');
ok('print(`a{b}c`)', 'print(("a" .. tostring(b) .. "c"))');
ok('local v = if a then 1 elseif b then 2 else 3', 'local v = ((a) and { 1} or { ((b) and { 2} or { 3})[1]})[1]');
ok('print(x :: number, 0b101, 1_0, "\\x41")', 'print(x , 5, 10, "A")');
ok('obj:m(a)\nlocal continue = 1\nprint(continue)', 'obj:m(a) local continue = 1 print(continue)');
ok('for i = 1, 3 do if i then continue end end', 'for i = 1, 3 do if i then goto __peel_continue_1 end ::__peel_continue_1:: end', '5.2');
assert.ok(lowerLuau('repeat local a = 1 continue until a').error, 'repeat + local + continue indirilmemeli');
assert.ok(lowerLuau('print(7 // 2)').error, '// indirilmemeli');
console.log('luau: ok');
