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
//  /api/alerts?digest   → envoie tout de suite un résumé du portefeuille
//  /api/alerts?prefs    → (POST) active / désactive les résumés du matin et du soir
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
const NEWS_POS = /(hausse|record|\bbond|progress|croissance|\bbeats?\b|dépasse|depasse|surpass|upgrade|relève|releve|augment|\braises?\b|\bsoar|\bjump|surge|rally|\bgains?\b|rachat d.actions|buyback|remporte|\bwins?\b|approuv|approval|optimis|edges? up|\brises?\b|climb|higher)/i;
const NEWS_NEG = /(baisse|chute|plonge|recul|\bperte|\bloss|\bmiss(es)?\b|downgrade|abaisse|\bcuts?\b|réduit|reduit|démission|demission|resign|steps? down|enquête|enquete|investigation|probe|lawsuit|procès|amende|\bfine[sd]?\b|fraud|suspend|recall|warning|avertissement|plunge|\bfalls?\b|\bdrops?\b|slump|tumble|\bdelay|retard|annul|cancel|déficit|deficit|concern|inquiét|inquiet|worr|edges? down|\blower\b|\bslides?\b|\bsinks?\b)/i;
// l'actualité parle-t-elle vraiment de cette société ? (évite les articles « voisins »)
function aboutCompany(it, title) {
  const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const t = plain(title), sym = plain(it.symbol).split('.')[0];
  if (sym.length >= 2 && new RegExp('\\b' + sym.replace(/[^a-z0-9]/g, '') + '\\b').test(t)) return true;
  const first = plain(it.name).split(/[^a-z0-9]+/).find((w) => w.length >= 3 && !['the', 'bank', 'banque', 'societe', 'groupe', 'group', 'compagnie'].includes(w));
  return !!first && t.includes(first);
}
function classifyNews(t) {
  const cats = NEWS_CAT.filter(([, re]) => re.test(t)).map(([c]) => c);
  if (!cats.length) return null;
  const p = NEWS_POS.test(t), n = NEWS_NEG.test(t);
  return { cat: cats[0], dir: p && !n ? '↑ plutôt favorable' : n && !p ? '↓ plutôt défavorable' : 'incertain', lvl: p && !n ? 'good' : n && !p ? 'bad' : 'warn' };
}

// ---------- règles d'alerte (identiques à l'application) ----------
function evalAlerts(it, q, out) {
  const p = q.price; if (!ok(p)) return;
  it.lastPrice = p;
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
        : ` Vous êtes maintenant en moins-value de ${pct(-g, 1, false)}.`;
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
    if (c && aboutCompany(it, n.title) && (!n.time || Date.now() / 1000 - n.time < 72 * 3600)) {
      sent++;
      out.push({ it, kind: 'news', lvl: c.lvl, link: n.link, text: `📰 ${c.cat} : ${n.title}\nImpact probable sur le cours : ${c.dir} (estimation automatique, à vérifier).` });
    }
  }
  it.seen = [...seen].slice(-150);
  // variation habituelle d'une séance (moyenne des 60 derniers jours), utile avant les résultats
  if (j.history && j.history.c && j.history.c.length > 21) {
    const c = j.history.c.slice(-61); let sum = 0, k = 0;
    for (let i = 1; i < c.length; i++) if (c[i - 1] > 0) { sum += Math.abs(c[i] / c[i - 1] - 1); k++; }
    if (k) it.dayMove = sum / k;
  }
  // pour le résumé quotidien : taux FCFA et prochains événements
  if (ok(j.toXof)) it.toXof = j.toXof;
  const now = Date.now() / 1000, ev = j.events;
  if (ev) { // si la fiche société est momentanément indisponible, on garde les dates déjà connues
    it.nextEarnings = ((ev.earnings || []).filter((t) => ok(t) && t > now - 3600).sort((a, b) => a - b)[0]) || null;
    it.exDiv = ok(ev.exDividend) && ev.exDividend > now - 3600 ? ev.exDividend : null;
  }
  if (ok(it.nextEarnings) && it.nextEarnings < now - 3600) it.nextEarnings = null;
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
      alerts: { target: numOrNull(A.target), stop: numOrNull(A.stop), trail: numOrNull(A.trail), move: numOrNull(A.move), signal: !!A.signal, news: !!A.news, earnings: A.earnings !== false },
      toXof: numOrNull(c.toXof), peak: numOrNull(c.peak), fired: c.fired && typeof c.fired === 'object' ? c.fired : {},
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
    // résultats / dividende déjà annoncés : liés à la date de l'événement, pas aux règles
    const sf2 = s.fired || {}, cf2 = c.fired || {};
    fired = Object.assign({}, fired, {
      earn: [sf2.earn, cf2.earn].filter(Boolean).sort().pop(),
      exdiv: [sf2.exdiv, cf2.exdiv].filter(Boolean).sort().pop(),
    });
    const seen = s.seen || c.seen ? [...new Set([...(s.seen || []), ...(c.seen || [])])].slice(-150) : null;
    return Object.assign(c, { fired, peak, seen, lastSignal: s.lastSignal || c.lastSignal, deepAt: s.deepAt || 0, toXof: c.toXof || s.toXof || null, nextEarnings: s.nextEarnings || null, exDiv: s.exDiv || null, lastPrice: s.lastPrice || null, dayMove: s.dayMove || null });
  });
}

// ---------- résumé quotidien (matin avant la BRVM, soir après New York) ----------
function tzParts(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(date);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, wd: g('weekday'), min: (+g('hour') % 24) * 60 + +g('minute') };
}
function tzOffsetMin(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = (t) => +((p.find((x) => x.type === t) || {}).value || 0);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - date.getTime()) / 60000);
}
const hhmm = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + 'h' + String(m % 60).padStart(2, '0'); };
const weekday = (wd) => wd !== 'Sat' && wd !== 'Sun';
const prefsOf = (st) => Object.assign({ morning: true, evening: true }, st.prefs || {});
function digestDue(st, now) {
  const pr = prefsOf(st), d = st.digest || {};
  const utc = tzParts('UTC', now), ny = tzParts('America/New_York', now);
  if (pr.morning && weekday(utc.wd) && utc.min >= 8 * 60 + 30 && utc.min < 12 * 60 && d.morning !== utc.ymd) return { kind: 'morning', tag: utc.ymd };
  if (pr.evening && weekday(ny.wd) && ny.min >= 16 * 60 + 15 && d.evening !== ny.ymd) return { kind: 'evening', tag: ny.ymd };
  return null;
}
// ---------- la veille des résultats et du détachement du dividende ----------
function eventDay(it, ts) { // date de l'événement dans le fuseau de la bourse (date seule si l'heure n'est pas connue)
  const dateOnly = ts % 86400 === 0;
  return { day: dateOnly ? new Date(ts * 1000).toISOString().slice(0, 10) : tzParts(it.tz || 'UTC', new Date(ts * 1000)).ymd, dateOnly };
}
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
function whenTxt(it, ts, dateOnly) {
  if (dateOnly) return '';
  const abj = new Date(ts * 1000).toISOString().slice(11, 16).replace(':', 'h');
  if (it.tz === 'America/New_York') {
    const m = tzParts('America/New_York', new Date(ts * 1000)).min;
    if (m < 570) return ` avant l’ouverture de New York (vers ${abj} à Abidjan)`;
    if (m >= 960) return ` après la clôture de New York (vers ${abj} à Abidjan)`;
    return ` pendant la séance (vers ${abj} à Abidjan)`;
  }
  return ` (vers ${abj} à Abidjan)`;
}
function levelsTxt(it) {
  const A = it.alerts || {}, cur = it.currency, lv = [];
  if (ok(A.trail) && ok(it.peak)) lv.push(`stop suiveur ${fmtP(it.peak * (1 - A.trail / 100), cur)}`);
  if (ok(A.stop)) lv.push(`stop ${fmtP(A.stop, cur)}`);
  if (ok(A.target)) lv.push(`objectif ${fmtP(A.target, cur)}`);
  return lv.length ? lv.join(' · ') : '';
}
function positionTxt(it) {
  if (!ok(it.qty) || !ok(it.buyPrice) || !ok(it.lastPrice)) return '';
  const g = it.lastPrice / it.buyPrice - 1;
  return `\nVotre position : ${nf(it.qty, 0)} × ${fmtP(it.buyPrice, it.currency)} → ${pct(g)} (${sgn(g)}${fmtP((it.lastPrice - it.buyPrice) * it.qty, it.currency)}).`;
}
const dot = (t) => (t.endsWith('.') ? t : t + '.');
function eventAlerts(it, out, now) {
  const A = it.alerts || {};
  if (A.earnings === false) return;
  const F = it.fired || (it.fired = {}), loc = tzParts(it.tz || 'UTC', now);
  const due = (ts, key) => {
    if (!ok(ts)) return null;
    const { day, dateOnly } = eventDay(it, ts), diff = dayDiff(day, loc.ymd);
    if (diff < 0 || diff > 1 || F[key] === day) return null;
    if (diff === 1 && loc.min < 9 * 60) return null; // la veille, à partir de 9h (heure de la bourse)
    F[key] = day;
    return { diff, dateOnly };
  };
  const e = due(it.nextEarnings, 'earn');
  if (e) {
    const lv = levelsTxt(it);
    out.push({ it, kind: 'earnings', lvl: 'warn', text:
      dot(`📅 Résultats ${e.diff === 1 ? 'demain' : 'aujourd’hui'} : ${it.name || it.symbol} publie ses résultats ${dayFr(it.nextEarnings)}${whenTxt(it, it.nextEarnings, e.dateOnly)}`) +
      `\nLes jours de résultats, le cours peut bouger beaucoup plus que d’habitude${ok(it.dayMove) ? ` (un jour normal : environ ±${nf(it.dayMove * 100, 1)} %)` : ''}.` +
      positionTxt(it) + (lv ? `\nVos niveaux : ${lv}. Vérifiez qu’ils vous conviennent avant la publication.` : '') });
  }
  const d = due(it.exDiv, 'exdiv');
  if (d) {
    out.push({ it, kind: 'exdiv', lvl: 'warn', text:
      `💰 Détachement du dividende ${d.diff === 1 ? 'demain' : 'aujourd’hui'} (${dayFr(it.exDiv)}) : à l’ouverture, le cours baisse mécaniquement d’environ le montant du dividende. Ce n’est pas une perte pour l’actionnaire, qui reçoit le dividende.` +
      positionTxt(it) + (levelsTxt(it) ? `\nAttention : cette baisse mécanique peut déclencher vos alertes (${levelsTxt(it)}).` : '') });
  }
}
const fcfa = (x, sign) => (sign && x > 0 ? '+' : '') + nf(x, 0) + ' FCFA';
const dayFr = (t) => new Date(t * 1000).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
function buildDigest(st, kind, quotes, now) {
  const head = kind === 'morning' ? '☀️ <b>FuriousX · Résumé du matin</b>' : kind === 'evening' ? '🌙 <b>FuriousX · Résumé du soir</b>' : '📊 <b>FuriousX · Résumé du portefeuille</b>';
  const date = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const time = now.toISOString().slice(11, 16).replace(':', 'h');
  let totV = 0, totC = 0, totD = 0, anyPos = false;
  const rows = [], moves = [], soon = [];
  for (const it of st.items) {
    const q = quotes.get(pfKey(it)), p = q && ok(q.price) ? q.price : null, cur = it.currency;
    if (!ok(p)) { rows.push(`⚪ <b>${esc(it.symbol)}</b> : cours indisponible`); continue; }
    const ch = ok(q.prevClose) && q.prevClose > 0 ? p / q.prevClose - 1 : NaN;
    const x = ok(it.toXof) ? it.toXof : cur === 'XOF' ? 1 : null;
    if (ok(ch)) moves.push([it.symbol, ch]);
    let line = `${!ok(ch) ? '⚪' : ch > 0 ? '🟢' : ch < 0 ? '🔴' : '⚪'} <b>${esc(it.symbol)}</b> ${esc(fmtP(p, cur))}${ok(ch) ? ` (${pct(ch)})` : ''}`;
    if (ok(it.qty) && ok(it.buyPrice)) {
      line += ` · position ${pct(p / it.buyPrice - 1)}`;
      if (x) {
        anyPos = true; totV += p * it.qty * x; totC += it.buyPrice * it.qty * x;
        if (ok(q.prevClose)) totD += (p - q.prevClose) * it.qty * x;
      }
    }
    if (it.lastSignal) line += ` · ${SIG[it.lastSignal]}`;
    const A = it.alerts || {};
    if (ok(A.trail) && ok(it.peak)) {
      const lvl = it.peak * (1 - A.trail / 100), dist = p / lvl - 1;
      if (dist < 0) line += `\n      ⚠️ sous le stop suiveur (${esc(fmtP(lvl, cur))})`;
      else if (dist < 0.03) line += `\n      ⚠️ à ${nf(dist * 100, 1)} % du stop suiveur (${esc(fmtP(lvl, cur))})`;
    }
    if (ok(A.stop) && p > A.stop && p / A.stop - 1 < 0.03) line += `\n      ⚠️ proche du stop (${esc(fmtP(A.stop, cur))})`;
    if (ok(A.target) && p < A.target && A.target / p - 1 < 0.03) line += `\n      🎯 proche de l’objectif (${esc(fmtP(A.target, cur))})`;
    rows.push(line);
    const lim = now.getTime() / 1000 + 14 * 86400;
    if (ok(it.nextEarnings) && it.nextEarnings < lim) soon.push([it.nextEarnings, `• <b>${esc(it.symbol)}</b> : résultats ${dayFr(it.nextEarnings)}`]);
    if (ok(it.exDiv) && it.exDiv < lim) soon.push([it.exDiv, `• <b>${esc(it.symbol)}</b> : détachement du dividende ${dayFr(it.exDiv)}`]);
  }
  const parts = [`${head}\n${date} · ${time} (Abidjan)`];
  if (anyPos && totC > 0) {
    parts.push(`💼 <b>Portefeuille ≈ ${fcfa(totV)}</b>\nPlus/moins-value : <b>${fcfa(totV - totC, true)} (${pct(totV / totC - 1)})</b>\n${kind === 'morning' ? 'Dernière séance' : 'Aujourd’hui'} : ${fcfa(totD, true)}`);
  }
  parts.push(`<b>Vos valeurs</b>\n${rows.join('\n')}`);
  if (kind === 'evening' && moves.length > 1) {
    moves.sort((a, b) => b[1] - a[1]);
    parts.push(`🏆 Meilleure : <b>${esc(moves[0][0])}</b> ${pct(moves[0][1])} · 📉 Moins bonne : <b>${esc(moves[moves.length - 1][0])}</b> ${pct(moves[moves.length - 1][1])}`);
  }
  if (soon.length) parts.push(`📅 <b>À venir (14 jours)</b>\n${soon.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('\n')}`);
  const nyOff = tzOffsetMin('America/New_York', now);
  if (kind !== 'evening') parts.push(`🕘 Aujourd’hui (heure d’Abidjan) : BRVM 09h00–15h00 · New York ${hhmm(570 - nyOff)}–${hhmm(960 - nyOff)}`);
  const n24 = st.log.filter((a) => a.kind !== 'digest' && now.getTime() - a.at < 86400000).length;
  parts.push(`🔔 ${n24 ? `${n24} alerte${n24 > 1 ? 's' : ''} envoyée${n24 > 1 ? 's' : ''} ces dernières 24 h` : 'Aucune alerte ces dernières 24 h'} · <a href="${esc((st.base || '') + '/')}">Ouvrir FuriousX</a>`);
  let html = parts.join('\n\n');
  if (html.length > 4000) html = html.slice(0, 3990) + '…';
  return html;
}
async function sendDigest(ctx, st, kind, quotes) {
  const now = new Date();
  const r = await sendText(ctx.env, st.chatId, buildDigest(st, kind, quotes, now));
  const label = kind === 'morning' ? 'Résumé du matin' : kind === 'evening' ? 'Résumé du soir' : 'Résumé du portefeuille';
  st.log.unshift({ id: 'tg-' + Date.now() + '-d', at: Date.now(), symbol: 'FuriousX', name: '', kind: 'digest', msg: `📊 ${label} envoyé sur Telegram.`, level: 'good', link: null, tg: !!r.ok });
  return !!r.ok;
}
async function quotesFor(ctx, st) {
  const map = new Map();
  try {
    const w = await api(ctx, 'watch=' + encodeURIComponent(st.items.map(pfKey).join(',')));
    for (const q of w.quotes || []) if (!q.error) map.set(q.key, q);
  } catch (e) {}
  return map;
}

// ---------- vérification complète (appelée toutes les 5 minutes) ----------
async function run(ctx, st) {
  const out = [];
  if (!st.chatId || !st.items.length) {
    st.lastRun = Date.now(); await saveState(ctx.env, st);
    return { checked: 0, alerts: 0, sent: 0, note: st.chatId ? 'aucune valeur suivie' : 'Telegram non relié' };
  }
  const quotes = await quotesFor(ctx, st); // si la source ne répond pas, on réessaiera dans 5 min
  for (const [key, q] of quotes) {
    const it = st.items.find((x) => pfKey(x) === key);
    if (it) evalAlerts(it, q, out);
  }
  for (const x of st.items) eventAlerts(x, out, new Date()); // résultats / dividende la veille
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
  let digest = null;
  const due = digestDue(st, new Date());
  if (due && quotes.size) {
    st.digest = Object.assign(st.digest || {}, { [due.kind]: due.tag });
    if (await sendDigest(ctx, st, due.kind, quotes)) digest = due.kind;
  }
  st.log = st.log.slice(0, 60);
  st.lastRun = Date.now();
  await saveState(ctx.env, st);
  return { checked: st.items.length, alerts: out.length, sent, digest };
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
        items: st.items.length, lastRun: st.lastRun || null, log: st.log.slice(0, 40), prefs: prefsOf(st), digest: st.digest || {},
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
    if (url.searchParams.has('digest')) {
      if (!st.chatId) throw new HttpError(400, 'Telegram n’est pas encore relié.');
      if (!st.items.length) throw new HttpError(400, 'Aucune valeur suivie : ajoutez d’abord une action avec « ⭐ Suivre ».');
      const okSent = await sendDigest(ctx, st, 'now', await quotesFor(ctx, st));
      await saveState(env, st);
      if (!okSent) throw new HttpError(502, 'Telegram a refusé l’envoi du résumé.');
      return J({ ok: true });
    }
    if (url.searchParams.has('prefs')) {
      if (request.method !== 'POST') throw new HttpError(405, 'Utilisez POST.');
      const b = await request.json().catch(() => ({}));
      st.prefs = { morning: b.morning !== false, evening: b.evening !== false };
      await saveState(env, st);
      return J({ ok: true, prefs: st.prefs });
    }
    if (url.searchParams.has('run')) return J(await run(ctx, st));
    throw new HttpError(400, 'Action inconnue.');
  } catch (e) {
    return J({ error: e.message || 'Erreur' }, e.status || 500);
  }
}
