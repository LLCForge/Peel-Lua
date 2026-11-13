// Rapor modüllerinin ortak yardımcıları: kaynak metinleri, kanıt kesitleri, dil seçimi, düz metin rapor.
// Tarayıcıda da çalışır (Node'a özgü API yok). Girdi, çıktı ve katmanlar bstr'dir (her karakter bir bayt).
import { toText } from '../core/bstr.js';

export const t = (tr, en = tr) => ({ tr, en });
export const pick = (o, lang) => (lang === 'en' ? o.en : o.tr);

/** Antivirüs imzalarına takılmasın diye şüpheli dizgeler kaynakta parçalı yazılır: rx(['Perform', 'HttpRequest']) */
export const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

export const WHERE = {
  input: t('girdi', 'input'),
  layer: t('katman', 'layer'),
  output: t('çıktı', 'output'),
  literals: t('çözülmüş dizge sabitleri', 'decoded string literals'),
  bytecode: t('bytecode dizgeleri', 'bytecode strings'),
  behaviour: t('davranış', 'behaviour'),
  all: t('tüm kaynaklar', 'all sources'),
};

/** Kanıt için tek satırlık, kısaltılmış kesit */
export function snippet(s, max = 120) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export const isBytecode = (bstr) => typeof bstr === 'string' && bstr.startsWith('\x1bLua');

/** İkili chunk'taki yazdırılabilir dizgeler (sabitler, adlar) */
export const printable = (bstr) => (bstr.match(/[\x20-\x7e]{4,}/g) ?? []).join('\n');

const MAX_SCAN = 4_000_000;
const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'" };

/**
 * Kaçışlı dizge sabitlerini ("\104\116", "\x68") ve string.char(104, 116, ...) çağrılarını statik olarak çözer.
 * Sandbox kodu çalıştıramadığında bile adres ve API adları görünür olsun diye. Yalnızca kaçış içeren sabitler alınır.
 */
export function literals(text) {
  const s = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const out = [];
  for (const m of s.matchAll(/"((?:\\[\s\S]|[^"\\\n])*)"|'((?:\\[\s\S]|[^'\\\n])*)'/g)) {
    const body = m[1] ?? m[2];
    if (!/\\(?:\d|x[0-9a-fA-F])/.test(body)) continue;
    const dec = body.replace(/\\(\d{1,3})|\\x([0-9a-fA-F]{2})|\\(.)/g, (_, d, x, c) => (d ? String.fromCharCode(Number(d) & 0xff) : x ? String.fromCharCode(parseInt(x, 16)) : ESC[c] ?? c));
    if (dec.length >= 4) out.push(toText(dec));
  }
  for (const m of s.matchAll(/string\s*\.\s*char\s*\(\s*(\d{1,3}(?:\s*,\s*\d{1,3}){3,})\s*\)/g)) {
    out.push(toText(String.fromCharCode(...m[1].split(',').map((n) => Number(n) & 0xff))));
  }
  return out.join('\n');
}

/**
 * Analiz edilecek kaynaklar: girdi, sandbox'ın yakaladığı load/loadstring/RunString katmanları, çözülmüş çıktı,
 * statik çözülmüş dizge sabitleri ve ikili chunk dizgeleri. Her biri { where, text }; aynı içerik bir kez alınır.
 */
export function sourcesOf({ input = '', output = '', trace }) {
  const seen = new Set();
  const out = [];
  const add = (where, text) => {
    if (typeof text !== 'string' || !text.trim() || seen.has(text)) return;
    seen.add(text);
    out.push({ where, text });
  };
  const addCode = (where, bstr) => (isBytecode(bstr) ? add('bytecode', printable(bstr)) : add(where, toText(bstr)));
  addCode('input', input);
  const loads = (trace?.first?.loads ?? []).map((l) => l.code).filter((c) => typeof c === 'string');
  for (const c of loads) addCode('layer', c);
  addCode('output', output);
  add('literals', [input, ...loads].filter((c) => !isBytecode(c)).map((c) => literals(toText(c))).filter(Boolean).join('\n'));
  return out;
}

const LEVEL = {
  tr: { none: 'yok', low: 'düşük', medium: 'orta', high: 'yüksek', critical: 'kritik' },
  en: { none: 'none', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
};

/** CLI için okunabilir düz metin rapor */
export function reportText(r, lang = r?.lang ?? 'tr') {
  const en = lang === 'en';
  const L = (tr, e) => (en ? e : tr);
  const pct = (c) => (en ? `${Math.round(c * 100)}%` : `%${Math.round(c * 100)}`);
  const lines = [];
  lines.push(`${L('Özet', 'Summary')}: ${r.summary}`);
  lines.push(`${L('Tehdit', 'Threat')}: ${LEVEL[en ? 'en' : 'tr'][r.threat.level]} (${r.threat.score}/100)`);
  for (const c of r.threat.classes) {
    lines.push(`  - ${c.title}`);
    for (const e of c.evidence) lines.push(`      ${e}`);
  }
  if (r.protection) {
    const p = r.protection;
    lines.push(`${L('Koruma', 'Protection')}: ${p.product}${p.version ? ` ${p.version}` : ''} (${L('çözülmez', 'not decoded')})`);
    for (const n of p.notes) lines.push(`  - ${n}`);
  }
  if (r.detection.length) {
    lines.push(`${L('Tespitler', 'Detections')}:`);
    for (const d of r.detection) {
      lines.push(`  - ${d.name}${d.version ? ` ${d.version}` : ''} [${d.kind}] ${pct(d.confidence)}`);
      for (const e of d.evidence) lines.push(`      ${e}`);
    }
  }
  const b = r.behaviour;
  const acts = [...b.network.map((n) => `${n.api}(${n.target})`), ...b.commands.map((c) => `${c.api}(${c.command})`), ...b.files.map((f) => `${f.api}(${f.path})`)];
  if (acts.length) {
    lines.push(`${L('Sandbox davranışı (yapılmadı, yalnızca kaydedildi)', 'Sandbox behaviour (recorded, never performed)')}:`);
    for (const a of acts.slice(0, 30)) lines.push(`  - ${snippet(a, 160)}`);
  }
  const io = r.iocs;
  const keys = ['urls', 'domains', 'ips', 'emails', 'discordWebhooks', 'telegram', 'downloads', 'benign'];
  if (keys.some((k) => io[k]?.length)) {
    lines.push('IOC:');
    for (const k of keys) if (io[k]?.length) lines.push(`  ${k}: ${io[k].join(', ')}`);
  }
  const m = r.metrics;
  lines.push(`${L('Ölçüler', 'Metrics')}: ${m.inBytes} → ${m.outBytes} ${L('bayt', 'bytes')}, ${L('katman', 'layers')} ${m.layers}, ${L('tur', 'rounds')} ${m.rounds}, Lua ${m.version ?? '?'}${m.platform ? `, ${m.platform}` : ''}`);
  return `${lines.join('\n')}\n`;
}
