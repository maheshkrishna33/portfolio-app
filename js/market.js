// Market data: the daily files published with the app (./data/*.json) + live fund history from mfapi.in.
import * as db from "./db.js";
import { todayIST } from "./util.js";

const BASE = "./data/";
const M = { amfi: null, byCode: null, stocks: null, indices: null, monthly: null, meta: null };

async function fetchJSON(url, cache = "no-cache") {
  const r = await fetch(url, { cache });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Load market files, downloading them again only when a newer daily build exists. */
export async function ensureMarket({ force = false } = {}) {
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
  M.meta = meta || (await db.kvGet("market_meta"));
  if (!M.amfi) throw new Error(online ? "Market data not available yet" : "You're offline and no market data has been downloaded yet");
  return { meta: M.meta, online };
}

export const marketMeta = () => M.meta;

function byCode() {
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
    if (!i.symbol) continue;
    if (i.kind === "mf") {
      const s = scheme(i.symbol);
      if (!s) continue;
      let prev = s.prev ?? i.prev_close ?? null;
      if (s.prev == null && i.price_date && s.date > i.price_date) prev = i.price; // NAV moved on: last NAV becomes previous
      Object.assign(i, { price: s.nav, prev_close: prev, price_date: s.date, source_name: s.name });
    } else {
      const q = stock(i.symbol);
      if (!q) continue;
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
    try {
      // weekly history published with the app (same website, never blocked)
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
export function navOn(rows, date) {
  let lo = 0, hi = rows.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= date) { ans = rows[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Month-end closes for NSE stocks (for the growth chart) — downloaded only when needed */
export async function monthly() {
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
  if (q && q.date === date) return { date: q.date, price: q.close, exact: true };
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
