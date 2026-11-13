// IOC çıkarımı: URL, alan adı, IP, e-posta, Discord webhook, Telegram bot token/chat id, kod indirme adresleri
// (paste/raw barındırma). Platform ve belge alanları (roblox.com API'leri, github.com, lua.org…) "benign"a ayrılır.
// Tarayıcıda da çalışır (saf JS).
import { rx } from './text.js';

// Platform/belge/üretici alanları: IOC listesinden çıkarılıp "benign"a yazılır (alt alanlar dahil)
const BENIGN = ['roblox.com', 'rbxcdn.com', 'robloxlabs.com', 'github.com', 'lua.org', 'luau-lang.org', 'luau.org', 'fivem.net', 'forum.cfx.re',
  'garrysmod.com', 'facepunch.com', 'example.com', 'example.org', 'example.net', 'w3.org', 'wearedevs.net', 'lura.ph'];
const isBenign = (host) => BENIGN.some((d) => host === d || host.endsWith(`.${d}`));
// kod/yük indirmek için kötüye kullanılan paste ve ham dosya barındırma servisleri
export const DOWNLOAD_HOSTS = /^(?:pastebin\.com|paste\.ee|hastebin\.com|rentry\.(?:co|org)|ghostbin\.\w+|raw\.githubusercontent\.com|gist\.githubusercontent\.com|cdn\.discordapp\.com|media\.discordapp\.net|transfer\.sh|files\.catbox\.moe|gofile\.io|bitbucket\.org|pastefy\.app|api\.luarmor\.net)$/i;
// github.com zararsızdır, ama ham dosya ve sürüm indirme yolları indirme adresidir
const githubDownload = (h, url) => /^github\.com$/i.test(h) && /\/(?:raw|releases\/download)\//i.test(url);

const RE = {
  url: /\b(?:https?|ftp|wss?):\/\/[^\s'"<>()\\{}|^`[\]]+/gi,
  email: /(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g,
  ip: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g,
  tgToken: /(?:(?<=bot)|(?<![\w:]))\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/g,
  tgChat: /chat_?id['"\]]?\s*[:=]\s*['"]?(-?\d{5,16})/gi,
  discord: rx(['https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/(?:v\\d+/)?', 'webhooks/\\d+/[\\w-]+'], 'g'),
};

const hostOf = (url) => {
  const m = url.match(/^[a-z][a-z+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null;
};
const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
// sürüm numarası gibi görünen (1.2.3.4) adaylar da gürültüdür ama ayırt edilemez; yalnızca yerel/yayın adresleri atılır
const boringIp = (ip) => /^(?:0\.|127\.|255\.255\.255\.255$)/.test(ip);

/**
 * @param {string[]} texts taranacak metinler (girdi, katmanlar, çıktı, dizge sabitleri, sandbox yan etki argümanları)
 * @param {string[]} hosts sandbox'ın bağlanmaya çalıştığı adresler
 * @returns {{ urls, domains, ips, emails, discordWebhooks, telegram, downloads, benign: string[] }}
 */
export function iocs(texts, hosts = []) {
  const sets = { urls: new Set(), domains: new Set(), ips: new Set(), emails: new Set(), discordWebhooks: new Set(), telegram: new Set(), downloads: new Set(), benign: new Set() };
  const addHost = (h) => {
    if (!h) return;
    if (isIp(h)) { if (!boringIp(h)) sets.ips.add(h); return; }
    if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(h) || h === 'localhost') return;
    (isBenign(h) ? sets.benign : sets.domains).add(h);
  };
  for (const text of texts) {
    if (!text) continue;
    for (const [u] of text.matchAll(RE.url)) {
      const url = u.replace(/[.,;:!?'")\]]+$/, '');
      const h = hostOf(url);
      if (!h) continue;
      if (isBenign(h) && !githubDownload(h, url)) { sets.benign.add(h); continue; }
      sets.urls.add(url);
      if (DOWNLOAD_HOSTS.test(h) || githubDownload(h, url)) sets.downloads.add(url);
      if (!githubDownload(h, url)) addHost(h);
    }
    for (const [u] of text.matchAll(RE.discord)) sets.discordWebhooks.add(u);
    for (const [e] of text.matchAll(RE.email)) {
      const host = e.split('@')[1].toLowerCase();
      if (/\.(?:png|jpe?g|gif|svg|webp|css|js|lua)$/i.test(host) || isBenign(host)) continue;
      sets.emails.add(e);
    }
    for (const [ip] of text.matchAll(RE.ip)) if (!boringIp(ip)) sets.ips.add(ip);
    for (const [tok] of text.matchAll(RE.tgToken)) sets.telegram.add(`bot:${tok}`);
    for (const m of text.matchAll(RE.tgChat)) sets.telegram.add(`chat_id:${m[1]}`);
  }
  for (const h of hosts) {
    const s = String(h);
    if (/^[a-z][a-z+.-]*:\/\//i.test(s)) addHost(hostOf(s));
  }
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()]));
}
