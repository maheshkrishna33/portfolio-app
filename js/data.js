// Portfolio operations on the phone's database.
import * as db from "./db.js";
import * as mk from "./market.js";
import { portfolio as calcPortfolio } from "./calc.js";
import { todayIST, nowStamp } from "./util.js";

const STOCK_RE = /\s-\s([A-Z0-9&\-]+\.(?:NS|BO))\s*$/i;
export function guessKind(name) { const m = name.match(STOCK_RE); return m ? ["stock", m[1].toUpperCase()] : ["mf", null]; }

export async function getPortfolio(opts = {}) {
  const [insts, txns] = await Promise.all([db.all("instruments"), db.all("txns")]);
  return calcPortfolio(insts, txns, { ...opts, today: todayIST() });
}

function cleanTxn(d) {
  const type = (d.type || "BUY").toUpperCase();
  if (!["BUY", "SELL"].includes(type)) throw new Error("Type must be BUY or SELL");
  const units = +d.units, price = +d.price;
  if (!(units > 0)) throw new Error("Units must be more than zero");
  if (!(price >= 0)) throw new Error("Price can't be negative");
  const date = String(d.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");
  return { type, units, price, date, account: (d.account || "Main").trim() || "Main", note: d.note || "" };
}

/** Build an instrument record for a name (auto-detecting stock ticker or matching the fund to AMFI) */
function newInstrument(id, name, kind, symbol, hint) {
  const [gk, gs] = guessKind(name);
  kind = kind || gk; symbol = symbol || gs;
  const inst = { id, name: name.trim(), kind, symbol, source_name: null, price: hint ?? null, prev_close: null, price_date: null, needs_review: false };
  if (kind === "mf") {
    if (!symbol) {
      const [s, ok] = mk.matchFund(name, hint);
      if (s) Object.assign(inst, { symbol: s.code, source_name: s.name, price: s.nav, prev_close: s.prev, price_date: s.date });
      inst.needs_review = !ok;
    } else {
      const s = mk.scheme(symbol);
      if (s) Object.assign(inst, { source_name: s.name, price: s.nav, prev_close: s.prev, price_date: s.date });
    }
  } else if (symbol) {
    const q = mk.stock(symbol);
    if (q) Object.assign(inst, { price: q.close, prev_close: q.prev, price_date: q.date });
  }
  return inst;
}

const nextId = (rows) => rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

export async function addTransaction(d) {
  const t = cleanTxn(d);
  const [insts, txns] = await Promise.all([db.all("instruments"), db.all("txns")]);
  let iid = d.instrument_id;
  let inst = null;
  if (!iid) {
    const ni = d.instrument || {};
    if (!ni.name) throw new Error("Pick a stock or fund");
    const ex = insts.find((i) => i.name === ni.name.trim() || (ni.symbol && i.symbol === ni.symbol));
    if (ex) iid = ex.id;
    else { inst = newInstrument(nextId(insts), ni.name, ni.kind, ni.symbol, ni.price); inst.needs_review = false; iid = inst.id; }
  }
  const txn = { id: nextId(txns), instrument_id: iid, ...t };
  await db.atomic(["instruments", "txns"], (s) => { if (inst) s.instruments.put(inst); s.txns.put(txn); });
  return txn.id;
}

export async function updateTransaction(id, d) {
  const t = cleanTxn(d), old = await db.get("txns", id);
  if (!old) throw new Error("Transaction not found");
  await db.put("txns", { ...old, ...t });
}

export async function deleteTransaction(id) {
  const t = await db.get("txns", id);
  if (!t) return;
  const rest = (await db.all("txns")).filter((x) => x.instrument_id === t.instrument_id && x.id !== id);
  await db.atomic(["txns", "instruments", "rules"], (s) => {
    s.txns.delete(id);
    if (!rest.length) s.instruments.delete(t.instrument_id);
  });
}

export async function deleteInstrument(iid) {
  const txns = (await db.all("txns")).filter((t) => t.instrument_id === iid);
  const rules = (await db.all("rules")).filter((r) => r.instrument_id === iid);
  await db.atomic(["txns", "instruments", "rules"], (s) => {
    txns.forEach((t) => s.txns.delete(t.id)); rules.forEach((r) => s.rules.delete(r.id)); s.instruments.delete(iid);
  });
}

export async function updateInstrument(iid, { name, kind, symbol }) {
  const i = await db.get("instruments", iid);
  if (!i) throw new Error("Holding not found");
  symbol = (symbol || "").trim() || null;
  if (kind === "stock" && symbol) symbol = symbol.toUpperCase();
  if (symbol !== i.symbol || kind !== i.kind) {
    Object.assign(i, { source_name: null, price: null, prev_close: null, price_date: null });
    if (kind === "mf" && symbol) {
      const s = mk.scheme(symbol);
      if (!s) throw new Error(`AMFI scheme code ${symbol} not found`);
      Object.assign(i, { source_name: s.name, price: s.nav, prev_close: s.prev, price_date: s.date });
    } else if (kind === "stock" && symbol) {
      const q = mk.stock(symbol);
      if (!q) throw new Error(`${symbol} isn't in today's NSE/BSE price list`);
      Object.assign(i, { price: q.close, prev_close: q.prev, price_date: q.date });
    }
  }
  Object.assign(i, { name: (name || i.name).trim(), kind, symbol, needs_review: false });
  await db.put("instruments", i);
}

export async function setInstrumentAccount(iid, account) {
  const txns = (await db.all("txns")).filter((t) => t.instrument_id === iid);
  await db.atomic(["txns"], (s) => txns.forEach((t) => s.txns.put({ ...t, account: account.trim() || "Main" })));
}

/** Import rows. Overwrite (default) replaces everything but keeps hand-fixed price sources,
 *  single-account holdings and alert rules (matched by holding name). All-or-nothing. */
export async function importRows(rows, replace = true) {
  if (replace) await backupNow("before-import");
  const [insts0, txns0, rules0] = await Promise.all([db.all("instruments"), db.all("txns"), db.all("rules")]);
  const keepLinks = new Map(insts0.map((i) => [i.name, i]));
  const keepAcct = new Map();
  if (replace) {
    const accts = new Map();
    txns0.forEach((t) => { const n = insts0.find((i) => i.id === t.instrument_id)?.name; if (!n) return; if (!accts.has(n)) accts.set(n, new Set()); accts.get(n).add(t.account); });
    accts.forEach((set, nm) => { if (set.size === 1) keepAcct.set(nm, [...set][0]); });
  }
  const insts = replace ? [] : [...insts0];
  const txns = replace ? [] : [...txns0];
  const hints = new Map();
  rows.forEach((r) => { if (r.current_price && !hints.has(r.name)) hints.set(r.name, r.current_price); });
  const byName = new Map(insts.map((i) => [i.name, i]));
  let added = 0, skipped = 0, created = 0, iid = replace ? 1 : nextId(insts0), tid = replace ? 1 : nextId(txns0);
  for (const r of rows) {
    let inst = byName.get(r.name);
    if (!inst) {
      const old = replace && !r.symbol ? keepLinks.get(r.name) : null;
      inst = old ? { ...old, id: iid++ } : newInstrument(iid++, r.name, r.kind, r.symbol, hints.get(r.name));
      byName.set(inst.name, inst); insts.push(inst); created++;
    }
    const acct = !r.account_given && keepAcct.has(r.name) ? keepAcct.get(r.name) : r.account;
    const t = cleanTxn({ ...r, account: acct });
    const dup = txns.some((x) => x.instrument_id === inst.id && x.account === t.account && x.date === t.date && x.type === t.type &&
      Math.abs(x.units - t.units) < 1e-6 && Math.abs(x.price - t.price) < 1e-6);
    if (dup) { skipped++; continue; }
    txns.push({ id: tid++, instrument_id: inst.id, ...t });
    added++;
  }
  const rules = [];
  if (replace) {
    const oldName = new Map(insts0.map((i) => [i.id, i.name]));
    let rid = 1;
    for (const r of rules0) { const nm = oldName.get(r.instrument_id); const ni = nm && byName.get(nm); if (ni) rules.push({ ...r, id: rid++, instrument_id: ni.id }); }
  }
  await db.atomic(["instruments", "txns", "rules"], (s) => {
    if (replace) { s.instruments.clear(); s.txns.clear(); s.rules.clear(); rules.forEach((r) => s.rules.put(r)); }
    insts.forEach((i) => s.instruments.put(i));
    txns.forEach((t) => { if (replace || !txns0.includes(t)) s.txns.put(t); });
  });
  return { mode: replace ? "replace" : "append", removed: replace ? txns0.length : 0, added, skipped, created,
    review: insts.filter((i) => i.needs_review).map((i) => i.name) };
}

// ---------------------------------------------------------------- backups (kept on the phone)
export async function snapshot() {
  const [instruments, txns, rules] = await Promise.all([db.all("instruments"), db.all("txns"), db.all("rules")]);
  return { app: "portfolio-phone", version: 1, saved: nowStamp(), instruments, txns, rules };
}
const KEEP = { daily: 30, "before-import": 10, "before-restore": 10, manual: 20 };
export async function backupNow(tag = "manual") {
  const data = await snapshot();
  await db.put("backups", { ts: nowStamp(), date: todayIST(), tag, count: data.txns.length, data });
  const list = (await db.all("backups")).sort((a, b) => b.id - a.id);
  const seen = {};
  for (const b of list) { seen[b.tag] = (seen[b.tag] || 0) + 1; if (seen[b.tag] > (KEEP[b.tag] || 20)) await db.del("backups", b.id); }
}
export async function dailyBackupIfNeeded() {
  const today = todayIST();
  if (!(await db.all("backups")).some((b) => b.tag === "daily" && b.date === today) && (await db.all("txns")).length) await backupNow("daily");
}
export async function listBackups() {
  return (await db.all("backups")).map(({ data, ...rest }) => rest).sort((a, b) => b.id - a.id);
}
export async function restoreData(data) {
  if (!data || !Array.isArray(data.instruments) || !Array.isArray(data.txns)) throw new Error("That isn't a Portfolio backup file");
  await backupNow("before-restore");
  await db.atomic(["instruments", "txns", "rules"], (s) => {
    s.instruments.clear(); s.txns.clear(); s.rules.clear();
    data.instruments.forEach((i) => s.instruments.put(i)); data.txns.forEach((t) => s.txns.put(t)); (data.rules || []).forEach((r) => s.rules.put(r));
  });
}
export async function restoreBackup(id) { const b = await db.get("backups", id); if (!b) throw new Error("Backup not found"); await restoreData(b.data); }
