// Growth, Monthly, Exposure, Tax-free harvest and Fund ratings — same logic as the PC app.
import * as db from "./db.js";
import * as mk from "./market.js";
import { EPS, sortTx } from "./calc.js";
import { todayIST } from "./util.js";

async function load(account = "", kind = "") {
  const [insts, txns0] = await Promise.all([db.all("instruments"), db.all("txns")]);
  const byId = new Map(insts.map((i) => [i.id, i]));
  const txns = txns0.filter((t) => (!account || t.account === account) && (!kind || byId.get(t.instrument_id)?.kind === kind));
  return { byId, txns };
}
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- Growth
export async function growth(account, kind) {
  const { byId, txns } = await load(account, kind);
  if (!txns.length) return { dates: [], value: [], invested: [] };
  const by = new Map();
  txns.forEach((t) => { if (!by.has(t.instrument_id)) by.set(t.instrument_id, []); by.get(t.instrument_id).push(t); });
  by.forEach((ts) => ts.sort(sortTx));
  const first = txns.reduce((m, t) => (t.date < m ? t.date : m), "9999");
  const today = todayIST(), samples = [];
  for (let d = first; d < today; d = addDays(d, 7)) samples.push(d);
  samples.push(today);
  const codes = [...by.keys()].map((i) => byId.get(i)).filter((i) => i.kind === "mf" && i.symbol).map((i) => i.symbol);
  const hist = new Map();
  await Promise.all(codes.map(async (c) => { try { hist.set(c, await mk.mfHistory(c)); } catch (e) { hist.set(c, []); } }));
  const monthly = [...by.keys()].some((i) => byId.get(i).kind === "stock") ? (await mk.monthly()).h || {} : {};
  const n = samples.length, value = new Array(n).fill(0), invested = new Array(n).fill(0);
  let approxStocks = false;
  for (const [iid, ts] of by) {
    const inst = byId.get(iid);
    let series;
    if (inst.kind === "mf") series = hist.get(inst.symbol) || [];
    else {
      const m = monthly[inst.symbol] || {};
      series = Object.keys(m).sort().map((k) => [k + "-28", m[k]]);  // month's close, placed late in the month
      if (!series.length) approxStocks = true;
    }
    const lots = [];
    let k = 0, lastPx = null;
    samples.forEach((sd, i) => {
      while (k < ts.length && ts[k].date <= sd) {
        const t = ts[k++];
        lastPx = t.price;
        if (t.type === "BUY") lots.push([t.units, t.price]);
        else { let rem = t.units; while (rem > EPS && lots.length) { const take = Math.min(lots[0][0], rem); lots[0][0] -= take; rem -= take; if (lots[0][0] <= EPS) lots.shift(); } }
      }
      const units = lots.reduce((s, l) => s + l[0], 0);
      if (units <= EPS) return;
      let px;
      if (i === n - 1 && inst.price != null) px = inst.price;
      else { const p = mk.navOn(series, sd); px = p ? p[1] : lastPx; }
      value[i] += units * (px || 0);
      invested[i] += lots.reduce((s, l) => s + l[0] * l[1], 0);
    });
  }
  return { dates: samples, value: value.map(Math.round), invested: invested.map(Math.round), approxStocks };
}

// ---------------------------------------------------------------- Monthly
export async function monthlyActivity(account, kind) {
  const { byId, txns } = await load(account, kind);
  const months = {};
  txns.forEach((t) => {
    const m = t.date.slice(0, 7), r = (months[m] ||= { month: m, bought: 0, sold: 0, count: 0 });
    r[t.type === "BUY" ? "bought" : "sold"] += t.units * t.price; r.count++;
  });
  const list = [];
  const today = todayIST();
  if (txns.length) {
    let [y, mo] = Object.keys(months).sort()[0].split("-").map(Number);
    const [ty, tm] = today.split("-").map(Number);
    while (y < ty || (y === ty && mo <= tm)) {
      const k = `${y}-${String(mo).padStart(2, "0")}`;
      list.push(months[k] || { month: k, bought: 0, sold: 0, count: 0 });
      if (++mo > 12) { mo = 1; y++; }
    }
  }
  const years = {};
  list.forEach((r) => { const y = (years[r.month.slice(0, 4)] ||= { year: r.month.slice(0, 4), bought: 0, sold: 0 }); y.bought += r.bought; y.sold += r.sold; });
  const last12 = [];
  let [y, mo] = today.split("-").map(Number);
  for (let i = 0; i < 12; i++) { last12.unshift(`${y}-${String(mo).padStart(2, "0")}`); if (--mo === 0) { mo = 12; y--; } }
  const per = new Map();
  txns.filter((t) => t.type === "BUY" && last12.includes(t.date.slice(0, 7))).forEach((t) => {
    const p = per.get(t.instrument_id) || { amounts: {}, days: [] };
    p.amounts[t.date.slice(0, 7)] = (p.amounts[t.date.slice(0, 7)] || 0) + t.units * t.price;
    p.days.push(+t.date.slice(8, 10)); per.set(t.instrument_id, p);
  });
  const median = (a) => { const s = [...a].sort((x, y2) => x - y2); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
  const regular = [];
  per.forEach((p, iid) => {
    if (last12.slice(-6).filter((m) => p.amounts[m]).length < 3) return;
    const first = Object.keys(p.amounts).sort()[0];
    regular.push({ id: iid, name: byId.get(iid).name, months: last12.map((m) => Math.round(p.amounts[m] || 0)),
      typical: Math.round(median(Object.values(p.amounts))), day: Math.round(median(p.days)),
      missed: last12.filter((m) => m >= first && m !== last12[11] && !p.amounts[m]).length,
      total12: Object.values(p.amounts).reduce((s, v) => s + v, 0) });
  });
  regular.sort((a, b) => b.total12 - a.total12);
  return { months: list, years: Object.values(years).sort((a, b) => (a.year < b.year ? -1 : 1)), last12, regular };
}

// ---------------------------------------------------------------- Exposure
export const CAPS = ["Large cap", "Mid cap", "Small cap", "Micro cap", "Flexible"];
function fundCaps(category, name) {
  const n = `${category} ${name}`.toLowerCase().replace(/\s/g, "");
  if (n.includes("microcap")) return { "Micro cap": 1 };
  if (n.includes("smallcap")) return { "Small cap": 1 };
  if (n.includes("large&midcap") || n.includes("largeandmidcap") || n.includes("largemidcap")) return { "Large cap": 0.5, "Mid cap": 0.5 };
  if (n.includes("midcap")) return { "Mid cap": 1 };
  if (n.includes("largecap") || n.includes("nifty50")) return { "Large cap": 1 };
  if (n.includes("multicap")) return { "Large cap": 1 / 3, "Mid cap": 1 / 3, "Small cap": 1 / 3 };
  return { Flexible: 1 };
}
export function exposure(p) {
  const hs = p.holdings.filter((h) => h.value), total = hs.reduce((s, h) => s + h.value, 0) || 1;
  const idx = mk.indices(), capOf = { large: "Large cap", mid: "Mid cap", small: "Small cap", micro: "Micro cap" };
  const cap = Object.fromEntries([...CAPS, "Other listed"].map((c) => [c, { mf: 0, stock: 0 }]));
  const cats = {}, sectors = {}, amcs = {}, rows = [];
  let nSmall = 0;
  for (const h of hs) {
    const v = h.value;
    if (h.kind === "mf") {
      const s = mk.scheme(h.symbol) || {};
      const category = (s.category || "Other").split(" - ").pop().trim();
      for (const [c, w] of Object.entries(fundCaps(category, h.source_name || h.name))) cap[c].mf += v * w;
      cats[category] = (cats[category] || 0) + v;
      amcs[s.house || "Unknown"] = (amcs[s.house || "Unknown"] || 0) + v;
      if (category.toLowerCase().replace(/\s/g, "").includes("smallcap")) nSmall++;
    } else {
      const base = (h.symbol || "").replace(/\.(NS|BO)$/, "");
      let c = "Other listed", ind = "";
      for (const k of ["large", "mid", "small", "micro"]) if (idx[k]?.[base] !== undefined) { c = capOf[k]; ind = idx[k][base]; break; }
      cap[c].stock += v;
      cats["Direct stocks"] = (cats["Direct stocks"] || 0) + v;
      const sec = ind || "Not in Nifty indices";
      sectors[sec] = (sectors[sec] || 0) + v;
    }
    rows.push({ id: h.id, name: h.name, kind: h.kind, value: v, pct: v / total });
  }
  rows.sort((a, b) => b.value - a.value);
  const lst = (d) => Object.entries(d).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value, pct: value / total }));
  const caps = [...CAPS, "Other listed"].map((c) => ({ name: c, mf: cap[c].mf, stock: cap[c].stock, value: cap[c].mf + cap[c].stock }))
    .filter((c) => c.value > 0).map((c) => ({ ...c, pct: c.value / total }));
  const flags = [];
  const sm = (cap["Small cap"].mf + cap["Small cap"].stock + cap["Micro cap"].mf + cap["Micro cap"].stock) / total;
  if (sm > 0.5) flags.push({ level: "high", text: `Small + micro cap make up ${Math.round(sm * 100)}% of the portfolio (funds counted by their category). These segments swing the most in sharp market falls.` });
  rows.forEach((r) => {
    if (r.kind === "stock" && r.pct > 0.05) flags.push({ level: "medium", text: `${r.name} alone is ${(r.pct * 100).toFixed(1)}% of the portfolio (single stock above 5%).` });
    if (r.kind === "mf" && r.pct > 0.15) flags.push({ level: "medium", text: `${r.name} is ${(r.pct * 100).toFixed(1)}% of the portfolio (single fund above 15%).` });
  });
  const stTot = Object.values(sectors).reduce((s, v) => s + v, 0);
  Object.entries(sectors).forEach(([s, v]) => { if (stTot && v / stTot > 0.25 && s !== "Not in Nifty indices") flags.push({ level: "medium", text: `${s} is ${Math.round((v / stTot) * 100)}% of your direct stocks.` }); });
  const mfTot = Object.values(amcs).reduce((s, v) => s + v, 0);
  Object.entries(amcs).forEach(([a, v]) => { if (mfTot && v / mfTot > 0.25) flags.push({ level: "low", text: `${a} manages ${Math.round((v / mfTot) * 100)}% of your mutual fund money.` }); });
  if (nSmall >= 4) flags.push({ level: "low", text: `You hold ${nSmall} different small-cap funds; their portfolios usually overlap a lot.` });
  return { total, caps, categories: lst(cats), sectors: lst(sectors), amcs: lst(amcs), holdings: rows,
    top10: rows.slice(0, 10).reduce((s, r) => s + r.pct, 0), flags };
}

// ---------------------------------------------------------------- Tax-free harvest (Section 112A)
const EXEMPTION = 125000, GF = "2018-01-31";
const plusYears = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(Date.UTC(y + n, m - 1, d)); if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); return t.toISOString().slice(0, 10); };
const isLT = (buy, sell) => sell > plusYears(buy, 1);
export async function tax() {
  const today = todayIST();
  const [y, m] = today.split("-").map(Number);
  const fy0 = m >= 4 ? y : y - 1, fyStart = `${fy0}-04-01`, fyEnd = `${fy0 + 1}-03-31`;
  const [insts, txns] = await Promise.all([db.all("instruments"), db.all("txns")]);
  const gfCache = new Map();
  const gfPrice = async (i) => {
    if (!i.symbol) return null;
    if (!gfCache.has(i.id)) {
      let p = null;
      try {
        if (i.kind === "mf") p = mk.navOn(await mk.mfHistory(i.symbol), GF)?.[1] ?? null;
        else p = (await mk.monthly()).h?.[i.symbol]?.["2018-01"] ?? null;
      } catch (e) { p = null; }
      gfCache.set(i.id, p);
    }
    return gfCache.get(i.id);
  };
  const taxCost = async (i, lotPrice, buy, sale) => {
    if (buy > GF) return lotPrice;
    const fmv = await gfPrice(i);
    return fmv == null ? lotPrice : Math.max(lotPrice, Math.min(fmv, sale));
  };
  let ltGain = 0, ltLoss = 0, stNet = 0;
  const realised = [], cands = [];
  for (const i of insts) {
    const ts = txns.filter((t) => t.instrument_id === i.id).sort(sortTx);
    if (!ts.length) continue;
    const elss = i.kind === "mf" && /elss/i.test((mk.scheme(i.symbol)?.category || "") + " " + i.name);
    const lots = [];
    for (const t of ts) {
      if (t.type === "BUY") { lots.push({ date: t.date, units: t.units, price: t.price }); continue; }
      let rem = t.units;
      while (rem > EPS && lots.length) {
        const l = lots[0], take = Math.min(l.units, rem);
        if (t.date >= fyStart && t.date <= fyEnd) {
          let g;
          if (isLT(l.date, t.date)) { g = take * (t.price - (await taxCost(i, l.price, l.date, t.price))); if (g >= 0) ltGain += g; else ltLoss += g; realised.push({ name: i.name, date: t.date, units: take, gain: g, term: "Long term" }); }
          else { g = take * (t.price - l.price); stNet += g; realised.push({ name: i.name, date: t.date, units: take, gain: g, term: "Short term" }); }
        }
        l.units -= take; rem -= take;
        if (l.units <= EPS) lots.shift();
      }
    }
    if (!lots.length || i.price == null) continue;
    const steps = [];
    let ltUnits = 0, ltGainAvail = 0, blocked = null;
    for (const l of lots) {
      if (!isLT(l.date, today)) { blocked = `next units (bought ${l.date}) are still short-term`; break; }
      if (elss && today < plusYears(l.date, 3)) { blocked = `next ELSS units are locked in until ${plusYears(l.date, 3)}`; break; }
      const gpu = i.price - (await taxCost(i, l.price, l.date, i.price));
      steps.push({ units: l.units, gpu }); ltUnits += l.units; ltGainAvail += l.units * gpu;
    }
    const stLots = lots.filter((l) => !isLT(l.date, today));
    cands.push({ id: i.id, name: i.name, kind: i.kind, price: i.price, elss, lt_units: ltUnits, lt_gain: ltGainAvail, steps, blocked,
      st_gain: stLots.reduce((s, l) => s + l.units * (i.price - l.price), 0),
      next_lt: stLots.length ? addDays(plusYears(stLots[0].date, 1), 1) : null });
  }
  const ltNet = ltGain + ltLoss, ltAfter = stNet < 0 ? ltNet + stNet : ltNet;
  const used = Math.max(0, ltAfter), remaining = Math.max(0, EXEMPTION - used);
  const plan = [];
  let left = remaining;
  for (const c of [...cands].sort((a, b) => (a.kind !== "mf") - (b.kind !== "mf") || b.lt_gain - a.lt_gain)) {
    if (left <= 1 || c.lt_gain <= 0) continue;
    let units = 0, gain = 0;
    for (const s of c.steps) {
      const g = s.units * s.gpu;
      if (s.gpu <= 0) { units += s.units; gain += g; continue; }
      if (gain + g <= left) { units += s.units; gain += g; } else { const part = (left - gain) / s.gpu; units += part; gain += part * s.gpu; break; }
    }
    if (units <= EPS || gain <= 0) continue;
    if (c.kind === "stock") { const gpu = gain / units; units = Math.floor(units); gain = units * gpu; if (units < 1) continue; }
    plan.push({ id: c.id, name: c.name, kind: c.kind, units, value: units * c.price, gain, price: c.price });
    left -= gain;
  }
  const planGain = plan.reduce((s, p) => s + p.gain, 0);
  cands.forEach((c) => delete c.steps);
  cands.sort((a, b) => b.lt_gain - a.lt_gain);
  const dleft = Math.round((Date.parse(fyEnd) - Date.parse(today)) / 864e5);
  return { fy: `FY ${fy0}-${String(fy0 + 1).slice(2)}`, fyEnd, daysLeft: dleft, realised: { ltGain, ltLoss, stNet, used }, remaining, plan, planGain,
    taxSaved: planGain * 0.125, realisedRows: realised, cands, unrealisedLT: cands.reduce((s, c) => s + c.lt_gain, 0) };
}

// ---------------------------------------------------------------- Fund ratings
export const BENCHMARKS = {
  nifty500: { name: "Nifty 500", codes: ["147625"] },
  smallcap250: { name: "Nifty Smallcap 250", codes: ["147623"] },
  midcap150: { name: "Nifty Midcap 150", codes: ["147622"] },
  largemidcap250: { name: "Nifty LargeMidcap 250", codes: ["147666", "147622"], note: "50% Nifty 100 + 50% Midcap 150" },
  nifty50: { name: "Nifty 50", codes: ["120716"] },
  microcap250: { name: "Nifty Microcap 250", codes: ["151814"] },
  it: { name: "Nifty IT", codes: ["148408"] },
  infra: { name: "Nifty Infrastructure", codes: ["140102"] },
};
const PERIODS = [["r6m", 0, 6], ["r1y", 1, 0], ["r3y", 3, 0], ["r5y", 5, 0]];
const minus = (iso, yrs, mos) => { let [y, m, d] = iso.split("-").map(Number); m -= mos; y -= yrs; while (m <= 0) { m += 12; y--; } const t = new Date(Date.UTC(y, m - 1, d)); if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); return t.toISOString().slice(0, 10); };
export function periodReturns(rows) {
  const out = { as_of: null, since: null };
  if (!rows.length) return out;
  const [ld, lnav] = rows[rows.length - 1];
  out.as_of = ld; out.since = rows[0][0];
  for (const [k, yrs, mos] of PERIODS) {
    const target = minus(ld, yrs, mos);
    if (rows[0][0] > addDays(target, 7)) { out[k] = null; continue; }
    const then = (mk.navOn(rows, target) || rows[0])[1];
    const span = yrs + mos / 12, ratio = lnav / then;
    out[k] = span > 1 ? ratio ** (1 / span) - 1 : ratio - 1;
  }
  return out;
}
export function guessBenchmark(name, category) {
  const n = `${name} ${category}`.toLowerCase().replace(/\s+/g, "");
  if (n.includes("microcap")) return "microcap250";
  if (n.includes("smallcap")) return "smallcap250";
  if (n.includes("large&midcap") || n.includes("largeandmidcap") || n.includes("largemidcap")) return "largemidcap250";
  if (n.includes("midcap")) return "midcap150";
  if (n.includes("largecap") || n.includes("nifty50")) return "nifty50";
  if (n.includes("technology") || n.includes("niftyit") || n.includes("digital")) return "it";
  if (n.includes("infrastructure") || n.includes("infra")) return "infra";
  return "nifty500";
}
export async function ratings(p) {
  const funds = p.holdings.filter((h) => h.kind === "mf" && h.symbol && h.units > EPS);
  const codes = new Set([...funds.map((f) => f.symbol), ...Object.values(BENCHMARKS).flatMap((b) => b.codes)]);
  const hist = new Map();
  await Promise.all([...codes].map(async (c) => { try { hist.set(c, await mk.mfHistory(c)); } catch (e) { hist.set(c, []); } }));
  const benchmarks = {};
  for (const [key, b] of Object.entries(BENCHMARKS)) {
    const parts = b.codes.map((c) => periodReturns(hist.get(c) || []));
    const row = { key, name: b.name, note: b.note, as_of: parts[0].as_of };
    PERIODS.forEach(([k]) => { const v = parts.map((x) => x[k]); row[k] = v.every((x) => x != null) ? v.reduce((s, x) => s + x, 0) / v.length : null; });
    benchmarks[key] = row;
  }
  const ov = (await db.kvGet("bench_overrides")) || {};
  return { benchmarks, funds: funds.map((h) => {
    const s = mk.scheme(h.symbol) || {};
    return { id: h.id, name: h.name, code: h.symbol, category: s.category || "", value: h.value,
      benchmark: ov[h.id] || guessBenchmark(h.source_name || h.name, s.category || ""), ...periodReturns(hist.get(h.symbol) || []) };
  }) };
}
export async function setBenchmark(id, key) { const ov = (await db.kvGet("bench_overrides")) || {}; ov[id] = key; await db.kvSet("bench_overrides", ov); }
