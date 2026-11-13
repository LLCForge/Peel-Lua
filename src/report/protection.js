// Ticari Lua korumalarını tanıma: Luraph, Moonsec V3, Luarmor, PSU (Perth's Synapse Utility). Bilinçli karar:
// korunan bölüm ÇÖZÜLMEZ (ticari lisans korumasını aşmak kapsam dışı). Yalnızca dosyada açık duran meta veriler
// (künye, sürüm, yükleyici kimliği) okunur.
import { pick, t } from './text.js';

const COMMON = t(
  'Korunan bölüm bilinçli olarak çözülmez: ticari lisans korumasını aşmak bu aracın kapsamı dışındadır. Asıl kod ve olası lisans denetimleri yalnızca korunan bölümdedir.',
  'The protected part is intentionally not decoded: bypassing commercial licence protection is out of scope. The real code and any licence checks live only inside the protected part.',
);
const VM = t('Kod, ürünün kendi sanal makinesinde çalışan şifreli bytecode olarak taşınır; load katmanı olmadığından Lua kaynağına geri çevrilemez.', 'The code ships as encrypted bytecode run by the product\'s own virtual machine; with no load layer it cannot be turned back into Lua source.');

function luraph(s, lang) {
  const head = s.match(/This file (?:was|is) protected (?:using|with|by) Luraph(?: Obfuscator)?\s*v?(\d+(?:\.\d+){0,3})?/i);
  const site = /\blura\.ph\b/i.test(s);
  if (!head && !site && !/\bLuraph\b/.test(s)) return null;
  const notes = [];
  if (head) notes.push(pick(t(`Künye: ${head[0].trim()}`, `Banner: ${head[0].trim()}`), lang));
  else notes.push(pick(t('Yalnızca ad/adres işaretiyle tanındı (künye satırı yok).', 'Identified by name/URL only (no banner line).'), lang));
  notes.push(pick(VM, lang));
  return { product: 'Luraph', version: head?.[1] ?? null, notes };
}

function moonsec3(s, lang) {
  const m = s.match(/Moon\s?Sec[\s_-]*V\s?3\b/i) ?? s.match(/\bMoonSec_StringsHiddenAttr\b/);
  if (!m) return null;
  return { product: 'Moonsec V3', version: '3', notes: [pick(t(`İşaret: ${m[0]}`, `Marker: ${m[0]}`), lang), pick(VM, lang)] };
}

function luarmor(s, lang) {
  const loader = s.match(/api\.luarmor\.net\/files\/v(\d+)\/loaders\/([0-9a-fA-F]{8,64})(?:\.lua)?/i);
  const lrm = [...new Set(s.match(/\bLRM_(?:IsUserPremium|SecondsLeft|ScriptName|LinkedDiscordID|TotalExecutions|UserNote|ScriptVersion|IsUserWhitelisted)\b/g) ?? [])];
  const name = /\bLuarmor\b/i.test(s);
  if (!loader && !lrm.length && !name) return null;
  const notes = [];
  if (loader) {
    notes.push(pick(t(`Yükleyici (v${loader[1]}): korunan betik çalışma anında Luarmor sunucusundan indirilir; kimlik ${loader[2]}`, `Loader (v${loader[1]}): the protected script is downloaded from the Luarmor server at run time; id ${loader[2]}`), lang));
  }
  // lisans anahtarı rapora tam yazılmaz
  const key = s.match(/\bscript_key\s*=\s*["']([A-Za-z0-9]{6,80})["']/);
  if (key) notes.push(pick(t(`script_key tanımlı (${key[1].slice(0, 4)}…, ${key[1].length} karakter)`, `script_key is set (${key[1].slice(0, 4)}…, ${key[1].length} chars)`), lang));
  if (lrm.length) notes.push(pick(t(`Luarmor ortam değişkenleri: ${lrm.slice(0, 5).join(', ')}`, `Luarmor environment variables: ${lrm.slice(0, 5).join(', ')}`), lang));
  return { product: 'Luarmor', version: loader ? `v${loader[1]}` : null, notes };
}

function psu(s, lang) {
  const m = s.match(/Perth'?s\s+Synapse\s+Utility/i) ?? s.match(/\bPSU\b[^\n]{0,40}\b(?:obfusc|protect)\w*|(?:obfusc|protect)\w*[^\n]{0,40}\bPSU\b/i);
  if (!m) return null;
  return {
    product: "PSU (Perth's Synapse Utility)",
    version: null,
    notes: [pick(t(`İşaret: ${m[0].trim()} (yalnızca ad işareti; yapısal imza doğrulanmadı)`, `Marker: ${m[0].trim()} (name only; structural signature not verified)`), lang), pick(VM, lang)],
  };
}

/** @returns {null | { product, version, decodable: false, notes }} */
export function protection(text, lang = 'tr') {
  const head = text.length > 8_000_000 ? text.slice(0, 8_000_000) : text;
  for (const f of [luraph, moonsec3, luarmor, psu]) {
    const r = f(head, lang);
    if (r) return { ...r, decodable: false, notes: [...r.notes, pick(COMMON, lang)] };
  }
  return null;
}
