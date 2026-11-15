// Excel import/export (SheetJS, bundled for offline use as window.XLSX)
const ALIASES = {
  name: ["scheme or stock name", "name", "scheme name", "stock name", "instrument", "scheme"],
  date: ["investment date", "date", "transaction date"],
  price: ["investment price", "price", "buy price", "nav", "rate"],
  units: ["units", "quantity", "qty", "shares"],
  current_price: ["current price", "ltp", "current nav"],
  account: ["account", "folio", "broker", "demat"],
  type: ["type", "transaction type", "buy/sell", "action"],
  symbol: ["symbol", "ticker", "scheme code", "amfi code", "symbol / amfi code"],
  kind: ["kind", "asset type"],
};

function parseDate(v) {
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[-/ ](\d{1,2})[-/ ](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  throw new Error(`unrecognised date: ${s}`);
}
const num = (v) => (v == null || v === "" ? null : typeof v === "number" ? v : (isFinite(+String(v).replace(/[,₹\s]/g, "")) ? +String(v).replace(/[,₹\s]/g, "") : null));

export function readWorkbook(buf, defaultAccount = "Main") {
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames.includes("Transactions") ? "Transactions" : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  // Some exporters write a wrong sheet size; measure it from the cells actually present
  let maxR = 0, maxC = 0;
  for (const k of Object.keys(ws)) {
    if (k[0] === "!") continue;
    const c = XLSX.utils.decode_cell(k);
    if (c.r > maxR) maxR = c.r;
    if (c.c > maxC) maxC = c.c;
  }
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  let hdr = -1, cols = {};
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const c = {};
    (rows[i] || []).forEach((h, j) => {
      if (h == null) return;
      const k = String(h).trim().toLowerCase();
      for (const [key, names] of Object.entries(ALIASES)) if (!(key in c) && names.includes(k)) c[key] = j;
    });
    if (["name", "date", "units", "price"].every((k) => k in c)) { hdr = i; cols = c; break; }
  }
  if (hdr < 0) throw new Error("Couldn't find the header row (expected: Scheme or Stock name, Investment date, Investment price, Units)");
  const out = [], errors = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i] || [], g = (k) => (k in cols ? r[cols[k]] : null);
    const name = g("name");
    if (!name || !String(name).trim()) continue;
    try {
      let units = num(g("units")); const price = num(g("price"));
      if (units == null || price == null) throw new Error("missing units or price");
      let type = String(g("type") || "BUY").trim().toUpperCase();
      type = type.startsWith("S") || type.startsWith("RED") ? "SELL" : "BUY";
      if (units < 0) { units = -units; type = "SELL"; }
      const k = String(g("kind") || "").trim().toLowerCase();
      out.push({
        name: String(name).trim(), date: parseDate(g("date")), price, units, type,
        current_price: num(g("current_price")),
        account: g("account") ? String(g("account")).trim() : defaultAccount, account_given: !!g("account"),
        symbol: g("symbol") != null && g("symbol") !== "" ? String(g("symbol")).trim() : null,
        kind: k === "stock" || k === "etf" ? "stock" : k === "mf" || k === "mutual fund" ? "mf" : null,
      });
    } catch (e) { errors.push(`row ${i + 1}: ${e.message}`); }
  }
  if (!out.length && errors.length) throw new Error(errors.slice(0, 3).join("; "));
  return out;
}

const NUM2 = "#,##0.00;[Red]-#,##0.00", NUM0 = "#,##0;[Red]-#,##0", NUM4 = "#,##0.0000", PCT = "0.00%", DATE = "dd mmm yyyy";
const dcell = (iso) => ({ t: "d", v: new Date(iso + "T00:00:00Z"), z: DATE });
const n = (v, z) => (v == null ? { t: "s", v: "" } : { t: "n", v, z });
const f = (formula, z) => ({ t: "n", f: formula, z });

/** Same three sheets as the PC app: My Funds (original layout), Summary, Transactions */
export function buildWorkbook(p) {
  const wb = XLSX.utils.book_new();
  // 1. My Funds — one row per open lot, with formulas, exactly like the original export
  const a = [["Scheme or Stock name", "Investment date", "Investment price", "Units", "Investment amount", "Current price", "Current market value", "Gain"]];
  for (const h of p.holdings) for (const l of [...h.lots].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const r = a.length + 1;
    a.push([h.name, dcell(l.date), n(l.price, NUM2), n(+l.units.toFixed(4), NUM2), f(`C${r}*D${r}`, NUM0), n(h.price, NUM2), f(`D${r}*F${r}`, NUM0), f(`G${r}-E${r}`, NUM0)]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(a, { cellDates: true });
  ws1["!cols"] = [45, 15, 15, 12, 18, 12, 20, 12].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, "My Funds");

  // 2. Summary with CAGR / XIRR
  const b = [["Scheme or Stock name", "Type", "Account(s)", "Symbol / AMFI code", "Units", "Avg cost", "Investment amount", "Current price",
    "Price date", "Current market value", "Gain", "Gain %", "Day's change", "Realised gain", "Avg holding (yrs)", "CAGR", "XIRR"]];
  for (const h of [...p.holdings].sort((x, y) => (y.value || 0) - (x.value || 0))) {
    if (h.units <= 1e-9 && !h.realized) continue;
    const r = b.length + 1;
    b.push([h.name, h.kind === "stock" ? "Stock" : "MF", h.accounts.join(", "), h.symbol || "", n(h.units, NUM4), n(h.avg_cost, NUM2),
      n(h.invested, NUM0), n(h.price, NUM2), h.price_date ? dcell(h.price_date) : "", n(h.value, NUM0), f(`J${r}-G${r}`, NUM0),
      f(`IF(G${r}=0,"",K${r}/G${r})`, PCT), n(h.day_change, NUM0), n(h.realized, NUM0), n(h.years, "0.00"), n(h.cagr, PCT), n(h.xirr, PCT)]);
  }
  const last = b.length, s = p.summary;
  b.push(["TOTAL", "", "", "", "", "", f(`SUM(G2:G${last})`, NUM0), "", "", f(`SUM(J2:J${last})`, NUM0), f(`SUM(K2:K${last})`, NUM0),
    f(`IF(G${last + 1}=0,"",K${last + 1}/G${last + 1})`, PCT), f(`SUM(M2:M${last})`, NUM0), f(`SUM(N2:N${last})`, NUM0), n(s.years, "0.00"), n(s.cagr, PCT), n(s.xirr, PCT)]);
  const ws2 = XLSX.utils.aoa_to_sheet(b, { cellDates: true });
  ws2["!cols"] = [45, 8, 16, 18, 12, 12, 18, 12, 13, 20, 14, 10, 13, 13, 10, 10, 10].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, "Summary");

  // 3. Full transaction log (re-importable)
  const c = [["Scheme or Stock name", "Type", "Account", "Investment date", "Units", "Investment price", "Amount", "Kind", "Symbol", "Note"]];
  for (const h of p.holdings) for (const t of [...h.transactions].reverse()) {
    const r = c.length + 1;
    c.push([h.name, t.type, t.account, dcell(t.date), n(t.units, NUM4), n(t.price, NUM2), f(`E${r}*F${r}`, NUM0), h.kind, h.symbol || "", t.note || ""]);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(c, { cellDates: true });
  ws3["!cols"] = [45, 8, 14, 15, 14, 15, 16, 8, 18, 30].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws3, "Transactions");

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", cellDates: true });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
