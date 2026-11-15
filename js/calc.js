// Return maths: FIFO holdings, CAGR and Excel-compatible XIRR (same as the PC app).
export const EPS = 1e-9;
const DAY = 864e5;
const d2n = (s) => Date.parse(s.slice(0, 10) + "T00:00:00Z");

export function xirr(flows) {
  flows = flows.filter(([, a]) => Math.abs(a) > EPS).map(([d, a]) => [d2n(d), a]);
  if (flows.length < 2 || !flows.some(([, a]) => a < 0) || !flows.some(([, a]) => a > 0)) return null;
  const d0 = Math.min(...flows.map(([d]) => d));
  const ts = flows.map(([d, a]) => [(d - d0) / DAY / 365, a]);
  if (Math.max(...ts.map(([t]) => t)) <= 0) return null;
  const npv = (r) => ts.reduce((s, [t, a]) => s + a / (1 + r) ** t, 0);
  const dnpv = (r) => ts.reduce((s, [t, a]) => s - (t * a) / (1 + r) ** (t + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(r), df = dnpv(r);
    if (!isFinite(f) || !isFinite(df) || df === 0) break;
    let nr = r - f / df;
    if (nr <= -0.999999) nr = (r - 0.999999) / 2;
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
  while (flo * fhi > 0 && hi < 1e6) { hi *= 4; fhi = npv(hi); }
  if (!(flo * fhi <= 0)) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export function cagr(start, end, years) {
  if (!start || start <= 0 || end == null || end < 0 || years <= 0) return null;
  const v = (end / start) ** (1 / years) - 1;
  return isFinite(v) ? v : null;
}

export const sortTx = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);

export function computeHolding(txns, price, prev, today) {
  const lots = [], flows = [];
  let realized = 0;
  for (const t of [...txns].sort(sortTx)) {
    const amt = t.units * t.price;
    if (t.type === "BUY") {
      lots.push({ txn_id: t.id, date: t.date, units: t.units, price: t.price, account: t.account });
      flows.push([t.date, -amt]);
    } else {
      flows.push([t.date, amt]);
      let rem = t.units;
      while (rem > EPS && lots.length) {
        const l = lots[0], take = Math.min(l.units, rem);
        realized += take * (t.price - l.price);
        l.units -= take; rem -= take;
        if (l.units <= EPS) lots.shift();
      }
    }
  }
  const units = lots.reduce((s, l) => s + l.units, 0);
  const invested = lots.reduce((s, l) => s + l.units * l.price, 0);
  const value = price != null ? units * price : null;
  const tn = d2n(today);
  for (const l of lots) {
    l.amount = l.units * l.price;
    l.years = Math.max(0, (tn - d2n(l.date)) / DAY) / 365;
    if (price != null) { l.value = l.units * price; l.gain = l.value - l.amount; l.cagr = l.years > 0 ? cagr(l.amount, l.value, l.years) : null; }
  }
  const years = invested > EPS ? lots.reduce((s, l) => s + l.amount * l.years, 0) / invested : 0;
  const xf = [...flows];
  if (value != null && units > EPS) xf.push([today, value]);
  return {
    units, invested, value, realized, years, lots, flows,
    avg_cost: units > EPS ? invested / units : null,
    gain: value != null ? value - invested : null,
    gain_pct: value != null && invested > EPS ? (value - invested) / invested : null,
    day_change: price != null && prev ? units * (price - prev) : null,
    day_change_pct: price != null && prev ? (price - prev) / prev : null,
    cagr: value != null && years > 0 ? cagr(invested, value, years) : null,
    xirr: xirr(xf),
  };
}

/** instruments + txns -> {summary, holdings, accounts} */
export function portfolio(instruments, txns, { account = "", kind = "", includeClosed = false, today }) {
  const accounts = [...new Set(txns.map((t) => t.account))].sort();
  const by = new Map();
  for (const t of txns) {
    if (account && t.account !== account) continue;
    if (!by.has(t.instrument_id)) by.set(t.instrument_id, []);
    by.get(t.instrument_id).push(t);
  }
  const holdings = [], all = [];
  let inv = 0, val = 0, day = 0, real = 0, wy = 0;
  for (const inst of instruments) {
    if (kind && inst.kind !== kind) continue;
    const ts = by.get(inst.id);
    if (!ts) continue;
    const h = computeHolding(ts, inst.price, inst.prev_close, today);
    if (h.units <= EPS && !includeClosed) continue;
    all.push(...h.flows);
    if (h.value != null) { val += h.value; if (h.units > EPS) all.push([today, h.value]); }
    inv += h.invested; day += h.day_change || 0; real += h.realized; wy += h.invested * h.years;
    Object.assign(h, { id: inst.id, name: inst.name, kind: inst.kind, symbol: inst.symbol, source_name: inst.source_name,
      price: inst.price, prev_close: inst.prev_close, price_date: inst.price_date, needs_review: inst.needs_review,
      accounts: [...new Set(ts.map((t) => t.account))].sort(), transactions: [...ts].sort(sortTx).reverse() });
    holdings.push(h);
  }
  const years = inv ? wy / inv : 0, prevVal = val - day;
  return {
    accounts, holdings,
    summary: {
      invested: inv, value: val, gain: val - inv, gain_pct: inv ? (val - inv) / inv : null,
      day_change: day, day_change_pct: prevVal ? day / prevVal : null, realized: real, years,
      cagr: years > 0 ? cagr(inv, val, years) : null, xirr: xirr(all), count: holdings.length,
    },
  };
}
