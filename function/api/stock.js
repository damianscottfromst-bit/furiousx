// =====================================================================
//  FuriousX — fonction serveur (Cloudflare Pages Functions)
//  Fichier : functions/api/stock.js   →   adresse : /api/stock
//
//  /api/stock?q=SPCX        → analyse complète d'une action
//  /api/stock?suggest=tesla → suggestions pendant la frappe
//
//  Source des données : Yahoo Finance (endpoints publics, gratuits,
//  cours différés d'environ 15 min selon la bourse).
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

// ---------- analyse complète ----------
async function analyse(q) {
  const t0 = Date.now();
  const query = q.trim();
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
    chart(symbol, '1d', '5m', 30),
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

async function suggest(q) {
  const s = await search(q, 8, 0);
  return {
    items: (s.quotes || [])
      .filter((x) => x.symbol)
      .slice(0, 8)
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exch: x.exchDisp || x.exchange || '',
        type: x.typeDisp || x.quoteType || '',
      })),
  };
}

// ---------- point d'entrée ----------
export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(url.toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit;
  }

  let body, status = 200, ttl = 30;
  try {
    if (url.searchParams.has('suggest')) {
      const q = (url.searchParams.get('suggest') || '').trim();
      body = q ? await suggest(q) : { items: [] };
      ttl = 300;
    } else {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) throw new HttpError(400, 'Entrez le symbole ou le nom d’une action.');
      if (q.length > 60) throw new HttpError(400, 'Recherche trop longue.');
      body = await analyse(q);
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
