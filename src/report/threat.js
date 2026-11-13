// Tehdit analizi: kaynaklar (girdi, katmanlar, çıktı, dizge sabitleri) düzenli ifadelerle taranır ve sandbox'ın
// kaydettiği yan etki denemeleri (fx) aynı kurallardan geçirilir: kod hangi biçimde gizlenmiş olursa olsun çalışma
// anında denediği çağrı kanıttır. Birden çok bağımsız işaret gerektiren sınıflar (FiveM/GMod arka kapısı, webhook
// logger, hediye kandırması) önce tek tek kaynaklarda, sonra tüm kaynakların birleşiminde aranır (yük bir katmanda,
// yükleyici başka katmanda olabilir). Şüpheli dizgeler kaynakta parçalı yazılır (antivirüs imzalarına takılmasın).
import { pick, rx, snippet, t, WHERE } from './text.js';
import { toText } from '../core/bstr.js';
import { DOWNLOAD_HOSTS } from './iocs.js';

export const CLASSES = {
  'fivem-backdoor': t('FiveM arka kapısı (uzaktan kod çalıştırma)', 'FiveM backdoor (remote code execution)'),
  'fivem-config-leak': t('FiveM sunucu yapılandırması / anahtar sızdırma', 'FiveM server config / key leak'),
  'fivem-txadmin': t('txAdmin verisi / convar okuma', 'txAdmin data / convar access'),
  'gmod-backdoor': t("Garry's Mod arka kapısı (uzaktan kod çalıştırma)", "Garry's Mod backdoor (remote code execution)"),
  'admin-grant': t('Gizli yönetici yetkisi verme', 'Hidden admin privilege grant'),
  'roblox-remote-load': t('Roblox: uzaktan kod yükleme (loadstring + HttpGet)', 'Roblox: remote code loading (loadstring + HttpGet)'),
  'roblox-require-backdoor': t('Roblox: require(<varlık kimliği>) arka kapısı', 'Roblox: require(<asset id>) backdoor'),
  'roblox-gift-scam': t('Roblox: sahte hediye / satın alma kandırması', 'Roblox: fake gift / purchase scam'),
  'webhook-logger': t('Oyuncu bilgisi toplayan webhook logger', 'Player-data webhook logger'),
  exfiltration: t('Veri sızdırma (Discord/Telegram)', 'Data exfiltration (Discord/Telegram)'),
  downloader: t('İndirici (paste/ham dosya barındırma)', 'Downloader (paste/raw hosting)'),
  'command-exec': t('İşletim sistemi komutu çalıştırma', 'OS command execution'),
  'file-delete': t('Dosya silme', 'File deletion'),
};

const LOAD = /\b(?:loadstring|load|RunString(?:Ex)?|CompileString)\s*\(|\bassert\s*\(\s*load\s*\(/;
const PHR = rx(['\\bPerform', 'HttpRequest\\b']);
const HOOK = rx(['discord(?:app)?\\.com/api/(?:v\\d+/)?', 'webhooks/'], 'i');
const SECRETS = rx(['\\b(?:sv_license', 'Key|rcon_pass', 'word|steam_web', 'ApiKey|sv_tebex', 'Secret)\\b'], 'i');
const NET = /\bPerformHttpRequest\b|\bhttp\.(?:Fetch|Post)\b|\bHTTP\s*\(|HttpGet|HttpPost|PostAsync|RequestAsync|\b(?:syn\.)?request\s*\(|http_request/;

// Tek işaretli kurallar: [sınıf, ağırlık, regex]
const RULES = [
  ['fivem-backdoor', 80, rx(['cipher', '-panel|cipher', 'cheats|blum', '-panel'], 'i')],
  ['fivem-backdoor', 50, rx(['[\'"]help', 'Code[\'"]'])],
  ['fivem-config-leak', 35, rx(['server', '\\.cfg'], 'i')],
  ['fivem-txadmin', 25, rx(['tx', 'Admin-luaComToken|txAdmin', 'ServerMode|tx', 'Data[\\\\/]|admins', '\\.json'])],
  ['gmod-backdoor', 75, rx(['RunString(?:Ex)?\\s*\\(\\s*net\\.Read', '(?:String|Data)'])],
  ['admin-grant', 55, rx(['SetUser', 'Group\\s*\\(\\s*["\'](?:super)?admin["\']'])],
  ['admin-grant', 50, rx(['ulx\\s*\\.\\s*(?:adduser|adduserid)\\b|ULib\\.ucl\\.add', 'User\\b'])],
  ['admin-grant', 55, rx(['add_', '(?:ace|principal)\\s+(?:identifier\\.|group\\.admin|[^\\n]{0,40}command\\s+allow)'], 'i')],
  ['roblox-remote-load', 40, rx(['load', 'string\\s*\\(\\s*game\\s*[:.]\\s*HttpGet(?:Async)?\\s*\\('])],
  ['roblox-require-backdoor', 60, /\brequire\s*\(\s*\d{6,}\s*\)/],
  ['exfiltration', 50, HOOK],
  ['exfiltration', 50, rx(['api\\.telegram\\.org/', 'bot'], 'i')],
  ['command-exec', 40, /\bos\.execute\s*\(|\bio\.popen\s*\(/],
  ['file-delete', 30, /\bos\.remove\s*\(|\bdelfile\s*\(|\bfile\.Delete\s*\(/],
];

// Çok işaretli kurallar: [sınıf, [regex...], (eşleşen sayısı) => ağırlık]
const MULTI = [
  ['fivem-backdoor', [PHR, LOAD], (n) => (n >= 2 ? 70 : 0)],
  ['fivem-config-leak', [SECRETS, NET], (n) => (n >= 2 ? 55 : 0)],
  ['fivem-txadmin', [rx(['tx', 'Admin|tx', 'Data']), /GetConvar\s*\(|LoadResourceFile\s*\(/, NET], (n) => (n >= 3 ? 45 : 0)],
  ['gmod-backdoor', [/\bhttp\.(?:Fetch|Post)\b|\bHTTP\s*\(/, /\b(?:RunString(?:Ex)?|CompileString)\b/], (n) => (n >= 2 ? 70 : 0)],
  ['gmod-backdoor', [/\bnet\.Receive\b/, /\b(?:RunString(?:Ex)?|CompileString)\b/], (n) => (n >= 2 ? 65 : 0)],
  ['webhook-logger', [HOOK, /\bLocalPlayer\b|\.UserId\b|\.AccountAge\b|\.DisplayName\b|GetPlayerName|GetPlayerIdentifiers|SteamID/, NET], (n) => (n >= 3 ? 60 : 0)],
  ['roblox-gift-scam', [/MarketplaceService/, /Prompt(?:GamePass|Product|Bundle|Premium)?Purchase\b|AwardBadge\b/, /free\s*robux|\bgift\b|hediye|\bclaim\b|giveaway/i], (n) => (n >= 3 ? 45 : 0)],
  ['file-delete', [/\bos\.remove\s*\(|\bdelfile\s*\(|\bfile\.Delete\s*\(/, /\blfs\.dir\b|\bfile\.Find\b|\blistfiles\b|io\.popen\s*\([^\n]{0,20}(?:dir|ls)\b/], (n) => (n >= 2 ? 45 : 0)],
];

/** fx kaydını tek satır metne çevirir: api(arg1, arg2); argümanlar bstr */
const fxLine = ([api, args = []]) => `${api}(${args.map((a) => snippet(typeof a === 'string' ? toText(a) : String(a), 200)).join(', ')})`;

/**
 * @param {Array} sources text.js sourcesOf çıktısı
 * @param {object} behaviour analyze'daki sandbox davranışı
 * @param {Array} fx trace.first.fx
 */
export function threat(sources, behaviour, fx = [], lang = 'tr') {
  const findings = [];
  const behaviourText = fx.map(fxLine).join('\n');
  const scan = [...sources, { where: 'behaviour', text: behaviourText }];
  const multi = (src) => {
    for (const [cls, res, weightOf] of MULTI) {
      const hits = res.map((re) => src.text.match(re)?.[0]).filter(Boolean);
      const weight = weightOf(hits.length);
      if (weight) findings.push({ cls, weight, ev: `${pick(WHERE[src.where], lang)}: ${hits.slice(0, 4).map((h) => snippet(h, 40)).join(' + ')}` });
    }
  };
  for (const src of scan) {
    if (!src.text) continue;
    const where = pick(WHERE[src.where], lang);
    for (const [cls, weight, re] of RULES) {
      const m = src.text.match(re);
      if (m) findings.push({ cls, weight, ev: `${where}: ${snippet(m[0], 80)}` });
    }
    multi(src);
  }
  // yükleyici ve yük farklı katmanlarda olabilir: birleşik metinde yalnızca tek kaynakta bulunmayan sınıflar eklenir
  const single = new Set(findings.map((f) => f.cls));
  const before = findings.length;
  multi({ where: 'all', text: scan.map((s) => s.text).join('\n') });
  findings.splice(before, Infinity, ...findings.slice(before).filter((f) => !single.has(f.cls)));

  const bw = pick(WHERE.behaviour, lang);
  for (const c of behaviour.commands) findings.push({ cls: 'command-exec', weight: 45, ev: `${bw}: ${c.api}(${snippet(c.command, 80)})` });
  const net = behaviour.network.filter((n) => n.target);
  const hostOf = (u) => u.match(/^[a-z][a-z+.-]*:\/\/([^:/?#]+)/i)?.[1] ?? '';
  // paste/ham dosya barındırma adresinden indirip yükleme: uzaktan kodun tipik yolu
  if (behaviour.loads) for (const n of net.filter((x) => DOWNLOAD_HOSTS.test(hostOf(x.target))).slice(0, 3)) findings.push({ cls: 'downloader', weight: 40, ev: `${bw}: ${n.api}(${snippet(n.target, 80)})` });
  for (const n of net.filter((x) => HOOK.test(x.target)).slice(0, 3)) findings.push({ cls: 'exfiltration', weight: 55, ev: `${bw}: ${n.api}(${snippet(n.target, 80)})` });

  const byClass = new Map();
  for (const f of findings) {
    const c = byClass.get(f.cls) ?? { id: f.cls, title: pick(CLASSES[f.cls], lang), weight: 0, evidence: [] };
    c.weight = Math.max(c.weight, f.weight);
    if (c.evidence.length < 6 && !c.evidence.includes(f.ev)) c.evidence.push(f.ev);
    byClass.set(f.cls, c);
  }
  const classes = [...byClass.values()].sort((a, b) => b.weight - a.weight);
  // en güçlü sınıf tam, diğerleri yarım ağırlıkla
  const score = Math.min(100, Math.round(classes.reduce((s, c, i) => s + (i === 0 ? c.weight : c.weight / 2), 0)));
  const level = score === 0 ? 'none' : score < 20 ? 'low' : score < 45 ? 'medium' : score < 70 ? 'high' : 'critical';
  return { score, level, classes };
}
