// =====================================================================
//  FuriousX — fonction serveur (Cloudflare Pages Functions)
//  Fichier : functions/api/stock.js   →   adresse : /api/stock
//
//  /api/stock?q=SPCX        → analyse complète d'une action
//  /api/stock?suggest=tesla → suggestions pendant la frappe
//  /api/stock?live=SPCX     → mode Direct : cours + séance du jour (léger, 5 s)
//  /api/stock?brvm=board    → tableau de toutes les actions de la BRVM + indices
//  /api/stock?watch=A,B@BRVM → cours de plusieurs valeurs d'un coup (alertes)
//  /api/stock?sw=1          → petit service worker pour les notifications
//
//  Sources : Yahoo Finance (bourses internationales) ;
//            brvm.org (cours officiels BRVM), sikafinance.com (historique BRVM),
//            Google Actualités (actualités BRVM en français).
// =====================================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const EUR_XOF = 655.957; // parité fixe euro / franc CFA (BCEAO)

let session = null; // { cookie, crumb, at } — réutilisé tant que l'instance vit

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- utilitaires réseau ----------
function timeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), ms)),
  ]);
}

async function yget(path, { ttl = 30, cookie = null, ms = 4500 } = {}) {
  let lastErr = new Error('Source indisponible');
  for (const host of HOSTS) {
    try {
      const headers = { 'User-Agent': UA, Accept: 'application/json' };
      if (cookie) headers.cookie = cookie;
      const r = await timeout(
        fetch(host + path, { headers, cf: { cacheTtl: ttl, cacheEverything: true } }),
        ms
      );
      if (r.ok) return await r.json();
      lastErr = new Error('HTTP ' + r.status);
      lastErr.code = r.status;
      if (r.status === 404) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? o.raw : o ?? null);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

// ---------- Yahoo : recherche ----------
async function search(q, quotesCount = 8, newsCount = 0) {
  const p =
    `/v1/finance/search?q=${encodeURIComponent(q)}` +
    `&quotesCount=${quotesCount}&newsCount=${newsCount}` +
    `&enableFuzzyQuery=true&lang=en-US&region=US`;
  return yget(p, { ttl: 300 });
}

// ---------- Yahoo : historique ----------
async function chart(symbol, range = '5y', interval = '1d', ttl = 30) {
  const p =
    `/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false`;
  const j = await yget(p, { ttl });
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.meta) throw new HttpError(404, 'Pas de données pour ' + symbol);
  return res;
}

function compactSeries(res) {
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const out = { t: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c == null || !isFinite(c)) continue;
    out.t.push(ts[i]);
    out.c.push(r4(c));
    out.h.push(r4(q.high && q.high[i] != null ? q.high[i] : c));
    out.l.push(r4(q.low && q.low[i] != null ? q.low[i] : c));
    out.v.push(q.volume && q.volume[i] != null ? q.volume[i] : 0);
  }
  return out;
}

// ---------- conversion en FCFA ----------
async function toXof(currency) {
  if (!currency) return null;
  let cur = currency, factor = 1;
  if (cur === 'GBp' || cur === 'GBX') { cur = 'GBP'; factor = 0.01; }
  if (cur === 'ZAc') { cur = 'ZAR'; factor = 0.01; }
  if (cur === 'ILA') { cur = 'ILS'; factor = 0.01; }
  cur = cur.toUpperCase();
  if (cur === 'XOF') return factor;
  if (cur === 'EUR') return factor * EUR_XOF;
  const fx = await chart(`EUR${cur}=X`, '5d', '1d', 3600);
  const rate = fx.meta.regularMarketPrice;
  if (!rate) return null;
  return (factor * EUR_XOF) / rate;
}

// ---------- Yahoo : fiche société + analystes (nécessite un "crumb") ----------
async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 45 * 60 * 1000) return session;
  const r1 = await timeout(
    fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' }),
    2500
  );
  let parts = [];
  if (typeof r1.headers.getSetCookie === 'function') parts = r1.headers.getSetCookie();
  else parts = (r1.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  const cookie = parts.map((s) => s.split(';')[0].trim()).filter(Boolean).join('; ');
  if (!cookie) throw new Error('cookie absent');
  const r2 = await timeout(
    fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, cookie },
    }),
    2500
  );
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('crumb absent');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

async function summary(symbol) {
  const modules =
    'summaryProfile,financialData,summaryDetail,defaultKeyStatistics,calendarEvents,recommendationTrend';
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    try {
      const j = await yget(
        `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}` +
          `&crumb=${encodeURIComponent(s.crumb)}`,
        { ttl: 900, cookie: s.cookie, ms: 2500 }
      );
      const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (!r) return null;
      return shapeSummary(r);
    } catch (e) {
      if (e.code !== 401 && e.code !== 403) throw e; // sinon : nouveau crumb et on réessaie
    }
  }
  return null;
}

function shapeSummary(r) {
  const p = r.summaryProfile || {};
  const f = r.financialData || {};
  const d = r.summaryDetail || {};
  const k = r.defaultKeyStatistics || {};
  const cal = r.calendarEvents || {};
  const tr = (r.recommendationTrend && r.recommendationTrend.trend) || [];
  const now = tr.find((x) => x.period === '0m') || tr[0] || null;
  const earn = ((cal.earnings && cal.earnings.earningsDate) || []).map(raw).filter(Boolean);
  return {
    profile: {
      sector: p.sector || null,
      industry: p.industry || null,
      country: p.country || null,
      city: p.city || null,
      website: p.website || null,
      employees: p.fullTimeEmployees || null,
      summary: p.longBusinessSummary || null,
    },
    analysts: {
      targetMean: raw(f.targetMeanPrice),
      targetHigh: raw(f.targetHighPrice),
      targetLow: raw(f.targetLowPrice),
      key: f.recommendationKey || null,
      mean: raw(f.recommendationMean),
      count: raw(f.numberOfAnalystOpinions),
      trend: now
        ? {
            strongBuy: now.strongBuy || 0,
            buy: now.buy || 0,
            hold: now.hold || 0,
            sell: now.sell || 0,
            strongSell: now.strongSell || 0,
          }
        : null,
    },
    fundamentals: {
      marketCap: raw(d.marketCap),
      pe: raw(d.trailingPE),
      forwardPe: raw(d.forwardPE),
      beta: raw(d.beta),
      dividendYield: raw(d.dividendYield),
      revenue: raw(f.totalRevenue),
      revenueGrowth: raw(f.revenueGrowth),
      profitMargin: raw(f.profitMargins),
      roe: raw(f.returnOnEquity),
      debtToEquity: raw(f.debtToEquity),
      freeCashflow: raw(f.freeCashflow),
      priceToBook: raw(k.priceToBook),
      shares: raw(k.sharesOutstanding),
    },
    events: {
      earnings: earn,
      exDividend: raw(cal.exDividendDate),
      dividendDate: raw(cal.dividendDate),
    },
  };
}

// =====================================================================
//  BRVM — Bourse Régionale des Valeurs Mobilières (Abidjan, zone UEMOA)
// =====================================================================
const COUNTRY = { ci: 'Côte d’Ivoire', sn: 'Sénégal', bj: 'Bénin', bf: 'Burkina Faso', ml: 'Mali', ne: 'Niger', tg: 'Togo' };
// [symbole, nom affiché, pays, secteur, alias de recherche séparés par |]
const BRVM_LIST = [
  ['ABJC', 'Servair Abidjan', 'ci', 'Consommation discrétionnaire', 'SERVAIR'],
  ['BBGC', 'Bridge Bank Group CI', 'ci', 'Services financiers', 'BRIDGE BANK|BRIDGE BANK GROUP'],
  ['BICB', 'BIIC Bénin', 'bj', 'Services financiers', 'BIIC'],
  ['BICC', 'BICI Côte d’Ivoire', 'ci', 'Services financiers', 'BICICI|BICI'],
  ['BNBC', 'Bernabé CI', 'ci', 'Consommation discrétionnaire', 'BERNABE'],
  ['BOAB', 'Bank of Africa Bénin', 'bj', 'Services financiers', 'BOA BENIN'],
  ['BOABF', 'Bank of Africa Burkina Faso', 'bf', 'Services financiers', 'BOA BURKINA|BOA BURKINA FASO'],
  ['BOAC', 'Bank of Africa Côte d’Ivoire', 'ci', 'Services financiers', 'BOA CI|BOA COTE D IVOIRE'],
  ['BOAM', 'Bank of Africa Mali', 'ml', 'Services financiers', 'BOA MALI'],
  ['BOAN', 'Bank of Africa Niger', 'ne', 'Services financiers', 'BOA NIGER'],
  ['BOAS', 'Bank of Africa Sénégal', 'sn', 'Services financiers', 'BOA SENEGAL'],
  ['CABC', 'Sicable CI', 'ci', 'Industriels', 'SICABLE'],
  ['CBIBF', 'Coris Bank International', 'bf', 'Services financiers', 'CORIS|CORIS BANK'],
  ['CFAC', 'CFAO Motors CI', 'ci', 'Consommation discrétionnaire', 'CFAO MOTORS|CFAO CI'],
  ['CIEC', 'CIE Côte d’Ivoire', 'ci', 'Services publics', 'CIE|CIE CI'],
  ['ECOC', 'Ecobank Côte d’Ivoire', 'ci', 'Services financiers', 'ECOBANK CI'],
  ['ETIT', 'Ecobank Transnational (ETI)', 'tg', 'Services financiers', 'ETI|ECOBANK TRANSNATIONAL'],
  ['FTSC', 'Filtisac CI', 'ci', 'Industriels', 'FILTISAC'],
  ['LNBB', 'Loterie Nationale du Bénin', 'bj', 'Consommation discrétionnaire', 'LNB|LOTERIE NATIONALE DU BENIN'],
  ['NEIC', 'NEI-CEDA CI', 'ci', 'Consommation discrétionnaire', 'NEI CEDA'],
  ['NSBC', 'NSIA Banque CI', 'ci', 'Services financiers', 'NSIA|NSIA BANQUE'],
  ['NTLC', 'Nestlé Côte d’Ivoire', 'ci', 'Consommation de base', 'NESTLE CI'],
  ['ONTBF', 'Onatel Burkina Faso', 'bf', 'Télécommunications', 'ONATEL'],
  ['ORAC', 'Orange Côte d’Ivoire', 'ci', 'Télécommunications', 'ORANGE CI|ORANGE COTE D IVOIRE'],
  ['ORGT', 'Oragroup Togo', 'tg', 'Services financiers', 'ORAGROUP'],
  ['PALC', 'Palm Côte d’Ivoire', 'ci', 'Consommation de base', 'PALMCI|PALM CI'],
  ['PRSC', 'Tractafric Motors CI', 'ci', 'Consommation discrétionnaire', 'TRACTAFRIC'],
  ['SAFC', 'Safca CI', 'ci', 'Services financiers', 'SAFCA'],
  ['SCRC', 'Sucrivoire', 'ci', 'Consommation de base', 'SUCRIVOIRE'],
  ['SDCC', 'Sodeci', 'ci', 'Services publics', 'SODECI'],
  ['SDSC', 'Africa Global Logistics CI', 'ci', 'Industriels', 'AGL CI|AFRICA GLOBAL LOGISTICS'],
  ['SEMC', 'Eviosys Packaging Siem CI', 'ci', 'Industriels', 'EVIOSYS|SIEM|CROWN SIEM'],
  ['SGBC', 'Société Générale Côte d’Ivoire', 'ci', 'Services financiers', 'SGCI|SG CI|SOCIETE GENERALE CI'],
  ['SHEC', 'Vivo Energy CI', 'ci', 'Énergie', 'VIVO ENERGY|VIVO ENERGY CI|SHELL CI'],
  ['SIBC', 'Société Ivoirienne de Banque', 'ci', 'Services financiers', 'SIB'],
  ['SICC', 'Sicor CI', 'ci', 'Consommation de base', 'SICOR'],
  ['SIVC', 'Erium CI', 'ci', 'Industriels', 'ERIUM|AIR LIQUIDE CI'],
  ['SLBC', 'Solibra CI', 'ci', 'Consommation de base', 'SOLIBRA'],
  ['SMBC', 'SMB Côte d’Ivoire', 'ci', 'Énergie', 'SMB'],
  ['SNTS', 'Sonatel Sénégal', 'sn', 'Télécommunications', 'SONATEL'],
  ['SOGC', 'SOGB CI', 'ci', 'Consommation de base', 'SOGB'],
  ['SPHC', 'SAPH Côte d’Ivoire', 'ci', 'Consommation de base', 'SAPH'],
  ['STAC', 'Setao CI', 'ci', 'Industriels', 'SETAO'],
  ['STBC', 'Sitab CI', 'ci', 'Consommation de base', 'SITAB'],
  ['TTLC', 'TotalEnergies Marketing CI', 'ci', 'Énergie', 'TOTAL CI|TOTALENERGIES CI'],
  ['TTLS', 'TotalEnergies Marketing Sénégal', 'sn', 'Énergie', 'TOTAL SENEGAL|TOTALENERGIES SENEGAL'],
  ['UNLC', 'Unilever Côte d’Ivoire', 'ci', 'Consommation de base', 'UNILEVER CI'],
  ['UNXC', 'Uniwax CI', 'ci', 'Consommation discrétionnaire', 'UNIWAX'],
];
const BRVM_INDEX = [
  ['BRVMC', 'Indice BRVM Composite', 'BRVM|BRVM COMPOSITE|COMPOSITE'],
  ['BRVM30', 'Indice BRVM 30', 'BRVM 30'],
  ['BRVMPR', 'Indice BRVM Prestige', 'BRVM PRESTIGE|PRESTIGE'],
];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  .replace(/[’'`´\-_.,()]/g, ' ').replace(/\s+/g, ' ').trim();
const BRVM = new Map();
for (const [s, n, c, sec, al] of BRVM_LIST) BRVM.set(s, { symbol: s, name: n, country: c, sector: sec, aliases: al.split('|'), index: false });
for (const [s, n, al] of BRVM_INDEX) BRVM.set(s, { symbol: s, name: n, country: null, sector: 'Indice boursier', aliases: al.split('|'), index: true });

function brvmResolve(q) {
  const k = norm(q);
  const m = k.match(/^(?:BRVM\s+)?([A-Z0-9]{3,7})(?:\s+BRVM)?$/);
  if (m && BRVM.has(m[1])) return BRVM.get(m[1]);
  const compact = k.replace(/\s/g, '');
  if (BRVM.has(compact)) return BRVM.get(compact);
  for (const it of BRVM.values()) {
    if (norm(it.name) === k || it.aliases.some((a) => norm(a) === k)) return it;
  }
  return null;
}
function brvmSuggest(q) {
  const k = norm(q); if (k.length < 2) return [];
  const kc = k.replace(/\s/g, '');
  const out = [];
  for (const it of BRVM.values()) {
    const hay = [norm(it.name), ...it.aliases.map(norm)];
    const al = it.aliases.map(norm);
    const score = it.symbol.startsWith(kc) ? 3 : al.some((h) => h.startsWith(k)) ? 2.5 : hay.some((h) => h.startsWith(k)) ? 2 : hay.some((h) => h.includes(k)) ? 1 : 0;
    if (score) out.push([score, it]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 6)
    .map(([, it]) => ({ symbol: it.symbol, name: it.name, exch: 'BRVM', type: it.index ? 'Indice' : 'Action' }));
}

// ---------- outils de lecture ----------
function decodeHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;|&rsquo;/g, '’')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
const cleanCell = (h) => decodeHtml(String(h).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function num(x) {
  if (typeof x === 'number') return x;
  let t = String(x ?? '').replace(/[\s  %+]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(t);
  return isFinite(v) ? v : NaN;
}
function countryFromName(name) {
  const k = norm(name);
  if (k.includes('COTE D IVOIRE')) return 'ci';
  if (k.includes('SENEGAL')) return 'sn';
  if (k.includes('BENIN')) return 'bj';
  if (k.includes('BURKINA')) return 'bf';
  if (k.includes('MALI')) return 'ml';
  if (k.includes('NIGER')) return 'ne';
  if (k.includes('TOGO')) return 'tg';
  return 'ci';
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
function parseDay(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Math.floor(s > 1e11 ? s / 1000 : s);
  const str = String(s);
  let m = str.match(/Date\((\d+)\)/); if (m) return Math.floor(+m[1] / 1000);
  m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], 15) / 1000;
  m = str.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 15) / 1000;
  return null;
}
function brvmOpenNow() {
  const d = new Date(), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd >= 1 && wd <= 5 && m >= 540 && m < 900; // 9h00 – 15h00 GMT
}
function brvmSessionDay() { // date (15h GMT) de la dernière séance commencée
  const d = new Date(); let wd = d.getUTCDay();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15) / 1000;
  if (wd >= 1 && wd <= 5 && m >= 585) return t; // ouverture à 9h45
  do { t -= 86400; wd = (wd + 6) % 7; } while (wd === 0 || wd === 6);
  return t;
}

// ---------- cours du jour : brvm.org (toutes les actions en 1 requête) ----------
let brvmTabMem = null;
async function brvmTable() {
  if (brvmTabMem && Date.now() - brvmTabMem.at < 55000) return brvmTabMem;
  const r = await timeout(fetch('https://www.brvm.org/fr/cours-actions/0', {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-FR,fr;q=0.9' },
    cf: { cacheTtl: 60, cacheEverything: true },
  }), 7000);
  if (!r.ok) throw new Error('BRVM HTTP ' + r.status);
  const html = await r.text();
  const rows = [], seen = new Set();
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const td = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanCell(m[1]));
    if (td.length < 7 || !/^[A-Z0-9]{3,7}$/.test(td[0]) || seen.has(td[0])) continue;
    const row = { symbol: td[0], name: td[1], volume: num(td[2]), prev: num(td[3]), open: num(td[4]), close: num(td[5]), var: num(td[6]) };
    if (!isFinite(row.close) || row.close <= 0) continue;
    seen.add(row.symbol); rows.push(row);
    if (!BRVM.has(row.symbol)) {
      const nm = row.name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
      BRVM.set(row.symbol, { symbol: row.symbol, name: nm, country: countryFromName(row.name), sector: null, aliases: [], index: false });
    }
  }
  if (rows.length < 10) throw new Error('Tableau BRVM illisible');
  brvmTabMem = { at: Date.now(), rows };
  return brvmTabMem;
}

// ---------- historique : sikafinance (fenêtres de 90 jours) ----------
async function sikaWindow(ticker, from, to, ttl) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`https://cache.furiousx.app/sika/${encodeURIComponent(ticker)}/${from}/${to}`);
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit.json();
  }
  const r = await timeout(fetch('https://www.sikafinance.com/api/general/GetHistos', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.sikafinance.com', Referer: 'https://www.sikafinance.com/marches/historiques/' + ticker,
    },
    body: JSON.stringify({ ticker, datedeb: from, datefin: to, xperiod: '0' }),
  }), 4500);
  if (!r.ok) throw new Error('sika HTTP ' + r.status);
  const j = await r.json();
  const lst = (j && (j.lst || j.Lst || j.data)) || [];
  const rows = [];
  for (const o of Array.isArray(lst) ? lst : []) {
    if (!o || typeof o !== 'object') continue;
    const g = (k) => { for (const kk of Object.keys(o)) if (kk.toLowerCase() === k) return o[kk]; return undefined; };
    const t = parseDay(g('date')), c = num(g('close'));
    if (!t || !isFinite(c) || c <= 0) continue;
    const op = num(g('open')), h = num(g('high')), l = num(g('low')), v = num(g('volume'));
    rows.push({ t, c, o: op > 0 ? op : c, h: h > 0 ? h : c, l: l > 0 ? l : c, v: isFinite(v) ? v : 0 });
  }
  if (cache && rows.length) {
    await cache.put(key, new Response(JSON.stringify(rows), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    })).catch(() => {});
  }
  return rows;
}
async function sikaHtml(ticker) { // secours : page « historiques » (environ 3 mois)
  const r = await timeout(fetch('https://www.sikafinance.com/marches/historiques/' + ticker, {
    headers: { 'User-Agent': UA, Accept: 'text/html' }, cf: { cacheTtl: 600, cacheEverything: true },
  }), 7000);
  if (!r.ok) throw new Error('sika page HTTP ' + r.status);
  const html = await r.text(), rows = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const td = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanCell(m[1]));
    if (td.length < 6) continue;
    const t = parseDay(td[0]), c = num(td[1]);
    if (!t || !(c > 0)) continue;
    const l = num(td[2]), h = num(td[3]), o = num(td[4]), v = num(td[5]);
    rows.push({ t, c, l: l > 0 ? l : c, h: h > 0 ? h : c, o: o > 0 ? o : c, v: isFinite(v) ? v : 0 });
  }
  return rows.sort((a, b) => a.t - b.t);
}
async function brvmHistory(ticker, windows = 12) {
  // fenêtres de 90 jours alignées sur le calendrier : les anciennes restent en cache 1 jour
  const day = Math.floor(Date.now() / 86400000), k0 = Math.floor(day / 90), jobs = [];
  for (let k = k0; k > k0 - windows; k--) {
    const from = ymd(k * 90 * 86400000), to = ymd(Math.min(k * 90 + 89, day) * 86400000);
    jobs.push(sikaWindow(ticker, from, to, k === k0 ? 300 : 86400));
  }
  const res = await Promise.allSettled(jobs);
  const map = new Map();
  for (const r of res) if (r.status === 'fulfilled') for (const row of r.value) map.set(row.t, row);
  let rows = [...map.values()].sort((a, b) => a.t - b.t);
  if (rows.length < 2) rows = await sikaHtml(ticker).catch(() => []);
  return rows;
}

const histMem = new Map(); // évite de tout retélécharger à chaque analyse
async function brvmHistoryCached(ticker, windows) {
  const key = `${ticker}|${windows}|${Math.floor(Date.now() / 86400000)}`;
  const m = histMem.get(key);
  if (m && Date.now() - m.at < 10 * 60000) return m.rows.map((r) => ({ ...r }));
  const rows = await brvmHistory(ticker, windows);
  if (rows.length > 1) {
    histMem.set(key, { at: Date.now(), rows });
    if (histMem.size > 80) histMem.delete(histMem.keys().next().value);
  }
  return rows.map((r) => ({ ...r }));
}

// ---------- actualités en français : Google Actualités ----------
async function gnews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=fr&gl=CI&ceid=CI:fr`;
  const r = await timeout(fetch(url, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 900, cacheEverything: true } }), 3000);
  if (!r.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map((m) => {
    const x = m[1];
    const g = (tag) => { const mm = x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return mm ? decodeHtml(mm[1]).trim() : ''; };
    let title = g('title');
    const source = g('source');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(g('pubDate'));
    return { title, publisher: source, link: g('link'), time: isFinite(t) ? Math.floor(t / 1000) : null, thumb: null, tickers: [] };
  }).filter((n) => n.title && n.link);
}
async function brvmNews(info) {
  if (info.index) return (await gnews('BRVM bourse Abidjan').catch(() => [])).slice(0, 8);
  const short = info.aliases.find((a) => !a.includes(' ')) || info.name;
  const [a, b] = await Promise.all([gnews(`${short} BRVM`).catch(() => []), gnews(`"${info.name}"`).catch(() => [])]);
  const items = a.slice();
  for (const n of b) if (!items.some((x) => x.title === n.title)) items.push(n);
  return items.sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 8);
}

// ---------- analyse complète d'une valeur BRVM ----------
async function analyseBRVM(info, fast) {
  const t0 = Date.now();
  const ticker = info.index ? info.symbol : `${info.symbol}.${info.country}`;
  // mode rapide : 6 mois d'historique et pas d'actualités → affichage immédiat ;
  // l'application demande ensuite l'analyse complète (3 ans + actualités) en arrière-plan
  const [tabR, histR, newsR] = await Promise.allSettled([
    info.index ? Promise.resolve(null) : brvmTable(),
    brvmHistoryCached(ticker, fast ? 2 : 12),
    fast ? Promise.resolve([]) : brvmNews(info),
  ]);
  const rows = histR.status === 'fulfilled' ? histR.value : [];
  const row = tabR.status === 'fulfilled' && tabR.value ? tabR.value.rows.find((r) => r.symbol === info.symbol) : null;

  // la séance du jour vient de brvm.org si l'historique ne l'a pas encore
  const sess = brvmSessionDay(), last = rows[rows.length - 1];
  if (row && last && Math.abs(last.t - sess) < 3600) {
    last.c = row.close; last.h = Math.max(last.h, row.close); last.l = Math.min(last.l, row.close);
    if (row.volume > 0) last.v = row.volume;
  } else if (row && (!last || last.t < sess - 3600) && (!last || row.close !== last.c || row.volume !== last.v)) {
    const o = row.open > 0 ? row.open : row.close;
    rows.push({ t: sess, c: row.close, o, h: Math.max(o, row.close), l: Math.min(o, row.close), v: row.volume || 0 });
  }
  if (rows.length < 2) {
    if (!row && !info.index) throw new HttpError(502, 'Les données de la BRVM ne répondent pas pour le moment. Réessayez dans un instant.');
    throw new HttpError(502, `Historique de ${info.symbol} momentanément indisponible. Réessayez dans un instant.`);
  }
  const n = rows.length, lr = rows[n - 1], y1 = rows.slice(-252);
  const price = row ? row.close : lr.c;
  const prevClose = row && isFinite(row.var) && row.var > -100 ? row.close / (1 + row.var / 100) : rows[n - 2].c;
  const marketOpen = brvmOpenNow(), today = Math.abs(lr.t - sess) < 3600;
  return {
    symbol: info.symbol,
    name: info.name,
    exchange: 'BRVM',
    type: info.index ? 'INDEX' : 'EQUITY',
    currency: info.index ? '' : 'XOF',
    timezone: 'Africa/Abidjan',
    price,
    prevClose,
    dayHigh: today ? lr.h : null,
    dayLow: today ? lr.l : null,
    volume: row ? row.volume : today ? lr.v : null,
    high52: Math.max(...y1.map((r) => r.h)),
    low52: Math.min(...y1.map((r) => r.l)),
    marketTime: marketOpen ? Math.floor(Date.now() / 1000) : lr.t,
    firstTrade: null,
    marketOpen,
    sector: info.sector,
    industry: info.country ? COUNTRY[info.country] : 'Bourse régionale UEMOA',
    toXof: info.index ? null : 1,
    history: { t: rows.map((r) => r.t), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c), v: rows.map((r) => r.v) },
    intraday: null,
    news: newsR.status === 'fulfilled' ? newsR.value : [],
    profile: info.index ? null : { sector: info.sector, industry: null, country: COUNTRY[info.country] || null, city: null, website: null, employees: null, summary: null },
    analysts: null,
    fundamentals: null,
    events: null,
    alternatives: [...BRVM.values()].filter((x) => x.symbol !== info.symbol && x.index === info.index && x.sector === info.sector)
      .slice(0, 4).map((x) => ({ symbol: x.symbol, name: x.name, exch: 'BRVM' })),
    partial: !!fast,
    serverMs: Date.now() - t0,
  };
}

// ---------- mode Direct BRVM ----------
async function liveBRVM(info) {
  const open = brvmOpenNow();
  if (info.index) {
    const rows = await brvmHistory(info.symbol, 2);
    if (rows.length < 2) throw new HttpError(502, 'Indice indisponible');
    const a = rows[rows.length - 1], b = rows[rows.length - 2];
    return { symbol: info.symbol, price: a.c, prevClose: b.c, marketTime: open ? Math.floor(Date.now() / 1000) : null, marketOpen: open, dayHigh: null, dayLow: null, volume: null, intraday: null };
  }
  const tab = await brvmTable();
  const row = tab.rows.find((r) => r.symbol === info.symbol);
  if (!row) throw new HttpError(404, 'Cours BRVM indisponible pour ' + info.symbol);
  return {
    symbol: info.symbol, price: row.close,
    prevClose: isFinite(row.var) && row.var > -100 ? row.close / (1 + row.var / 100) : null,
    marketTime: open ? Math.floor(Date.now() / 1000) : null, marketOpen: open,
    dayHigh: null, dayLow: null, volume: isFinite(row.volume) ? row.volume : null, intraday: null,
  };
}

// ---------- tableau de toutes les valeurs BRVM ----------
async function brvmBoard() {
  const [tabR, ...idx] = await Promise.allSettled([brvmTable(), ...BRVM_INDEX.map(([s]) => brvmHistory(s, 2))]);
  if (tabR.status !== 'fulfilled') throw new HttpError(502, 'Le site de la BRVM ne répond pas pour le moment.');
  const items = tabR.value.rows.map((r) => {
    const info = BRVM.get(r.symbol) || {};
    return { symbol: r.symbol, name: info.name || r.name, country: info.country || null, sector: info.sector || null, price: r.close, open: r.open, var: r.var, volume: r.volume };
  });
  const indices = BRVM_INDEX.map(([s, n], i) => {
    const r = idx[i];
    if (r.status !== 'fulfilled' || r.value.length < 2) return null;
    const a = r.value[r.value.length - 1], b = r.value[r.value.length - 2];
    return { symbol: s, name: n.replace('Indice ', ''), value: a.c, var: (a.c / b.c - 1) * 100, date: a.t };
  }).filter(Boolean);
  return { items, indices, marketOpen: brvmOpenNow(), updated: Math.floor(tabR.value.at / 1000) };
}

// ---------- analyse complète ----------
async function analyse(q, fast) {
  const t0 = Date.now();
  const query = q.trim();
  const brvmInfo = brvmResolve(query); // Sonatel, SAPH, SNTS, SPHC… → BRVM
  if (brvmInfo) return analyseBRVM(brvmInfo, fast);
  const guess = query.toUpperCase().replace(/\s+/g, '');
  const looksLikeTicker = /^[A-Z0-9.\-=^]{1,15}$/.test(guess);

  // 1) recherche + historique en parallèle (gagne du temps si le symbole est exact)
  const [sRes, cRes] = await Promise.allSettled([
    search(query, 6, 10),
    looksLikeTicker ? chart(guess) : Promise.reject(new Error('pas un symbole')),
  ]);
  const found = sRes.status === 'fulfilled' ? sRes.value : null;
  const quotes = ((found && found.quotes) || []).filter((x) => x.symbol);

  let ch;
  if (cRes.status === 'fulfilled' && (cRes.value.timestamp || []).length > 1) {
    ch = cRes.value;
  } else {
    const order = ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND', 'CRYPTOCURRENCY', 'CURRENCY', 'FUTURE'];
    const best =
      quotes.find((x) => x.quoteType === 'EQUITY') ||
      quotes.find((x) => order.includes(x.quoteType)) ||
      quotes[0];
    if (!best) {
      if (!found && cRes.status === 'rejected')
        throw new HttpError(502, 'La source de données ne répond pas. Réessayez dans un instant.');
      throw new HttpError(404, `Aucune action trouvée pour « ${query} ».`);
    }
    ch = await chart(best.symbol);
  }

  const meta = ch.meta;
  const symbol = meta.symbol;
  const match = quotes.find((x) => x.symbol === symbol) || {};

  // 2) intraday, FCFA, fiche société en parallèle (la fiche est facultative)
  const [iRes, xRes, sumRes] = await Promise.allSettled([
    chart(symbol, '1d', '1m', 15),
    toXof(meta.currency),
    timeout(summary(symbol), 3000),
  ]);

  const history = compactSeries(ch);
  if (history.c.length < 2) throw new HttpError(404, 'Historique indisponible pour ' + symbol);

  let intraday = null, prevClose = null, dayHigh = meta.regularMarketDayHigh, dayLow = meta.regularMarketDayLow;
  if (iRes.status === 'fulfilled') {
    const im = iRes.value.meta;
    prevClose = im.chartPreviousClose ?? im.previousClose ?? null;
    const s = compactSeries(iRes.value);
    if (s.c.length > 1) intraday = { t: s.t, c: s.c };
    dayHigh = dayHigh ?? im.regularMarketDayHigh;
    dayLow = dayLow ?? im.regularMarketDayLow;
  }
  const price = meta.regularMarketPrice ?? history.c[history.c.length - 1];
  if (prevClose == null) {
    const n = history.c.length;
    const lastDay = new Date(history.t[n - 1] * 1000).toISOString().slice(0, 10);
    const mktDay = new Date((meta.regularMarketTime || history.t[n - 1]) * 1000).toISOString().slice(0, 10);
    prevClose = lastDay === mktDay ? history.c[n - 2] : history.c[n - 1];
  }

  const ctp = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const nowS = Date.now() / 1000;
  const marketOpen = !!(ctp && nowS >= ctp.start && nowS <= ctp.end);

  const news = ((found && found.news) || []).slice(0, 10).map((n) => {
    const res = (n.thumbnail && n.thumbnail.resolutions) || [];
    const small = res.find((r) => r.tag === '140x140') || res[res.length - 1] || null;
    return {
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: n.providerPublishTime,
      thumb: small ? small.url : null,
      tickers: n.relatedTickers || [],
    };
  });

  const extra = sumRes.status === 'fulfilled' ? sumRes.value : null;

  return {
    symbol,
    name: meta.longName || meta.shortName || match.longname || match.shortname || symbol,
    exchange: meta.fullExchangeName || match.exchDisp || meta.exchangeName || '',
    type: meta.instrumentType || match.quoteType || '',
    currency: meta.currency || '',
    timezone: meta.exchangeTimezoneName || '',
    price,
    prevClose,
    dayHigh: dayHigh ?? null,
    dayLow: dayLow ?? null,
    volume: meta.regularMarketVolume ?? null,
    high52: meta.fiftyTwoWeekHigh ?? null,
    low52: meta.fiftyTwoWeekLow ?? null,
    marketTime: meta.regularMarketTime || null,
    firstTrade: meta.firstTradeDate || null,
    marketOpen,
    sector: match.sectorDisp || match.sector || (extra && extra.profile.sector) || null,
    industry: match.industryDisp || match.industry || (extra && extra.profile.industry) || null,
    toXof: xRes.status === 'fulfilled' ? xRes.value : null,
    history,
    intraday,
    news,
    profile: extra ? extra.profile : null,
    analysts: extra ? extra.analysts : null,
    fundamentals: extra ? extra.fundamentals : null,
    events: extra ? extra.events : null,
    alternatives: quotes
      .filter((x) => x.symbol !== symbol)
      .slice(0, 4)
      .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exch: x.exchDisp || '' })),
    serverMs: Date.now() - t0,
  };
}

// ---------- mode Direct : réponse légère, rafraîchie toutes les 5 s ----------
async function live(symbol, exchange) {
  if (exchange === 'BRVM') {
    const info = brvmResolve(symbol);
    if (!info) throw new HttpError(404, 'Valeur BRVM inconnue : ' + symbol);
    return liveBRVM(info);
  }
  const res = await chart(symbol, '1d', '1m', 5);
  const m = res.meta;
  const s = compactSeries(res);
  const ctp = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const nowS = Date.now() / 1000;
  return {
    symbol: m.symbol,
    price: m.regularMarketPrice ?? (s.c.length ? s.c[s.c.length - 1] : null),
    prevClose: m.chartPreviousClose ?? m.previousClose ?? null,
    marketTime: m.regularMarketTime || null,
    marketOpen: !!(ctp && nowS >= ctp.start && nowS <= ctp.end),
    dayHigh: m.regularMarketDayHigh ?? null,
    dayLow: m.regularMarketDayLow ?? null,
    volume: m.regularMarketVolume ?? null,
    intraday: s.c.length > 1 ? { t: s.t, c: s.c } : null,
  };
}

// ---------- cours de plusieurs valeurs d'un coup (surveillance des alertes) ----------
async function watch(list) {
  const syms = list.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);
  const quotes = await Promise.all(syms.map(async (key) => {
    try {
      if (key.endsWith('@BRVM')) {
        const info = brvmResolve(key.slice(0, -5));
        if (!info) throw new Error('inconnu');
        return Object.assign({ key, currency: info.index ? '' : 'XOF' }, await liveBRVM(info));
      }
      const res = await chart(key, '1d', '1d', 20);
      const m = res.meta, ctp = m.currentTradingPeriod && m.currentTradingPeriod.regular, nowS = Date.now() / 1000;
      return {
        key, symbol: m.symbol, currency: m.currency || '', price: m.regularMarketPrice ?? null,
        prevClose: m.chartPreviousClose ?? m.previousClose ?? null, marketTime: m.regularMarketTime || null,
        marketOpen: !!(ctp && nowS >= ctp.start && nowS <= ctp.end),
        dayHigh: m.regularMarketDayHigh ?? null, dayLow: m.regularMarketDayLow ?? null,
      };
    } catch (e) {
      return { key, error: true };
    }
  }));
  return { quotes };
}

const SW_CODE = `// FuriousX — service worker minimal : affiche les notifications d'alerte
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'open', url }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});`;

async function suggest(q) {
  const local = brvmSuggest(q);
  let remote = [];
  try {
    const s = await search(q, 8, 0);
    remote = (s.quotes || []).filter((x) => x.symbol).map((x) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname || x.symbol,
      exch: x.exchDisp || x.exchange || '',
      type: x.typeDisp || x.quoteType || '',
    }));
  } catch (e) {
    if (!local.length) throw e;
  }
  return { items: [...local, ...remote.filter((r) => !local.some((l) => l.symbol === r.symbol))].slice(0, 9) };
}

// ---------- point d'entrée ----------
export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (url.searchParams.has('sw')) {
    return new Response(SW_CODE, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
  }
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(url.toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit;
  }

  let body, status = 200, ttl = 30;
  try {
    if (url.searchParams.has('live')) {
      const sym = (url.searchParams.get('live') || '').trim();
      if (!sym || sym.length > 20) throw new HttpError(400, 'Symbole manquant.');
      body = await live(sym, url.searchParams.get('x') || '');
      ttl = 5;
    } else if (url.searchParams.has('watch')) {
      body = await watch(url.searchParams.get('watch') || '');
      ttl = 20;
    } else if (url.searchParams.has('brvm')) {
      body = await brvmBoard();
      ttl = 60;
    } else if (url.searchParams.has('suggest')) {
      const q = (url.searchParams.get('suggest') || '').trim();
      body = q ? await suggest(q) : { items: [] };
      ttl = 300;
    } else {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) throw new HttpError(400, 'Entrez le symbole ou le nom d’une action.');
      if (q.length > 60) throw new HttpError(400, 'Recherche trop longue.');
      body = await analyse(q, url.searchParams.get('fast') === '1');
    }
  } catch (e) {
    status = e.status || 502;
    body = { error: e.status ? e.message : 'La source de données ne répond pas. Réessayez dans un instant.' };
  }

  const resp = new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? `public, max-age=${ttl}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  });
  if (cache && status === 200 && context.waitUntil) {
    context.waitUntil(cache.put(key, resp.clone()).catch(() => {}));
  }
  return resp;
}
