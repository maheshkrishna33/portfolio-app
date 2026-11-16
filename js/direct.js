// Direct market data for the Android app. Inside the app, requests go through Android's own
// network stack (CapacitorHttp), so the browser restrictions that block these sites don't apply.
// The web version never uses this file (it reads the daily files published with the site).
// A full desktop-browser identity: Yahoo answers "429 Too Many Requests" to some mobile ones
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", Accept: "*/*" };
const AMFI = "https://www.amfiindia.com/spages/NAVAll.txt";
const NSE_LIST = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const BSE_BHAV = (d) => `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${d.replace(/-/g, "")}_F_0000.CSV`;
const INDEX = {
  large: "https://www.niftyindices.com/IndexConstituent/ind_nifty100list.csv",
  mid: "https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv",
  small: "https://www.niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv",
  micro: "https://www.niftyindices.com/IndexConstituent/ind_niftymicrocap250_list.csv",
};
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";

async function text(url, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${new URL(url).hostname}: HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${new URL(url).hostname}: timed out`);
    throw e.message?.includes(new URL(url).hostname) ? e : new Error(`${new URL(url).hostname}: ${e.message || e}`);
  } finally { clearTimeout(t); }
}
async function json(url) { return JSON.parse(await text(url, 30000)); }

/** simple CSV parser (handles quoted fields) -> array of objects */
export function csv(textData) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < textData.length; i++) {
    const c = textData[i];
    if (q) { if (c === '"') { if (textData[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && textData[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** Backup: yesterday-evening copy of AMFI's NAVs published by the web version's daily job */
const MIRROR = "https://maheshkrishna33.github.io/portfolio-app/data/amfi.json";
export async function amfiMirror() {
  const a = JSON.parse(await text(MIRROR + "?t=" + Date.now(), 120000));
  if (!a?.s?.length) throw new Error("backup copy is empty");
  return { cats: a.cats, amcs: a.amcs, s: a.s, nav_date: a.nav_date || a.s.reduce((m, s) => (s[4] > m ? s[4] : m), ""), source: "backup copy" };
}

/** Funds whose name matches (online search at mfapi.in) — used when the full NAV list isn't available */
export async function searchFundsOnline(q) {
  const list = await json(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
  return (list || []).slice(0, 30).map((x) => ({ kind: "mf", symbol: String(x.schemeCode), name: x.schemeName, price: null, exchange: "mfapi.in" }));
}

/** Check each data source and report what works (for More › Market data › Test connection) */
export async function diagnose() {
  const tests = {
    "AMFI (fund NAVs)": AMFI,
    "Backup NAV copy": MIRROR,
    "mfapi.in (fund history)": "https://api.mfapi.in/mf/122639",
    "Yahoo Finance (stock prices)": `${YAHOO}POLYCAB.NS?range=5d&interval=1d`,
    "NSE (stock list)": NSE_LIST,
    "Nifty indices (cap groups)": INDEX.large,
  };
  const out = [];
  for (const [name, url] of Object.entries(tests)) {
    const t0 = Date.now();
    try { const body = await text(url, 120000); out.push({ name, ok: true, detail: `${Math.round(body.length / 1024)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s` }); }
    catch (e) { out.push({ name, ok: false, detail: `${e.name === "AbortError" ? "timed out" : e.message || e}` }); }
  }
  return out;
}

/** All live fund NAVs from AMFI, in the same shape as the published amfi.json (one retry) */
export async function amfi(prev) {
  let t;
  try { t = await text(AMFI, 150000); }
  catch (e) { await new Promise((r) => setTimeout(r, 2000)); t = await text(AMFI, 150000); }
  const cats = [], amcs = [], out = [];
  let ci = -1, ai = -1;
  const prevMap = new Map((prev?.s || []).map((s) => [s[0], s]));
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = line.split(";").map((x) => x.trim());
    if (p.length >= 6 && /^\d+$/.test(p[0])) {
      const nav = parseFloat(p[p.length - 2]);
      const m = p[p.length - 1].match(/^(\d{2})-(\w{3})-(\d{4})$/);
      if (!isFinite(nav) || !m) continue;
      const d = `${m[3]}-${MON[m[2]]}-${m[1]}`;
      if (d < cutoff) continue;
      const name = p.slice(3, -2).filter((x) => x && x !== "-").join(" - ");
      const old = prevMap.get(p[0]);
      const prevNav = old ? (old[4] < d ? old[2] : old[4] === d ? old[3] : null) : null;
      out.push([p[0], name, nav, prevNav, d, ci, ai]);
    } else if (!line.includes(";")) {
      if (line.includes("(") && line.endsWith(")") && /Schemes?/.test(line)) {
        const c = line.slice(line.indexOf("(") + 1, -1).trim();
        if (!cats.includes(c)) cats.push(c);
        ci = cats.indexOf(c);
      } else {
        if (!amcs.includes(line)) amcs.push(line);
        ai = amcs.indexOf(line);
      }
    }
  }
  if (out.length < 1000) throw new Error("AMFI NAV file looks incomplete");
  return { cats, amcs, s: out, nav_date: out.reduce((m, s) => (s[4] > m ? s[4] : m), "") };
}

/** Names of every NSE and BSE stock (for search), with BSE closing prices when available */
export async function universe() {
  const q = {};
  try {
    for (const r of csv(await text(NSE_LIST))) if (r.SYMBOL) q[r.SYMBOL + ".NS"] = [r["NAME OF COMPANY"] || r.SYMBOL, null, null, null];
  } catch (e) { /* keep going with BSE */ }
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.now() + 330 * 60000 - back * 864e5);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    try {
      const rows = csv(await text(BSE_BHAV(d.toISOString().slice(0, 10))));
      for (const r of rows) if (r.FinInstrmTp === "STK" && r.TckrSymb) q[r.TckrSymb + ".BO"] = [r.FinInstrmNm, +r.ClsPric || null, +r.PrvsClsgPric || null, r.TradDt];
      break;
    } catch (e) { /* try the day before */ }
  }
  if (Object.keys(q).length < 1000) throw new Error("Couldn't download the stock list");
  return q;
}

export async function indexLists() {
  const out = {};
  for (const [cap, url] of Object.entries(INDEX)) {
    try { out[cap] = Object.fromEntries(csv(await text(url)).filter((r) => r.Symbol).map((r) => [r.Symbol, r.Industry || ""])); } catch (e) { /* skip */ }
  }
  return out;
}

const istDate = (ts) => new Date((ts + 330 * 60) * 1000).toISOString().slice(0, 10);

/** Latest price (live during market hours) and previous close for each symbol, from Yahoo Finance */
export async function quotes(symbols) {
  const out = {};
  const one = async (sym) => {
    try {
      const js = await json(`${YAHOO}${encodeURIComponent(sym)}?range=5d&interval=1d`);
      const r = js.chart?.result?.[0];
      if (!r) return;
      const ts = r.timestamp || [], cl = r.indicators?.quote?.[0]?.close || [];
      const pts = ts.map((t, i) => [istDate(t), cl[i]]).filter((p) => p[1] != null);
      const m = r.meta || {};
      let price = m.regularMarketPrice ?? pts.at(-1)?.[1], date = m.regularMarketTime ? istDate(m.regularMarketTime) : pts.at(-1)?.[0];
      const before = pts.filter((p) => p[0] < date);
      const prev = before.length ? before.at(-1)[1] : (m.chartPreviousClose ?? null);
      if (price != null) out[sym] = [m.longName || m.shortName || sym, +(+price).toFixed(4), prev != null ? +(+prev).toFixed(4) : null, date];
    } catch (e) { /* leave this symbol out */ }
  };
  const list = [...new Set(symbols)];
  for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(one));
  return out;
}

/** Month-end closes {YYYY-MM: close} for ~10 years */
export async function monthlyCloses(sym) {
  const js = await json(`${YAHOO}${encodeURIComponent(sym)}?range=10y&interval=1mo`);
  const r = js.chart?.result?.[0];
  const out = {};
  (r?.timestamp || []).forEach((t, i) => { const c = r.indicators?.quote?.[0]?.close?.[i]; if (c != null) out[istDate(t).slice(0, 7)] = +c.toFixed(2); });
  return out;
}

/** Exact closing price on (or just before) a date */
export async function closeOn(sym, date) {
  const t = Math.floor(Date.parse(date + "T00:00:00Z") / 1000);
  const js = await json(`${YAHOO}${encodeURIComponent(sym)}?period1=${t - 10 * 86400}&period2=${t + 86400}&interval=1d`);
  const r = js.chart?.result?.[0];
  const pts = (r?.timestamp || []).map((x, i) => [istDate(x), r.indicators?.quote?.[0]?.close?.[i]]).filter((p) => p[1] != null && p[0] <= date);
  return pts.length ? { date: pts.at(-1)[0], price: pts.at(-1)[1], exact: true } : null;
}

/** Full daily NAV history from mfapi.in -> [[iso, nav]] oldest first */
export async function navHistory(code) {
  const js = await json(`https://api.mfapi.in/mf/${code}`);
  return (js.data || []).map((r) => { const [dd, mm, yy] = r.date.split("-"); return [`${yy}-${mm}-${dd}`, +r.nav]; })
    .filter((r) => isFinite(r[1])).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
