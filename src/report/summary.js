// Raporun tek paragraflık özeti (tr | en); yalnızca bulunan bulgulara dayanır.

const LEVEL = {
  tr: { none: 'yok', low: 'düşük', medium: 'orta', high: 'yüksek', critical: 'kritik' },
  en: { none: 'none', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
};
const PLATFORM = { roblox: 'Roblox', fivem: 'FiveM', gmod: "Garry's Mod" };

const list = (xs, en) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${en ? 'and' : 've'} ${xs.at(-1)}`);

export function summarize(r, lang = 'tr') {
  const en = lang === 'en';
  const parts = [];
  const pct = (c) => (en ? `${Math.round(c * 100)}%` : `%${Math.round(c * 100)}`);
  const name = (d) => `${d.name}${d.version ? ` ${d.version}` : ''} (${pct(d.confidence)})`;
  const of = (kind) => r.detection.filter((d) => d.kind === kind);

  if (r.protection) {
    const p = r.protection;
    const label = `${p.product}${p.version ? ` ${p.version}` : ''}`;
    parts.push(en
      ? `The file is protected with ${label}; the protected part is intentionally not decoded (bypassing licence protection is out of scope).`
      : `Dosya ${label} ile korunuyor; korunan bölüm bilinçli olarak çözülmez (lisans korumasını aşmak kapsam dışı).`);
  }
  if (of('obfuscator').length) parts.push(`Obfuscator: ${list(of('obfuscator').map(name), en)}.`);
  if (of('technique').length) parts.push(en ? `Techniques: ${list(of('technique').map((d) => d.name), en)}.` : `Kullanılan teknikler: ${list(of('technique').map((d) => d.name), en)}.`);
  const m = r.metrics;
  const plat = m.platform ? ` · ${PLATFORM[m.platform] ?? m.platform}` : '';
  if (r.behaviour.loads || m.layers) {
    parts.push(en
      ? `${r.behaviour.loads} load/loadstring layer(s) were captured in the sandbox (Lua ${m.version ?? '?'}${plat}) and the code went from ${m.inBytes} to ${m.outBytes} bytes.`
      : `Sandbox'ta (Lua ${m.version ?? '?'}${plat}) ${r.behaviour.loads} load/loadstring katmanı yakalandı ve kod ${m.inBytes} bayttan ${m.outBytes} bayta indi.`);
  }
  if (r.bytecode?.length) {
    parts.push(en
      ? `${r.bytecode.length} binary chunk(s) (Lua ${[...new Set(r.bytecode.map((b) => b.version))].join(', ')}) could not be turned back into source; only their strings were analysed.`
      : `${r.bytecode.length} ikili chunk (Lua ${[...new Set(r.bytecode.map((b) => b.version))].join(', ')}) kaynağa çevrilemedi; yalnızca dizgeleri analize katıldı.`);
  }
  const th = r.threat;
  const lv = LEVEL[en ? 'en' : 'tr'][th.level];
  if (th.classes.length) {
    const cls = th.classes.slice(0, 5).map((c) => c.title);
    parts.push(en ? `Threat level ${lv} (${th.score}/100): ${list(cls, en)}.` : `Tehdit düzeyi ${lv} (${th.score}/100): ${list(cls, en)}.`);
  } else if (r.protection) {
    parts.push(en ? 'Since the code is protected, its behaviour could not be assessed.' : 'Kod korumalı olduğundan davranışı değerlendirilemedi.');
  } else {
    parts.push(en ? 'No dangerous behaviour was found in the decoded code (threat level none).' : 'Çözülmüş kodda tehlikeli bir davranış bulunmadı (tehdit düzeyi yok).');
  }
  const b = r.behaviour;
  if (b.network.length + b.commands.length + b.files.length) {
    parts.push(en
      ? `In the sandbox it attempted ${b.network.length} network, ${b.commands.length} command and ${b.files.length} file operation(s); none were performed.`
      : `Sandbox'ta ${b.network.length} ağ, ${b.commands.length} komut ve ${b.files.length} dosya işlemi denedi; hiçbiri gerçekleştirilmedi.`);
  }
  const io = r.iocs;
  const counts = [
    [io.urls, 'URL', 'URL(s)'], [io.domains, 'alan adı', 'domain(s)'], [io.ips, 'IP', 'IP(s)'], [io.emails, 'e-posta', 'e-mail(s)'],
    [io.discordWebhooks, 'Discord webhook', 'Discord webhook(s)'], [io.telegram, 'Telegram', 'Telegram'],
  ].filter(([xs]) => xs?.length).map(([xs, tr, e]) => `${xs.length} ${en ? e : tr}`);
  if (counts.length) parts.push(en ? `IOCs: ${list(counts, en)}.` : `IOC: ${list(counts, en)}.`);
  return parts.join(' ');
}
