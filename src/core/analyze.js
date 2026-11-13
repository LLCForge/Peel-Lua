// Analiz raporu. Arayüz, CLI ve kütüphane bu biçimi kullanır; alanlar eklenebilir, var olanlar değişmez.
//
// Report = {
//   detection:  [{ id, name, kind: 'obfuscator'|'packer'|'malware'|'technique', confidence (0-1), version?, evidence: string[] }]
//   protection: null | { product, version, decodable: false, notes: string[] }   ticari koruma (Luraph, Moonsec V3, Luarmor, PSU): yalnızca tanınır
//   threat:     { score (0-100), level: 'none'|'low'|'medium'|'high'|'critical', classes: [{ id, title, evidence: string[] }] }
//   behaviour:  { network: [{ api, target }], commands: [{ api, command }], files: [{ api, path }], loads: number,
//                 other: [{ api, args }] }        sandbox'ta denenen yan etkiler (hiçbiri gerçekten yapılmadı)
//   iocs:       { urls, domains, ips, emails, discordWebhooks, telegram: string[] }
//   metrics:    { inBytes, outBytes, layers, rounds, rollbacks, version, platform }
//   bytecode:   [{ size, version }]   kaynağa çevrilemeyen ikili chunk'lar (string.dump / luac)
//   summary:    string
// }
// Dizgeler (input, output, fx argümanları) bstr'dir: her karakter bir bayt.
import { toText } from './bstr.js';

const NET = /^(game\.Http(Get|Post)(Async)?|HttpGet|HttpPost|request|http_request|syn\.request|http\.(request|Fetch|Post)|HTTP|PerformHttpRequest|socket\.|fluxus\.request)/;
const CMD = /^(os\.execute|io\.popen)$/;
const FILE = /^(io\.open|os\.(remove|rename)|writefile|readfile|appendfile|delfile|makefolder|SaveResourceFile|LoadResourceFile|file\.(Write|Append|Read|Delete)|dofile|loadfile)$/;

const txt = (s) => (typeof s === 'string' ? toText(s) : String(s ?? ''));

export function behaviourOf(fx = [], loads = []) {
  const b = { network: [], commands: [], files: [], loads: loads.length, other: [] };
  for (const [api, args = []] of fx) {
    const first = txt(args[0]);
    if (NET.test(api)) b.network.push({ api, target: first });
    else if (CMD.test(api)) b.commands.push({ api, command: first });
    else if (FILE.test(api)) b.files.push({ api, path: first });
    else b.other.push({ api, args: args.map(txt) });
  }
  return b;
}

/** @param {{ input: string, output: string, trace?: { first?: object, final?: object }, events?: object[], stats?: object, version?: string, platform?: string|null, lang?: 'tr'|'en' }} o */
export function analyze({ input, output, trace = {}, events = [], stats = {}, version = null, platform = null, lang = 'tr' }) {
  const first = trace?.first ?? {};
  return {
    detection: [],
    protection: null,
    threat: { score: 0, level: 'none', classes: [] },
    behaviour: behaviourOf(first.fx, first.loads),
    iocs: { urls: [], domains: [], ips: [], emails: [], discordWebhooks: [], telegram: [] },
    metrics: {
      inBytes: input.length,
      outBytes: output.length,
      layers: stats.layers ?? 0,
      rounds: Math.max(0, ...events.map((e) => e.round ?? 0)),
      rollbacks: events.filter((e) => e.state === 'fail').length,
      version,
      platform,
    },
    bytecode: (first.loads ?? []).filter((l) => l.code.startsWith('\x1bLua')).map((l) => ({ size: l.code.length, version: (l.code.charCodeAt(4) >> 4) + '.' + (l.code.charCodeAt(4) & 15) })),
    lang: lang === 'en' ? 'en' : 'tr',
    summary: '',
  };
}
