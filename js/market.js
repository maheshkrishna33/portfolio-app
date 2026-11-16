// Market data.
//  * Web version: the daily files published with the site (./data/*.json).
//  * Android app: fetched directly and live from AMFI, NSE/BSE, Yahoo Finance and mfapi.in (see direct.js).
import * as db from "./db.js";
import * as direct from "./direct.js";
import { todayIST } from "./util.js";

export const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const BASE = "./data/";
const M = { amfi: null, byCode: null, stocks: null, indices: null, monthly: null, meta: null };

async function fetchJSON(url, cache = "no-cache") {
  const r = await fetch(url, { cache });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Android app: refresh NAVs every 3 h, the stock list every 3 days, index lists weekly,
 *  and live prices of the stocks you hold whenever asked (at most once a minute). */
async function ensureDirect({ force = false } = {}) {
  const now = Date.now();
  const age = async (k) => now - ((await db.kvGet(k + "_t")) || 0);
  let online = true;
  M.errors = {};
  if (force || (await age("amfi")) > 3 * 3600e3 || !(await db.kvGet("amfi"))) {
    try {
      const a = await direct.amfi(await db.kvGet("amfi"));
      await db.kvSet("amfi", a); await db.kvSet("amfi_t", now);
    } catch (e) {
      M.errors.amfi = e.message || String(e);
      try {  // AMFI unreachable: use the backup copy (yesterday evening's NAVs)
        const a = await direct.amfiMirror();
        await db.kvSet("amfi", a); await db.kvSet("amfi_t", now - 2.5 * 3600e3);  // retry AMFI in ~30 min
      } catch (e2) { M.errors.amfi += `; backup: ${e2.message || e2}`; online = false; }
    }
  }
  try {
    if (force || (await age("universe")) > 3 * 86400e3 || !(await db.kvGet("universe"))) {
      await db.kvSet("universe", await direct.universe()); await db.kvSet("universe_t", now);
    }
  } catch (e) { /* search falls back to the last list */ }
  try {
    if (force || (await age("indices")) > 7 * 86400e3 || !(await db.kvGet("indices"))) {
      const ix = await direct.indexLists();
      if (Object.keys(ix).length) { await db.kvSet("indices", ix); await db.kvSet("indices_t", now); }
    }
  } catch (e) { /* optional */ }
  M.stocks = { q: { ...((await db.kvGet("universe")) || {}) } };
  const before = (await db.all("instruments")).filter((i) => i.symbol?.endsWith(".BO")).length;
  await migrateToNSE();
  const syms = (await db.all("instruments")).filter((i) => i.kind === "stock" && i.symbol).map((i) => i.symbol);
  const migrated = before > (await db.all("instruments")).filter((i) => i.symbol?.endsWith(".BO")).length;
  let quotes = (await db.kvGet("quotes")) || {};
  if (syms.length && (force || migrated || (await age("quotes")) > 50e3)) {
    const q = await direct.quotes(syms).catch(() => ({}));
    if (Object.keys(q).length) { quotes = { ...quotes, ...q }; await db.kvSet("quotes", quotes); await db.kvSet("quotes_t", now); }
    else online = false;
  }
  M.amfi = await db.kvGet("amfi"); M.byCode = null;
  M.stocks = { q: { ...((await db.kvGet("universe")) || {}), ...quotes } };
  M.indices = (await db.kvGet("indices")) || {};
  const qt = await db.kvGet("quotes_t");
  M.meta = { live: true, built: qt ? new Date(qt + 330 * 60000).toISOString().slice(0, 16).replace("T", " ") : "—",
    nav_date: M.amfi?.nav_date, trade_dates: { NSE: Object.values(quotes).reduce((m, x) => (x[3] > m ? x[3] : m), "") || null } };
  if (!M.amfi) throw new Error(`Couldn't download fund NAVs (${M.errors.amfi || "unknown error"}). More › Market data › Test connection shows details.`);
  return { meta: M.meta, online };
}
export const lastErrors = () => M.errors || {};
export const hasFundList = () => !!M.amfi;
export const diagnose = () => direct.diagnose();
export const searchFundsOnline = (q) => direct.searchFundsOnline(q);

/** For a BSE ticker, the same company's NSE ticker when it's listed there (NSE is the usual reference price). */
export function preferNSE(sym) {
  if (!sym || !sym.endsWith(".BO")) return sym;
  const ns = sym.slice(0, -3) + ".NS";
  return M.stocks?.q?.[ns] ? ns : sym;
}
/** Find a company on NSE by name, for ticker codes that no longer exist (e.g. after a company renamed:
 *  "HIMADRI CHEMICALS & INDUSTRIES - HIMCI.BO" is now "Himadri Speciality Chemical" = HSCL.NS).
 *  Returns a symbol only when exactly one NSE company matches. */
const NOISE = new Set(["LTD", "LIMITED", "THE", "AND", "OF", "CO", "COMPANY", "CORP", "CORPORATION", "L"]);
const words = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(" ").filter((w) => w && !NOISE.has(w));
export function nseByName(name) {
  const want = words(String(name).split(" - ")[0]);
  if (!want.length || !M.stocks?.q) return null;
  const ns = Object.entries(M.stocks.q).filter(([s]) => s.endsWith(".NS")).map(([s, v]) => [s, words(v[0]).join(" ")]);
  for (const n of [3, 2, 1]) {
    if (want.length < n) continue;
    const key = want.slice(0, n).join(" ");
    const hits = ns.filter(([, w]) => w === key || w.startsWith(key + " "));
    if (hits.length === 1) return hits[0][0];
    if (hits.length > 1) return null;  // ambiguous: don't guess
  }
  return null;
}
const known = (sym) => !!M.stocks?.q?.[sym];

/** Keep stock price sources sensible:
 *  - once: BSE tickers that also trade on NSE switch to NSE (a later manual choice of BSE is kept)
 *  - always: a ticker that no longer exists is re-linked to the same company on NSE by name (marked "check") */
async function migrateToNSE() {
  if (!M.stocks?.q || Object.keys(M.stocks.q).length < 1000) return;
  const once = !(await db.kvGet("nse_preferred_v1"));
  for (const i of await db.all("instruments")) {
    if (i.kind !== "stock" || !i.symbol) continue;
    let sym = i.symbol, review = i.needs_review;
    if (once && sym.endsWith(".BO")) sym = preferNSE(sym);
    if (!known(sym)) { const byName = nseByName(i.name); if (byName) { sym = byName; review = true; } }
    if (sym !== i.symbol) { Object.assign(i, { symbol: sym, price_date: null, needs_review: review }); await db.put("instruments", i); }
  }
  if (once) await db.kvSet("nse_preferred_v1", true);
}

/** Make the next ensureMarket() fetch fresh stock prices (e.g. after adding new stocks) */
export async function invalidateQuotes() { await db.kvSet("quotes_t", 0); }

/** Price for one stock right now (used when you pick a stock to add) */
export async function quoteNow(sym) {
  if (NATIVE) {
    const q = await direct.quotes([sym]);
    if (q[sym]) {
      const all = { ...((await db.kvGet("quotes")) || {}), ...q };
      await db.kvSet("quotes", all);
      M.stocks.q[sym] = q[sym];
    }
  }
  return stock(sym);
}

/** Load market data (web: only when a newer daily build exists; app: live). */
let inflight = null;
export async function ensureMarket({ force = false } = {}) {
  if (NATIVE) {  // one download at a time; a second caller waits for the first
    if (!inflight) inflight = ensureDirect({ force }).finally(() => { inflight = null; });
    return inflight;
  }
  let meta = null, online = true;
  try { meta = await fetchJSON(BASE + "meta.json?t=" + Date.now(), "no-store"); } catch (e) { online = false; }
  const have = await db.kvGet("market_built");
  if (meta && (force || meta.built !== have || !(await db.kvGet("amfi")))) {
    const [amfi, stocks, indices] = await Promise.all(["amfi", "stocks", "indices"].map((n) => fetchJSON(`${BASE}${n}.json?v=${encodeURIComponent(meta.built)}`)));
    await db.kvSet("amfi", amfi); await db.kvSet("stocks", stocks); await db.kvSet("indices", indices);
    await db.kvSet("market_built", meta.built); await db.kvSet("market_meta", meta);
    M.amfi = amfi; M.stocks = stocks; M.indices = indices; M.byCode = null; M.monthly = null;
  }
  if (!M.amfi) { M.amfi = await db.kvGet("amfi"); M.stocks = await db.kvGet("stocks"); M.indices = await db.kvGet("indices"); }
  await migrateToNSE();
  M.meta = meta || (await db.kvGet("market_meta"));
  if (!M.amfi) throw new Error(online ? "Market data not available yet" : "You're offline and no market data has been downloaded yet");
  return { meta: M.meta, online };
}

export const marketMeta = () => M.meta;

function byCode() {
  if (!M.amfi) return new Map();  // market data not loaded yet
  if (!M.byCode) M.byCode = new Map(M.amfi.s.map((s) => [s[0], s]));
  return M.byCode;
}
/** {code, name, nav, prev, date, category, house} */
export function scheme(code) {
  const s = byCode().get(String(code));
  return s ? { code: s[0], name: s[1], nav: s[2], prev: s[3], date: s[4], category: M.amfi.cats[s[5]] || "", house: M.amfi.amcs[s[6]] || "" } : null;
}
/** {symbol, name, close, prev, date} */
export function stock(sym) {
  const q = M.stocks?.q?.[sym];
  return q ? { symbol: sym, name: q[0], close: q[1], prev: q[2], date: q[3] } : null;
}
export const indices = () => M.indices || {};

/** Apply the latest prices to every holding. Returns the updated instruments. */
export async function applyPrices() {
  const insts = await db.all("instruments");
  for (const i of insts) {
    if (i.kind === "mf" && !i.symbol && M.amfi) {
      // imported while the fund list wasn't available: link it now (the sheet's last NAV helps pick the right plan)
      const [s, ok] = matchFund(i.name, i.price);
      if (s) Object.assign(i, { symbol: s.code, source_name: s.name, needs_review: !ok });
    }
    if (!i.symbol) continue;
    if (i.kind === "mf") {
      const s = scheme(i.symbol);
      if (!s) continue;
      let prev = s.prev ?? i.prev_close ?? null;
      if (s.prev == null && i.price_date && s.date > i.price_date) prev = i.price; // NAV moved on: last NAV becomes previous
      Object.assign(i, { price: s.nav, prev_close: prev, price_date: s.date, source_name: s.name });
    } else {
      const q = stock(i.symbol);
      if (!q || q.close == null) continue;
      Object.assign(i, { price: q.close, prev_close: q.prev, price_date: q.date });
    }
    await db.put("instruments", i);
  }
  return insts;
}

/** Fill previous NAVs that the daily file doesn't have yet (first days after setup). */
export async function backfillPrevNavs() {
  const insts = await db.all("instruments");
  for (const i of insts.filter((x) => x.kind === "mf" && x.symbol && x.price_date && x.prev_close == null)) {
    try {
      const h = await mfHistory(i.symbol);
      const p = [...h].reverse().find(([d]) => d < i.price_date);
      if (p) { i.prev_close = p[1]; await db.put("instruments", i); }
    } catch (e) { /* offline: try next time */ }
  }
}

// ---------------------------------------------------------------- fund history (mfapi.in, allowed from browsers)
const mem = new Map();
/** [[iso, nav], …] oldest first; cached on the phone for 12 hours */
export async function mfHistory(code) {
  code = String(code);
  if (mem.has(code)) return mem.get(code);
  const key = "h:" + code;
  const c = await db.kvGet(key);
  if (c && Date.now() - c.t < 12 * 3600e3) { mem.set(code, c.rows); return c.rows; }
  try {
    let rows;
    if (NATIVE) rows = await direct.navHistory(code);  // full daily history, straight from mfapi.in
    else try {
      // history published with the app (same website, never blocked)
      rows = await fetchJSON(`${BASE}nav/${code}.json?v=${encodeURIComponent((await db.kvGet("market_built")) || "")}`, "default");
    } catch (e) {
      // not in the daily files (e.g. an IDCW plan): try mfapi.in directly (works for some funds only)
      const js = await fetchJSON(`https://api.mfapi.in/mf/${code}`, "default");
      rows = (js.data || []).map((r) => { const [dd, mm, yy] = r.date.split("-"); return [`${yy}-${mm}-${dd}`, +r.nav]; })
        .filter((r) => isFinite(r[1])).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    await db.kvSet(key, { t: Date.now(), rows });
    mem.set(code, rows);
    return rows;
  } catch (e) {
    if (c) { mem.set(code, c.rows); return c.rows; }  // stale is better than nothing offline
    throw e;
  }
}
/** NAV on/before a date. Recent history is daily (exact); older history is weekly, so a date that
 *  falls between two weekly points is interpolated — returns then match daily data very closely. */
export function navOn(rows, date) {
  let lo = 0, hi = rows.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= date) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0) return null;
  const p0 = rows[idx], p1 = rows[idx + 1];
  if (!p1 || p0[0] === date) return p0;
  const t0 = Date.parse(p0[0]), t1 = Date.parse(p1[0]), t = Date.parse(date);
  if ((t1 - t0) / 864e5 <= 4) return p0;  // ordinary weekend / holiday gap in daily data
  return [date, p0[1] + ((p1[1] - p0[1]) * (t - t0)) / (t1 - t0)];
}

/** Month-end closes for stocks (for the growth chart) — downloaded only when needed.
 *  symbols: the stocks needed (the Android app fetches just those; the web version has them all). */
export async function monthly(symbols = []) {
  if (NATIVE) {
    const cache = (await db.kvGet("monthly_direct")) || {};
    const need = [...new Set(symbols)].filter((s) => !cache[s] || Date.now() - cache[s].t > 7 * 86400e3);
    for (let i = 0; i < need.length; i += 6) {
      await Promise.all(need.slice(i, i + 6).map(async (s) => { try { cache[s] = { t: Date.now(), m: await direct.monthlyCloses(s) }; } catch (e) { /* skip */ } }));
    }
    if (need.length) await db.kvSet("monthly_direct", cache);
    return { h: Object.fromEntries(Object.entries(cache).map(([s, v]) => [s, v.m])) };
  }
  if (M.monthly) return M.monthly;
  const built = await db.kvGet("market_built");
  const c = await db.kvGet("monthly");
  if (c && c.built === built) { M.monthly = c.data; return M.monthly; }
  try {
    const data = await fetchJSON(BASE + "monthly.json?v=" + encodeURIComponent(built || ""));
    await db.kvSet("monthly", { built, data });
    M.monthly = data;
  } catch (e) { M.monthly = c ? c.data : { h: {} }; }
  return M.monthly;
}
/** Stock close on/before a date: exact daily close when it's the latest day, else that month's close */
export async function stockPriceOn(sym, date) {
  const q = stock(sym);
  if (q && q.date === date && q.close != null) return { date: q.date, price: q.close, exact: true };
  if (NATIVE) return direct.closeOn(sym, date);
  const m = (await monthly()).h?.[sym];
  if (!m) return null;
  const months = Object.keys(m).filter((k) => k <= date.slice(0, 7)).sort();
  if (!months.length) return null;
  const k = months[months.length - 1];
  return { date: k, price: m[k], exact: false };
}

// ---------------------------------------------------------------- search & matching
const STOP = new Set(["fund", "plan", "option", "the", "of", "and", "scheme", "an", "open", "ended"]);
export const VARIANT = new Set(["direct", "regular", "growth", "idcw", "dividend", "payout", "reinvestment", "plan", "option", "bonus",
  "monthly", "quarterly", "annual", "weekly", "daily", "half", "yearly", "dir", "reg", "gr", "income", "distribution", "cum",
  "capital", "withdrawal", "transfer", "sweep", "g"]);
const IDCW = new Set(["idcw", "dividend", "payout", "reinvestment", "bonus", "monthly", "quarterly", "weekly", "daily", "income"]);
export function tokens(s) {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(small|mid|large|flexi|multi|micro)\s+cap\b/g, "$1cap").split(" ").filter((t) => t && !STOP.has(t));
}
const tokCache = new Map();
const stok = (s) => { let t = tokCache.get(s[0]); if (!t) { t = new Set(tokens(s[1])); tokCache.set(s[0], t); } return t; };
function conflicts(q, s) {
  let c = 0;
  if (q.has("direct") && s.has("regular")) c++;
  if (q.has("regular") && s.has("direct")) c++;
  const qi = [...q].some((t) => IDCW.has(t)), si = [...s].some((t) => IDCW.has(t));
  if (qi !== si) c++;
  return c;
}

/** Best AMFI scheme for a free-text fund name; hint = the NAV you last saw. -> [scheme, confident] */
export function matchFund(name, hint) {
  if (!M.amfi) return [null, false];  // fund list not downloaded yet: linked later by applyPrices()
  const q = new Set(tokens(name)), core = [...q].filter((t) => !VARIANT.has(t));
  if (!core.length) return [null, false];
  let cands = M.amfi.s.filter((s) => { const t = stok(s); return core.every((c) => t.has(c)); });
  if (!cands.length) {
    const scored = M.amfi.s.map((s) => [core.filter((c) => stok(s).has(c)).length / core.length, s]);
    const best = Math.max(...scored.map((x) => x[0]));
    if (best < 0.6) return [null, false];
    cands = scored.filter((x) => x[0] === best).map((x) => x[1]);
  }
  const rank = (s) => {
    const t = stok(s);
    return [conflicts(q, t), [...t].filter((x) => !VARIANT.has(x) && !core.includes(x)).length,
      hint ? Math.abs(s[2] - hint) / hint : 0, t.has("direct") ? 0 : 1];
  };
  const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  cands.sort(cmp);
  if (hint) {
    const close = cands.filter((s) => Math.abs(s[2] - hint) / hint <= 0.06);
    if (close.length) { const p = close.sort(cmp)[0]; return [scheme(p[0]), conflicts(q, stok(p)) === 0]; }
  }
  return [scheme(cands[0][0]), false];
}

export function searchFunds(query, limit = 30) {
  const qt = tokens(query);
  if (!qt.length || !M.amfi) return [];
  const out = M.amfi.s.filter((s) => { const t = [...stok(s)]; return qt.every((q) => t.some((x) => x.startsWith(q))); });
  const rank = (s) => { const n = s[1].toLowerCase(); return [n.includes("direct") ? 0 : 1, n.includes("growth") ? 0 : 1, n.length]; };
  out.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return out.slice(0, limit).map((s) => ({ kind: "mf", symbol: s[0], name: s[1], price: s[2], price_date: s[4], exchange: M.amfi.amcs[s[6]] || "AMFI" }));
}

export function searchStocks(query, limit = 30) {
  const q = query.trim().toUpperCase();
  if (q.length < 2 || !M.stocks) return [];
  const words = q.split(/\s+/);
  const out = [];
  for (const [sym, v] of Object.entries(M.stocks.q)) {
    const base = sym.replace(/\.(NS|BO)$/, ""), name = (v[0] || "").toUpperCase();
    let score = -1;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (words.every((w) => name.includes(w))) score = name.startsWith(words[0]) ? 2 : 3;
    if (score >= 0) out.push({ score: score + (sym.endsWith(".BO") ? 0.5 : 0), r: { kind: "stock", symbol: sym, name: v[0], price: v[1], price_date: v[3], exchange: sym.endsWith(".NS") ? "NSE" : "BSE" } });
  }
  return out.sort((a, b) => a.score - b.score || a.r.name.length - b.r.name.length).slice(0, limit).map((x) => x.r);
}

export const today = () => todayIST();
