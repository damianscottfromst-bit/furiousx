// =====================================================================
//  FuriousX — alertes Telegram, actives même quand l'application est fermée
//  Fichier : functions/api/alerts.js   →   adresse : /api/alerts
//
//  Réglages Cloudflare (projet Pages « furiousx ») :
//    • liaison KV     : FX_KV           (stockage du portefeuille et des alertes)
//    • secret         : TELEGRAM_TOKEN  (jeton donné par @BotFather)
//    • secret         : ALERT_KEY       (votre code secret FuriousX)
//  Un Worker « furiousx-cron » appelle /api/alerts?run toutes les 5 minutes.
//
//  /api/alerts?status   → état de la connexion (appli)
//  /api/alerts?link     → relie automatiquement votre compte Telegram
//  /api/alerts?test     → envoie un message d'essai
//  /api/alerts?sync     → (POST) enregistre le portefeuille et les règles d'alerte
//  /api/alerts?run      → vérifie tout et envoie les alertes (Worker toutes les 5 min)
//  Toutes les actions exigent l'en-tête « x-fx-key » = ALERT_KEY.
// =====================================================================

import { onRequestGet as stockApi } from './stock.js';

const OWNER = 'stonebridgemichael'; // votre nom d'utilisateur Telegram, sans le @

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ok = (x) => typeof x === 'number' && isFinite(x);

// ---------- mise en forme (français) ----------
const nf = (x, d = 2) => x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 1, sign = true) => (sign && x > 0 ? '+' : '') + nf(x * 100, d) + ' %';
const sgn = (x) => (x > 0 ? '+' : '');
const curLabel = (c) => (c === 'XOF' ? 'FCFA' : c === 'GBp' ? 'GBX' : c || '');
function fmtP(x, cur) {
  if (!ok(x)) return '—';
  if (cur === 'XOF') return nf(x, 0) + ' FCFA';
  const a = Math.abs(x);
  return nf(x, a >= 1 || a === 0 ? 2 : 4) + (cur ? ' ' + curLabel(cur) : '');
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pfKey = (it) => (it.exch === 'BRVM' ? it.symbol + '@BRVM' : it.symbol);

// ---------- appel direct à /api/stock (même serveur, sans repasser par Internet) ----------
async function api(ctx, qs) {
  const url = new URL('/api/stock?' + qs, ctx.request.url);
  const r = await stockApi({
    request: new Request(url.toString()),
    env: ctx.env,
    waitUntil: (p) => (ctx.waitUntil ? ctx.waitUntil(p) : p),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

// ---------- moteur du signal (identique à l'application) ----------
function sma(a, p) {
  const o = new Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; }
  return o;
}
function ema(a, p) {
  const o = new Array(a.length).fill(NaN);
  const i0 = a.findIndex((x) => ok(x));
  if (i0 < 0 || a.length - i0 < p) return o;
  let s = 0; for (let i = i0; i < i0 + p; i++) s += a[i];
  let e = s / p; o[i0 + p - 1] = e; const k = 2 / (p + 1);
  for (let i = i0 + p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function rsi(c, p = 14) {
  const o = new Array(c.length).fill(NaN); if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function atr(h, l, c, p = 14) {
  const n = c.length, o = new Array(n).fill(NaN); if (n <= p) return o;
  const tr = [h[0] - l[0]];
  for (let i = 1; i < n; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let a = 0; for (let i = 1; i <= p; i++) a += tr[i]; a /= p; o[p] = a;
  for (let i = p + 1; i < n; i++) { a = (a * (p - 1) + tr[i]) / p; o[i] = a; }
  return o;
}
function rollStd(a, p) {
  const o = new Array(a.length).fill(NaN);
  for (let i = p - 1; i < a.length; i++) {
    let m = 0; for (let j = i - p + 1; j <= i; j++) m += a[j]; m /= p;
    let v = 0; for (let j = i - p + 1; j <= i; j++) v += (a[j] - m) ** 2;
    o[i] = Math.sqrt(v / p);
  }
  return o;
}
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
function rsiScore(r) {
  if (r < 30) return Math.min(1, (30 - r) / 30 + 0.35);
  if (r < 40) return -0.4 + ((40 - r) / 10) * 0.4;
  if (r <= 60) return ((r - 50) / 10) * 0.4;
  if (r <= 70) return 0.4 - ((r - 60) / 10) * 0.4;
  return -Math.min(1, (r - 70) / 30 + 0.35);
}
function signalNow(H) {
  const c = H.c, i = c.length - 1, p = c[i];
  if (c.length < 25) return null;
  const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200), R = rsi(c, 14), A = atr(H.h, H.l, c, 14);
  const e12 = ema(c, 12), e26 = ema(c, 26), macd = c.map((_, k) => e12[k] - e26[k]), sg = ema(macd, 9), hist = macd.map((m, k) => m - sg[k]);
  const sd = rollStd(c, 20), pb = (p - (s20[i] - 2 * sd[i])) / (4 * sd[i]);
  const parts = [], tr = [];
  if (ok(s20[i])) tr.push(clamp((p / s20[i] - 1) / 0.05));
  if (ok(s50[i])) tr.push(clamp((p / s50[i] - 1) / 0.08));
  if (ok(s200[i]) && ok(s50[i])) tr.push(clamp((s50[i] / s200[i] - 1) / 0.06));
  if (tr.length) parts.push([0.3, tr.reduce((a, b) => a + b, 0) / tr.length]);
  if (ok(hist[i]) && ok(A[i]) && A[i] > 0) {
    let m = clamp(hist[i] / (0.5 * A[i])) * 0.7;
    if (ok(hist[i - 3])) m += Math.sign(hist[i] - hist[i - 3]) * 0.3;
    parts.push([0.2, clamp(m)]);
  }
  if (ok(R[i])) parts.push([0.2, clamp(rsiScore(R[i]))]);
  if (i >= 63) parts.push([0.15, clamp((p / c[i - 63] - 1) / 0.25)]);
  else if (i >= 20) parts.push([0.15, clamp((p / c[i - 20] - 1) / 0.12)]);
  if (sd[i] > 0 && ok(pb)) parts.push([0.15, clamp((0.5 - pb) * 0.8)]);
  if (parts.length < 3) return null;
  let sw = 0, s = 0; for (const [w, v] of parts) { sw += w; s += w * v; }
  const score = Math.round((100 * s) / sw);
  return { score, key: score >= 40 ? 'buy' : score >= 15 ? 'acc' : score > -20 ? 'hold' : 'sell' };
}
const SIG = { buy: 'ACHETER', acc: 'ACCUMULER', hold: 'GARDER', sell: 'VENDRE' };

// ---------- actualités qui peuvent faire bouger le cours ----------
const NEWS_CAT = [
  ['Dirigeants', /(\b(ceo|cfo|coo|pdg|dg|pca|chairman|chairwoman)\b|président du conseil|president du conseil|président-directeur|directeur général|directrice générale|directeur general|conseil d.administration|\bboard\b|nomination|nommé|nomme |appoint|names new|chief .{0,20}officer|démission|demission|resign|steps? down|succession|limog|ousted|remplac)/i],
  ['Résultats', /(résultat|resultat|results|earnings|bénéfice|benefice|profit|chiffre d.affaires|revenue|\bsales\b|trimestr|quarter|semestr|guidance|prévision|prevision|outlook|forecast|\bperte|\bloss)/i],
  ['Actionnaires', /(dividend|rachat d.actions|buyback|\bsplit\b|augmentation de capital|capital increase|share offering|stock offering|émission d.actions|emission d.actions|introduction en bourse|\bipo\b)/i],
  ['Opérations', /(acquisition|acquiert|rachète|rachete|fusion|merger|takeover|rapprochement|cession|partenariat|partnership|alliance|contrat|contract|agreement)/i],
  ['Justice & régulation', /(enquête|enquete|investigation|probe|procès|\bproces\b|lawsuit|\bsued\b|poursuite|sanction|amende|\bfine[sd]?\b|régulat|regulat|\bsec\b|antitrust|fraude|fraud|plainte|suspension|suspend|recall|rappel de produit|\bban(s|ned)?\b)/i],
  ['Analystes', /(upgrade|downgrade|relève son|releve son|abaisse|objectif de cours|price target|\brating|recommandation|outperform|underperform)/i],
];
const NEWS_POS = /(hausse|record|\bbond|progress|croissance|\bbeats?\b|dépasse|depasse|surpass|upgrade|relève|releve|augment|\braises?\b|\bsoar|\bjump|surge|rally|\bgains?\b|rachat d.actions|buyback|remporte|\bwins?\b|approuv|approval|optimis)/i;
const NEWS_NEG = /(baisse|chute|plonge|recul|\bperte|\bloss|\bmiss(es)?\b|downgrade|abaisse|\bcuts?\b|réduit|reduit|démission|demission|resign|steps? down|enquête|enquete|investigation|probe|lawsuit|procès|amende|\bfine[sd]?\b|fraud|suspend|recall|warning|avertissement|plunge|\bfalls?\b|\bdrops?\b|slump|tumble|\bdelay|retard|annul|cancel|déficit|deficit|concern|inquiét|inquiet|worr)/i;
function classifyNews(t) {
  const cats = NEWS_CAT.filter(([, re]) => re.test(t)).map(([c]) => c);
  if (!cats.length) return null;
  const p = NEWS_POS.test(t), n = NEWS_NEG.test(t);
  return { cat: cats[0], dir: p && !n ? '↑ plutôt favorable' : n && !p ? '↓ plutôt défavorable' : 'incertain', lvl: p && !n ? 'good' : n && !p ? 'bad' : 'warn' };
}

// ---------- règles d'alerte (identiques à l'application) ----------
function evalAlerts(it, q, out) {
  const p = q.price; if (!ok(p)) return;
  if (!ok(it.peak) || p > it.peak) it.peak = p;
  const A = it.alerts || {}, F = it.fired || (it.fired = {}), cur = it.currency;
  const add = (kind, text, lvl) => out.push({ it, kind, text, lvl });
  if (ok(A.target)) {
    if (p >= A.target && !F.target) { F.target = 1; add('target', `🎯 Objectif atteint : ${fmtP(p, cur)} (objectif ${fmtP(A.target, cur)}).${ok(it.buyPrice) ? ` Plus-value : ${pct(p / it.buyPrice - 1)}.` : ''} Pensez à sécuriser tout ou partie de vos gains.`, 'good'); }
    else if (p < A.target * 0.98) F.target = 0;
  }
  if (ok(A.stop)) {
    if (p <= A.stop && !F.stop) { F.stop = 1; add('stop', `🛑 Stop atteint : ${fmtP(p, cur)} (seuil ${fmtP(A.stop, cur)}).${ok(it.buyPrice) ? ` Résultat : ${pct(p / it.buyPrice - 1)}.` : ''} Décidez si vous limitez la perte.`, 'bad'); }
    else if (p > A.stop * 1.02) F.stop = 0;
  }
  if (ok(A.trail) && ok(it.peak)) {
    if (p <= it.peak * (1 - A.trail / 100) && F.trailPeak !== it.peak) {
      F.trailPeak = it.peak;
      const g = ok(it.buyPrice) ? p / it.buyPrice - 1 : NaN;
      const tail = !ok(g) ? '' : g > 0
        ? ` Vous êtes encore en plus-value de ${pct(g)}${ok(it.qty) ? ` (${sgn(g)}${fmtP((p - it.buyPrice) * it.qty, cur)})` : ''} : c’est le moment d’envisager de sécuriser vos gains.`
        : ` Vous êtes maintenant en moins-value de ${pct(g)}.`;
      add('trail', `📉 Recul de ${pct(1 - p / it.peak, 1, false)} depuis le plus haut (${fmtP(it.peak, cur)}) : ${fmtP(p, cur)}.${tail}`, g > 0 ? 'warn' : 'bad');
    }
  }
  if (ok(A.move) && q.marketOpen && ok(q.prevClose) && q.prevClose > 0) {
    const ch = p / q.prevClose - 1, tag = new Date().toISOString().slice(0, 10) + (ch > 0 ? '+' : '-');
    if (Math.abs(ch) * 100 >= A.move && F.moveDay !== tag) {
      F.moveDay = tag;
      add('move', ch > 0 ? `🚀 Forte hausse aujourd’hui : ${pct(ch)} à ${fmtP(p, cur)}.` : `⚠️ Forte baisse aujourd’hui : ${pct(ch)} à ${fmtP(p, cur)}.`, ch > 0 ? 'good' : 'bad');
    }
  }
}
function deepCheck(it, j, out) {
  const A = it.alerts || {};
  if (j.history && j.history.c && j.history.c.length > 25) {
    const s = signalNow(j.history);
    if (s) {
      if (A.signal && it.lastSignal && it.lastSignal !== s.key)
        out.push({ it, kind: 'signal', lvl: s.key === 'buy' || s.key === 'acc' ? 'good' : s.key === 'sell' ? 'bad' : 'warn', text: `🔄 Signal FuriousX : ${SIG[it.lastSignal]} → ${SIG[s.key]} (score ${sgn(s.score)}${s.score}/100). Ouvrez la fiche pour voir la fiabilité mesurée.` });
      it.lastSignal = s.key;
    }
  }
  const seen = new Set(it.seen || []), first = !it.seen;
  let sent = 0;
  for (const n of j.news || []) {
    const id = n.link || n.title; if (!id || seen.has(id)) continue;
    seen.add(id);
    if (first || !A.news || sent >= 3) continue;
    const c = classifyNews(n.title || '');
    if (c && (!n.time || Date.now() / 1000 - n.time < 72 * 3600)) {
      sent++;
      out.push({ it, kind: 'news', lvl: c.lvl, link: n.link, text: `📰 ${c.cat} : ${n.title}\nImpact probable sur le cours : ${c.dir} (estimation automatique, à vérifier).` });
    }
  }
  it.seen = [...seen].slice(-150);
}

// ---------- Telegram ----------
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'réponse illisible' }));
  return j;
}
const sendText = (env, chatId, html) => tg(env, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
function alertHtml(st, a) {
  const app = `${st.base || ''}/#${encodeURIComponent(a.it.symbol)}`;
  return `<b>🔔 FuriousX · ${esc(a.it.symbol)}</b> — ${esc(a.it.name || '')}\n\n${esc(a.text)}\n\n` +
    (a.link ? `<a href="${esc(a.link)}">Lire l’article</a> · ` : '') + `<a href="${esc(app)}">Ouvrir l’analyse FuriousX</a>`;
}

// ---------- stockage ----------
async function loadState(env) {
  const raw = await env.FX_KV.get('state');
  const st = raw ? JSON.parse(raw) : {};
  st.items = Array.isArray(st.items) ? st.items : [];
  st.log = Array.isArray(st.log) ? st.log : [];
  return st;
}
const saveState = (env, st) => env.FX_KV.put('state', JSON.stringify(st));

const numOrNull = (x) => (ok(x) && x > 0 ? x : null);
const str = (x, n = 120) => (typeof x === 'string' ? x.slice(0, n) : null);
function sanitize(items) {
  return (Array.isArray(items) ? items : []).slice(0, 30).filter((c) => c && typeof c.symbol === 'string' && c.symbol.length <= 20).map((c) => {
    const A = c.alerts || {};
    return {
      symbol: c.symbol, name: str(c.name), exch: str(c.exch, 40), currency: str(c.currency, 8), tz: str(c.tz, 40),
      qty: numOrNull(c.qty), buyPrice: numOrNull(c.buyPrice), buyDate: str(c.buyDate, 10),
      alerts: { target: numOrNull(A.target), stop: numOrNull(A.stop), trail: numOrNull(A.trail), move: numOrNull(A.move), signal: !!A.signal, news: !!A.news },
      peak: numOrNull(c.peak), fired: c.fired && typeof c.fired === 'object' ? c.fired : {},
      lastSignal: SIG[c.lastSignal] ? c.lastSignal : null,
      seen: Array.isArray(c.seen) ? c.seen.filter((x) => typeof x === 'string').slice(-150).map((x) => x.slice(0, 400)) : null,
    };
  });
}
const rulesOf = (x) => JSON.stringify([x.alerts || null, x.buyPrice || null, x.buyDate || null]);
function merge(server, client) {
  return client.map((c) => {
    const s = server.find((x) => x.symbol === c.symbol);
    if (!s) return Object.assign(c, { deepAt: 0 });
    const same = rulesOf(s) === rulesOf(c);
    let fired = c.fired, peak = c.peak;
    if (same) { // mêmes règles : on garde ce qui a déjà été envoyé
      const sf = s.fired || {}, cf = c.fired || {};
      fired = {
        target: sf.target || cf.target || 0,
        stop: sf.stop || cf.stop || 0,
        trailPeak: Math.max(sf.trailPeak || 0, cf.trailPeak || 0) || undefined,
        moveDay: [sf.moveDay, cf.moveDay].filter(Boolean).sort().pop(),
      };
      peak = Math.max(s.peak || 0, c.peak || 0) || null;
    }
    const seen = s.seen || c.seen ? [...new Set([...(s.seen || []), ...(c.seen || [])])].slice(-150) : null;
    return Object.assign(c, { fired, peak, seen, lastSignal: s.lastSignal || c.lastSignal, deepAt: s.deepAt || 0 });
  });
}

// ---------- vérification complète (appelée toutes les 5 minutes) ----------
async function run(ctx, st) {
  const out = [];
  if (!st.chatId || !st.items.length) {
    st.lastRun = Date.now(); await saveState(ctx.env, st);
    return { checked: 0, alerts: 0, sent: 0, note: st.chatId ? 'aucune valeur suivie' : 'Telegram non relié' };
  }
  try {
    const w = await api(ctx, 'watch=' + encodeURIComponent(st.items.map(pfKey).join(',')));
    for (const q of w.quotes || []) {
      const it = st.items.find((x) => pfKey(x) === q.key);
      if (it && !q.error) evalAlerts(it, q, out);
    }
  } catch (e) { /* source momentanément indisponible : on réessaiera dans 5 min */ }
  // signal + actualités : une valeur par passage (chaque valeur environ toutes les 15 min)
  const it = st.items.slice().sort((a, b) => (a.deepAt || 0) - (b.deepAt || 0))[0];
  if (it && Date.now() - (it.deepAt || 0) > 14 * 60000) {
    it.deepAt = Date.now();
    try { deepCheck(it, await api(ctx, 'q=' + encodeURIComponent(it.symbol)), out); } catch (e) {}
  }
  let sent = 0;
  for (const a of out.slice(0, 8)) {
    const r = await sendText(ctx.env, st.chatId, alertHtml(st, a));
    if (r.ok) sent++;
    st.log.unshift({ id: 'tg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), at: Date.now(), symbol: a.it.symbol, name: a.it.name, kind: a.kind, msg: a.text, level: a.lvl, link: a.link || null, tg: !!r.ok });
  }
  st.log = st.log.slice(0, 60);
  st.lastRun = Date.now();
  await saveState(ctx.env, st);
  return { checked: st.items.length, alerts: out.length, sent };
}

function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- point d'entrée ----------
export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const J = (o, status = 200) => new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  try {
    if (!env.FX_KV) throw new HttpError(503, 'Stockage KV non relié : ajoutez la liaison « FX_KV » au projet Cloudflare Pages, puis redéployez.');
    if (!env.ALERT_KEY) throw new HttpError(503, 'Secret « ALERT_KEY » absent : ajoutez-le dans les réglages du projet Cloudflare Pages, puis redéployez.');
    if (!sameKey(request.headers.get('x-fx-key') || '', env.ALERT_KEY)) throw new HttpError(401, 'Code secret incorrect.');
    const st = await loadState(env);
    if (!url.searchParams.has('run')) st.base = url.origin; // adresse de l'appli pour les liens Telegram

    if (url.searchParams.has('status')) {
      return J({
        ok: true, token: !!env.TELEGRAM_TOKEN, linked: !!st.chatId, chatName: st.chatName || null,
        items: st.items.length, lastRun: st.lastRun || null, log: st.log.slice(0, 40),
        // portefeuille complet (sans l'historique des actualités) : retrouvé sur tous vos appareils
        state: st.items.map((x) => ({
          symbol: x.symbol, name: x.name, exch: x.exch, currency: x.currency, tz: x.tz,
          qty: x.qty, buyPrice: x.buyPrice, buyDate: x.buyDate, alerts: x.alerts,
          peak: x.peak, fired: x.fired, lastSignal: x.lastSignal, rules: rulesOf(x),
        })),
      });
    }
    if (!env.TELEGRAM_TOKEN) throw new HttpError(503, 'Secret « TELEGRAM_TOKEN » absent : ajoutez le jeton de votre bot dans Cloudflare, puis redéployez.');

    if (url.searchParams.has('link')) {
      const me = await tg(env, 'getMe');
      if (!me.ok) throw new HttpError(400, 'Jeton Telegram refusé : vérifiez TELEGRAM_TOKEN (copiez-le à nouveau depuis @BotFather).');
      const up = await tg(env, 'getUpdates', { limit: 100, allowed_updates: ['message'] });
      const msgs = (up.result || []).map((u) => u.message).filter((m) => m && m.chat && m.chat.type === 'private');
      const mine = msgs.filter((m) => m.from && String(m.from.username || '').toLowerCase() === OWNER);
      const isOwner = mine.length > 0;
      const m = (isOwner ? mine : msgs)[(isOwner ? mine : msgs).length - 1];
      if (!m) throw new HttpError(404, `Aucun message reçu par @${me.result.username} : ouvrez ce bot dans Telegram, appuyez sur « DÉMARRER » (ou écrivez « bonjour »), puis réessayez.`);
      st.chatId = m.chat.id;
      st.chatName = [m.from && m.from.first_name, m.from && m.from.username ? '@' + m.from.username : ''].filter(Boolean).join(' ');
      st.bot = me.result.username;
      await saveState(env, st);
      await sendText(env, st.chatId, `✅ <b>FuriousX est connecté à Telegram.</b>\n\nVous recevrez ici vos alertes, même quand l’application est fermée : objectifs, stops, stop suiveur, fortes variations, changements de signal et actualités importantes (dirigeants, résultats, dividendes, fusions, justice).\n\nVérification automatique toutes les 5 minutes.`);
      return J({ ok: true, linked: true, chatName: st.chatName, bot: st.bot, owner: isOwner });
    }
    if (url.searchParams.has('test')) {
      if (!st.chatId) throw new HttpError(400, 'Telegram n’est pas encore relié.');
      const r = await sendText(env, st.chatId, `🧪 <b>Test FuriousX</b>\n\nTout fonctionne : ${st.items.length} valeur${st.items.length > 1 ? 's' : ''} sous surveillance.${st.lastRun ? `\nDernière vérification automatique : ${new Date(st.lastRun).toISOString().slice(11, 16)} (heure d’Abidjan).` : '\n⚠️ La vérification automatique n’a pas encore tourné : vérifiez le Worker « furiousx-cron ».'}`);
      if (!r.ok) throw new HttpError(502, 'Telegram a refusé l’envoi : ' + (r.description || 'erreur inconnue'));
      return J({ ok: true });
    }
    if (url.searchParams.has('sync')) {
      if (request.method !== 'POST') throw new HttpError(405, 'Utilisez POST.');
      const body = await request.json().catch(() => ({}));
      st.items = merge(st.items, sanitize(body.items));
      await saveState(env, st);
      return J({ ok: true, items: st.items.length });
    }
    if (url.searchParams.has('run')) return J(await run(ctx, st));
    throw new HttpError(400, 'Action inconnue.');
  } catch (e) {
    return J({ error: e.message || 'Erreur' }, e.status || 500);
  }
}
