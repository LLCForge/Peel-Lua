// peel-lua komut satırı: tarayıcıdakiyle aynı motor, aynı Lua sandbox'ı (Node'da izin modeliyle yalıtılmış alt süreç).
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { peel, passes } from '../index.js';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { reportText } from '../report/text.js';
import { parseArgs, UsageError } from './args.js';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, THREAT: 4 };
export const MAX_INPUT = 50 * 1024 * 1024;
const LEVELS = ['none', 'low', 'medium', 'high', 'critical'];
const PLATFORMS = ['auto', 'roblox', 'fivem', 'gmod'];
const LUA_FILE = /\.(?:lua|luau)$/i;

const SPEC = {
  out: { alias: 'o', type: 'string' },
  'out-dir': { alias: 'd', type: 'string' },
  report: { alias: 'r', type: 'string' },
  json: { type: 'bool' },
  lang: { type: 'string' },
  platform: { alias: 'p', type: 'string' },
  only: { type: 'list' },
  'fail-on': { type: 'string' },
  quiet: { alias: 'q', type: 'bool' },
  help: { alias: 'h', type: 'bool' },
};

const HELP = {
  tr: `peel-lua <dosya|dizin|-> [seçenekler]

Gizlenmiş Lua kodunu WebAssembly Lua sandbox'ında çalıştırarak load/loadstring katmanlarını açar ve analiz raporu üretir.
Ağ, komut ve dosya çağrıları gerçekleştirilmez, yalnızca kaydedilir.

  -o, --out <dosya>        çözülmüş kodu dosyaya yaz (tek girdi; yoksa stdout)
  -d, --out-dir <dizin>    çözülmüş kodları dizine yaz (dizin girdisinde yapı korunur)
  -r, --report <hedef>     rapor: json | text (stdout'a, kod yazılmaz) ya da dosya yolu (.txt ise metin, değilse JSON;
                           dizin girdisinde JSON dizi)
      --json               --report json ile aynı
  -p, --platform <ad>      platform taklitleri: auto (varsayılan, koddan tanınır) | roblox | fivem | gmod
      --only <pass,...>    yalnızca bu geçişler (${passes().map((p) => p.id).join(', ')})
      --lang tr|en         rapor dili (varsayılan tr)
      --fail-on <düzey>    tehdit düzeyi bu eşiğe ulaşırsa çıkış kodu 4: low | medium | high | critical
  -q, --quiet              ilerleme ve özet yazma
  -h, --help               bu yardım

Çıkış kodları: 0 tamam, 1 hata, 2 kullanım hatası, 4 --fail-on eşiğine ulaşıldı (hatadan önceliklidir).
Ticari koruma (Luraph, Moonsec V3, Luarmor, PSU) tanınır ama bilinçli olarak çözülmez.`,
  en: `peel-lua <file|dir|-> [options]

Peels obfuscated Lua by running it inside a WebAssembly Lua sandbox, unwrapping load/loadstring layers, and produces an analysis report.
Network, command and file calls are recorded, never performed.

  -o, --out <file>         write the decoded code to a file (single input; otherwise stdout)
  -d, --out-dir <dir>      write decoded files to a directory (directory input keeps its structure)
  -r, --report <target>    report: json | text (to stdout, no code) or a file path (.txt gives text, anything else JSON;
                           a JSON array for directory input)
      --json               same as --report json
  -p, --platform <name>    platform stubs: auto (default, detected from the code) | roblox | fivem | gmod
      --only <pass,...>    run only these passes (${passes().map((p) => p.id).join(', ')})
      --lang tr|en         report language (default tr)
      --fail-on <level>    exit with code 4 when the threat level reaches: low | medium | high | critical
  -q, --quiet              no progress or summary output
  -h, --help               this help

Exit codes: 0 ok, 1 error, 2 usage error, 4 --fail-on threshold reached (takes precedence over errors).
Commercial protection (Luraph, Moonsec V3, Luarmor, PSU) is identified but intentionally not decoded.`,
};

async function readBytes(path) {
  if (path === '-') {
    const chunks = [];
    let n = 0;
    for await (const c of process.stdin) {
      n += c.length;
      if (n > MAX_INPUT) throw new Error('Girdi çok büyük');
      chunks.push(c);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  const s = await stat(path);
  if (!s.isFile()) throw new Error(`Dosya değil: ${path}`);
  if (s.size > MAX_INPUT) throw new Error(`Dosya çok büyük: ${path}`);
  return new Uint8Array(await readFile(path));
}

/** Dizindeki Lua dosyaları (özyinelemeli, sembolik bağlar izlenmez), sıralı */
async function listLua(root) {
  const out = [];
  const walkDir = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walkDir(p);
      else if (e.isFile() && LUA_FILE.test(e.name)) out.push(p);
    }
  };
  await walkDir(root);
  return out;
}

async function writeOut(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

// kod bstr'dir (her karakter bir bayt): baytlar olduğu gibi yazılır
const bytesOf = (bstr) => Buffer.from(bstr, 'latin1');
const levelOf = (entry) => entry.report?.threat?.level ?? 'none';
const textOf = (entries, isDir, lang) => entries.map((e) => `${isDir ? `== ${e.file} ==\n` : ''}${e.error ? `${lang === 'en' ? 'Error' : 'Hata'}: ${e.error}\n` : ''}${e.report ? reportText(e.report, lang) : ''}`).join('\n');

export async function runCli(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const lang = opts.lang === undefined ? 'tr' : opts.lang;
  if (lang !== 'tr' && lang !== 'en') throw new UsageError(`--lang tr ya da en olmalı: ${lang}`);
  if (opts.help) { console.log(HELP[lang]); return EXIT.OK; }
  if (positional.length !== 1) throw new UsageError(`${HELP[lang]}\n\nTek bir girdi gerekli (dosya, dizin ya da -).`);
  if (opts['fail-on'] !== undefined && !LEVELS.slice(1).includes(opts['fail-on'])) throw new UsageError('--fail-on şunlardan biri olmalı: low, medium, high, critical');
  const platform = opts.platform ?? 'auto';
  if (!PLATFORMS.includes(platform)) throw new UsageError(`--platform şunlardan biri olmalı: ${PLATFORMS.join(', ')}`);
  const ids = passes().map((p) => p.id);
  const only = opts.only.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const unknown = only.filter((x) => !ids.includes(x));
  if (unknown.length) throw new UsageError(`Bilinmeyen geçiş: ${unknown.join(', ')} (geçerli: ${ids.join(', ')})`);
  // -r json|text rapor biçimini stdout'a, başka değer dosya yolunu seçer
  const stdoutReport = opts.json ? 'json' : ['json', 'text'].includes(opts.report) ? opts.report : null;
  const reportFile = opts.report !== undefined && !['json', 'text'].includes(opts.report) ? opts.report : null;

  const target = positional[0];
  const isDir = target !== '-' && (await stat(target).catch(() => null))?.isDirectory();
  if (isDir && opts.out) throw new UsageError('Dizin girdisinde -o yerine -d kullanın');
  const log = (m) => { if (!opts.quiet) process.stderr.write(`${m}\n`); };
  const options = { lang, ...(only.length ? { only } : {}), ...(platform === 'auto' ? {} : { platform }) };

  const sandbox = createNodeSandbox();
  const entries = [];
  try {
    const files = isDir ? await listLua(target) : [target];
    if (isDir && !files.length) log(lang === 'en' ? 'No Lua files found.' : 'Lua dosyası bulunamadı.');
    for (const file of files) {
      const name = file === '-' ? '-' : isDir ? relative(target, file).split('\\').join('/') : file;
      const entry = { file: name, ok: false };
      entries.push(entry);
      let bytes;
      try {
        bytes = await readBytes(file);
      } catch (e) {
        entry.error = e.message;
        log(`${name}: ${e.message}`);
        continue;
      }
      const r = await peel(bytes, { sandbox, ...options });
      Object.assign(entry, { ok: !r.error, error: r.error, verified: Boolean(r.verified), version: r.version ?? null, platform: r.platform ?? null, ms: r.ms ?? 0, report: r.report });
      if (opts['out-dir']) {
        const rel = isDir ? relative(target, file) : file === '-' ? 'stdin.lua' : basename(file);
        const dest = resolve(opts['out-dir'], rel);
        if (relative(resolve(opts['out-dir']), dest).startsWith('..')) throw new Error(`Çıktı dizini dışına yazma: ${rel}`);
        await writeOut(dest, bytesOf(r.code));
      }
      if (opts.out) await writeOut(opts.out, bytesOf(r.code));
      else if (!isDir && !opts['out-dir'] && !stdoutReport) process.stdout.write(bytesOf(r.code));
      const th = r.report.threat;
      log(`${isDir ? `${name}: ` : ''}[${th.level} ${th.score}/100]${r.error ? ` ${r.error};` : ''} ${r.report.summary}`);
    }
  } finally {
    sandbox.close();
  }

  const payload = isDir ? entries : entries[0];
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (reportFile) await writeOut(reportFile, /\.txt$/i.test(reportFile) ? textOf(entries, isDir, lang) : json);
  if (stdoutReport === 'json') process.stdout.write(json);
  else if (stdoutReport === 'text') process.stdout.write(textOf(entries, isDir, lang));

  const failOn = opts['fail-on'];
  if (failOn && entries.some((e) => LEVELS.indexOf(levelOf(e)) >= LEVELS.indexOf(failOn))) return EXIT.THREAT;
  return entries.some((e) => !e.ok) ? EXIT.ERROR : EXIT.OK;
}
