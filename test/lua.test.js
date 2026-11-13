// Ayrıştırıcı yardımcılarının öz-denetimi: node test/lua.test.js
import assert from 'node:assert/strict';
import { fixSemicolons, tryParse } from '../src/core/lua.js';

const cases = [
  [';(f)()', '(f)()'],                       // blok başında yetim ';' (5.1'de geçersiz) silinir
  ['a()\n;(f)()', 'a()\n;(f)()'],            // belirsizliği gideren ';' kalır
  ['a();;b()', 'a()b()'],                    // gereksiz ';' silinir
  ['do ;(f)() end', 'do (f)() end'],
  ['a()\n;;\n(f)()', 'a()\n;(f)()'],
];
for (const [src, want] of cases) {
  const out = fixSemicolons(src, '5.1');
  assert.equal(out, want, src);
  assert.ok(tryParse(out, '5.1'), `5.1 ayrıştırmalı: ${out}`);
}
console.log('lua: ok');
