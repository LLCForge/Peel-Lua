// Lua obfuscator tespiti. Her kural bilinen işaretlerden oluşur; işaret ağırlıkları gürültülü-VEYA ile birleşir:
// güven = 1 - Π(1 - w). Ürünün künye dizgesi ya da adresi yüksek ağırlıklı, yalnızca yapısal (başka araçlarda da
// görülebilen) işaretler düşük ağırlıklıdır. Ticari korumalar (Luraph, Moonsec V3, Luarmor, PSU) burada değil,
// protection.js'te tanınır.
import { pick, snippet, t, WHERE } from './text.js';

const NAME = t('ad/künye dizgesi', 'name/credit string');
const URL = t('ürün adresi', 'product URL');
const NAME_ONLY = t('yalnızca ad işaretiyle tanındı; yapısal imza doğrulanmadı', 'identified by name only; structural signature not verified');

// Prometheus (levno-710) adımlarının yapısal izleri. Adlar karıştırıldığı için yalnızca tablo anahtarları ve
// kalıp biçimleri aranır. WrapInFunction tek başına çok geneldir (WeAreDevs ve el yazımı kod da kullanır).
const PROMETHEUS_STEPS = [
  ['WrapInFunction', /^\s*(?:--[^\n]*\n\s*)*return\s*\(\s*function\s*\(\s*\.\.\.\s*\)/, 0.1],
  ['EncryptStrings', /__index\s*=\s*\w+\s*[;,]\s*__metatable\s*=\s*nil/, 0.3],
  ['ConstantArray', /while\s+(\w+)\[1\]\s*<\s*\1\[2\]\s+do/, 0.3],
  ['AntiTamper', /Tamper(?:ing)?\s+Detected/i, 0.25],
];
const vmDispatch = (s) => (s.match(/\bif\s+\w+\s*<\s*\d+\s+then\b/g) ?? []).length;

// kind: obfuscator | technique; marks: [regex, ağırlık, açıklama]; version(text) isteğe bağlı
export const FAMILIES = [
  {
    id: 'prometheus', name: 'Prometheus (levno-710)', kind: 'obfuscator',
    marks: [
      [/Prometheus\s+Obfuscator/i, 0.9, NAME],
      [/levno[_-]?710/i, 0.8, NAME],
      [/github\.com\/(?:prometheus-lua|levno-710)\/Prometheus/i, 0.8, URL],
    ],
  },
  {
    id: 'wearedevs', name: 'WeAreDevs Lua Obfuscator', kind: 'obfuscator',
    marks: [
      [/wearedevs\.net\/obfuscator/i, 0.95, URL],
      [/\bWeAreDevs\b[^\n]{0,40}obfusc/i, 0.7, NAME],
    ],
    version: (s) => s.match(/\bv(\d+\.\d+(?:\.\d+)?)\s+https?:\/\/wearedevs\.net\/obfuscator/i)?.[1] ?? null,
  },
  {
    id: 'ironbrew', name: 'IronBrew / IronBrew2', kind: 'obfuscator',
    marks: [
      [/Iron\s?Brew/i, 0.85, NAME],
      // IB2 seri çözücüsünün bit okuyucuları ve başlıktaki yerel kısaltmalar
      [/\bgBits(?:8|16|32)\b/, 0.6, t('gBits8/16/32 bit okuyucuları', 'gBits8/16/32 bit readers')],
      [/\bgBit\s*\(|\bgFloat\b|\bgString\b/, 0.3, t('gBit/gFloat/gString yardımcıları', 'gBit/gFloat/gString helpers')],
      [/\bLDExp\s*=\s*math\.ldexp\b/, 0.35, t('LDExp = math.ldexp başlığı', 'LDExp = math.ldexp header')],
      [/\bGetFEnv\s*=\s*getfenv\s+or\b/, 0.35, t('GetFEnv = getfenv or ... başlığı', 'GetFEnv = getfenv or ... header')],
    ],
    version: (s) => (/Iron\s?Brew\s*2|\bgBits32\b/i.test(s) ? '2' : null),
  },
  {
    id: 'hercules', name: 'Hercules', kind: 'obfuscator',
    marks: [[/\bHercules\b[^\n]{0,60}obfusc|obfusc[^\n]{0,60}\bHercules\b/i, 0.85, NAME]],
    version: (s) => s.match(/\bHercules\b[^\n]{0,30}\bv(\d+(?:\.\d+){1,2})/i)?.[1] ?? null,
    nameOnly: true,
  },
  {
    id: 'moonsec-v2', name: 'MoonSec V2', kind: 'obfuscator',
    marks: [
      [/Moon\s?Sec[\s_-]*V\s?2\b/i, 0.85, NAME],
      [/protected\s+(?:with|by|using)\s+Moon\s?Sec\b(?![\s_-]*V?\s?3)/i, 0.6, NAME],
    ],
    // V3 ticari korumadır, protection.js'te tanınır
    skip: (s) => /Moon\s?Sec[\s_-]*V\s?3/i.test(s),
    nameOnly: true,
  },
];

/** Prometheus adımları: künye yoksa en az iki yapısal adım gerekir */
function prometheus(sources, lang) {
  const steps = new Map();
  for (const src of sources) {
    if (src.where === 'literals' || src.where === 'bytecode') continue;
    for (const [step, re, w] of PROMETHEUS_STEPS) {
      const m = src.text.match(re);
      if (m && !steps.has(step)) steps.set(step, { w, ev: `${step} (${pick(WHERE[src.where], lang)}): ${snippet(m[0], 60)}` });
    }
    const n = vmDispatch(src.text);
    const prev = steps.get('Vmify');
    if (n >= 40 && (!prev || prev.n < n)) steps.set('Vmify', { w: 0.2, n, ev: `Vmify (${pick(WHERE[src.where], lang)}): if x < N then ×${n}` });
  }
  return steps;
}

/** Steps → olası preset (Weak: Vmify+ConstantArray+Wrap; Medium: +EncryptStrings/AntiTamper; Strong: iç içe VM) */
function presetOf(steps) {
  if (!steps.has('Vmify')) return null;
  const strong = (steps.get('Vmify').n ?? 0) >= 400;
  if (steps.has('EncryptStrings') || steps.has('AntiTamper')) return strong ? 'Strong preset' : 'Medium preset';
  return steps.has('ConstantArray') ? 'Weak preset' : null;
}

const DECODER = /\b(?:string\.char|string\.byte|string\.reverse|string\.gsub|string\.sub|\w+:reverse\(\)|\w+:gsub\(|\w+:byte\(|bit32\.bxor|bit\.bxor|loadstring|load)|\\\d{2,3}|\\x[0-9a-fA-F]{2}/;

/** Genel (basit) gizleme teknikleri: düzenli ifade + sandbox load kayıtları */
function techniques(sources, loads, lang) {
  const found = new Map();
  const add = (id, name, conf, ev) => {
    const cur = found.get(id) ?? { id, name: pick(name, lang), kind: 'technique', version: null, confidence: 0, evidence: [] };
    cur.confidence = Math.max(cur.confidence, conf);
    if (cur.evidence.length < 4 && !cur.evidence.includes(ev)) cur.evidence.push(ev);
    found.set(id, cur);
  };
  const bw = pick(WHERE.behaviour, lang);
  const LOAD = t('load/loadstring katman zinciri', 'load/loadstring layer chain');
  if (loads.length) {
    const kinds = {};
    for (const l of loads) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
    add('load-chain', LOAD, Math.min(0.95, 0.5 + 0.1 * loads.length), `${bw}: ${Object.entries(kinds).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  }
  const bc = loads.filter((l) => l.code.startsWith('\x1bLua')).length;
  if (bc) add('bytecode', t('Lua bytecode (\\27Lua) yükü', 'Lua bytecode (\\27Lua) payload'), 0.9, `${bw}: ${bc} chunk`);

  for (const src of sources) {
    if (src.where === 'output' || src.where === 'literals') continue; // çözülmüş çıktıdaki kalıntılar ayrıca raporlanmaz
    const s = src.text;
    const where = pick(WHERE[src.where], lang);
    if (src.where === 'bytecode') { add('bytecode', t('Lua bytecode (\\27Lua) yükü', 'Lua bytecode (\\27Lua) payload'), 0.9, where); continue; }
    if (/\\27\s*Lua|\\x1[bB]Lua/.test(s)) add('bytecode', t('Lua bytecode (\\27Lua) yükü', 'Lua bytecode (\\27Lua) payload'), 0.75, `${where}: \\27Lua`);
    for (const m of s.matchAll(/\b(?:loadstring|load)\s*\(([^\n]{0,300})/g)) {
      const used = m[1].match(DECODER);
      if (used) add('load-chain', LOAD, 0.6, `${where}: ${snippet(m[0], 70)}`);
    }
    const chars = (s.match(/\bstring\s*\.\s*char\s*\(|\w+\s*\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,/g) ?? []).length;
    // döngüde biriktirme: s = s .. string.char(t[i]) ya da table.insert(t, string.char(...)); tek tük çağrı sayılmaz
    const charLoop = /\bfor\s[^\n]{0,120}\bdo\b[\s\S]{0,200}?(?:(\w+)\s*=\s*\1\s*\.\.\s*(?:string\s*\.\s*char|[A-Za-z_]\w*)\s*\(\s*[\w.]+\s*\[|table\.insert\s*\(\s*\w+\s*,\s*string\s*\.\s*char\s*\()/.test(s);
    if (chars >= 10 || charLoop) add('char-strings', t('string.char ile kurulan dizgeler', 'strings built with string.char'), charLoop ? 0.7 : Math.min(0.85, 0.4 + chars * 0.01), `${where}: ${charLoop ? 'for … string.char' : `string.char ×${chars}`}`);
    const dec = (s.match(/\\\d{1,3}/g) ?? []).length;
    if (dec >= 20 && dec * 3 > s.length * 0.15) add('decimal-escapes', t('ondalık kaçışlı dizgeler (\\ddd)', 'decimal-escaped strings (\\ddd)'), Math.min(0.85, 0.5 + dec / 2000), `${where}: \\ddd ×${dec}`);
    const hex = (s.match(/\\x[0-9a-fA-F]{2}/g) ?? []).length;
    if (hex >= 20 && hex * 4 > s.length * 0.15) add('hex-escapes', t('onaltılık kaçışlı dizgeler (\\xNN)', 'hex-escaped strings (\\xNN)'), 0.6, `${where}: \\xNN ×${hex}`);
    const rev = s.match(/(?:string\.reverse\s*\(|:\s*reverse\s*\(\s*\))[^\n]{0,200}|(?:string\.gsub\s*\(|:\s*gsub\s*\()[^\n]{0,200}(?:string\.char|tonumber)/);
    if (rev && /\b(?:loadstring|load)\s*\(/.test(s)) add('reverse-gsub-decoder', t('string.reverse/gsub çözücüsü', 'string.reverse/gsub decoder'), 0.6, `${where}: ${snippet(rev[0], 70)}`);
    const xor = s.match(/\b(?:bit32|bit)\.bxor\s*\(|\w+\s*~\s*\w+\s*\)/);
    if (xor && /string\.char|\bchar\s*\(/.test(s) && /string\.byte|:byte\(/.test(s)) add('xor-decoder', t('XOR dizge çözücüsü', 'XOR string decoder'), 0.55, `${where}: ${snippet(xor[0], 40)}`);
    if (/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\+\//.test(s)) add('base64-decoder', t('gömülü base64 çözücüsü', 'embedded base64 decoder'), 0.5, `${where}: A-Za-z0-9+/`);
    const lI = new Set(s.match(/\b[lI][lI1]{5,}\b/g) ?? []);
    if (lI.size >= 5) add('confusable-names', t('l/I/1 karışık okunmaz adlar', 'unreadable l/I/1 names'), Math.min(0.85, 0.4 + lI.size * 0.02), `${where}: ${[...lI].slice(0, 3).join(', ')} (${lI.size})`);
    const vm = vmDispatch(s);
    if (vm >= 40) add('vm', t('sanal makine (opcode dağıtıcısı)', 'virtual machine (opcode dispatcher)'), Math.min(0.8, 0.4 + vm / 1000), `${where}: if x < N then ×${vm}`);
    const env = s.match(/\b(?:getfenv|setfenv)\s*\(|\b_ENV\s*\[/);
    if (env && (found.size || vm >= 40)) add('env-access', t('ortam (getfenv/_ENV) üzerinden gizli erişim', 'hidden access via environment (getfenv/_ENV)'), 0.4, `${where}: ${snippet(env[0], 30)}`);
  }
  return [...found.values()];
}

/**
 * @param {Array<{where, text}>} sources text.js sourcesOf çıktısı
 * @param {Array} loads sandbox load kayıtları (trace.first.loads)
 */
export function detect(sources, loads = [], lang = 'tr') {
  const out = [];
  for (const f of FAMILIES) {
    if (f.skip && sources.some((s) => f.skip(s.text))) continue;
    let miss = 1;
    const evidence = [];
    for (const [re, w, desc] of f.marks) {
      for (const src of sources) {
        const m = src.text.match(re);
        if (!m) continue;
        miss *= 1 - w;
        evidence.push(`${pick(desc, lang)} (${pick(WHERE[src.where], lang)}): ${snippet(m[0], 80)}`);
        break;
      }
    }
    let preset = null;
    if (f.id === 'prometheus') {
      const steps = prometheus(sources, lang);
      // künye yoksa yapısal adımlar ancak ikisi birlikte görülürse sayılır
      const strong = [...steps.keys()].filter((k) => k !== 'WrapInFunction');
      if (miss < 1 || strong.length >= 2) {
        for (const s of steps.values()) { miss *= 1 - s.w; evidence.push(s.ev); }
        preset = presetOf(steps);
      }
    }
    const confidence = Math.round((1 - miss) * 100) / 100;
    if (confidence < 0.3) continue;
    if (f.nameOnly) evidence.push(pick(NAME_ONLY, lang));
    let version = preset;
    for (const src of sources) version ??= f.version?.(src.text) ?? null;
    out.push({ id: f.id, name: f.name, kind: f.kind, version, confidence, evidence });
  }
  // WeAreDevs, Prometheus tabanlıdır: künye WeAreDevs ise yapısal Prometheus eşleşmesi ayrıca yazılmaz
  const res = out.filter((d) => d.id !== 'prometheus' || !out.some((o) => o.id === 'wearedevs') || d.confidence >= 0.8);
  res.push(...techniques(sources, loads, lang));
  for (const d of res) d.confidence = Math.round(d.confidence * 100) / 100;
  const rank = { obfuscator: 0, technique: 1 };
  return res.sort((a, b) => rank[a.kind] - rank[b.kind] || b.confidence - a.confidence);
}
