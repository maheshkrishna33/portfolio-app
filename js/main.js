import * as db from "./db.js";
import * as mk from "./market.js";
import * as data from "./data.js";
import * as feat from "./features.js";
import * as alerts from "./alerts.js";
import { readWorkbook, buildWorkbook } from "./excel.js";
import { lineChart, barChart, hbars, showTip, hideTip, tipRow } from "./charts.js";
import { $, $$, esc, inr, signed, pct, cls, inrShort, fmtDate, nf0, nf2, nf3, MON, monLabel, todayIST, toast, saveFile, pickFile } from "./util.js";

const S = {
  tab: "home", kind: "", account: "", q: "", sort: "value", asc: false, p: null,
  pl: { ovUp: false, ovDown: false, tdUp: false, tdDown: false, y1: false, y3: false }, perf: null, th: { y1: 11, y3: 11 },
  seg: "monthly", range: "All", monthsRange: 36, weights: { r5y: 5, r1y: 4, r6m: 3, r3y: 2, excess: 1 }, missing: "zero",
};
try { Object.assign(S.weights, JSON.parse(localStorage.getItem("weights") || "{}")); } catch (e) { /* ignore */ }
try { Object.assign(S.th, JSON.parse(localStorage.getItem("perfThresholds") || "{}")); } catch (e) { /* ignore */ }
const view = $("#view");
const CAP_COLORS = { "Large cap": "var(--s1)", "Mid cap": "var(--s2)", "Small cap": "var(--s3)", "Micro cap": "var(--s4)", Flexible: "var(--s5)", "Other listed": "var(--ink3)" };

// ---------------------------------------------------------------- sheets (full-screen panels; phone Back button closes them)
const sheets = [];
function openSheet(title, html, mount) {
  const el = document.createElement("section");
  el.className = "sheet";
  el.innerHTML = `<header class="sheethead"><button class="iconbtn" data-back aria-label="Back">‹</button><h2>${esc(title)}</h2></header><div class="sheetbody">${html}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));
  sheets.push(el);
  history.pushState({ sheet: sheets.length }, "");
  el.querySelector("[data-back]").addEventListener("click", () => history.back());
  mount?.(el.querySelector(".sheetbody"), el);
  return el;
}
function closeTopSheet() {
  const el = sheets.pop();
  if (!el) return;
  el.classList.remove("open");
  setTimeout(() => el.remove(), 250);
}
const closeSheet = () => history.back();
addEventListener("popstate", (e) => { const depth = e.state?.sheet || 0; while (sheets.length > depth) closeTopSheet(); });

// ---------------------------------------------------------------- refresh / load
async function loadPortfolio() {
  S.p = await data.getPortfolio({ account: S.account, kind: S.kind });
  return S.p;
}
async function refresh({ force = false, quiet = false, manual = false } = {}) {
  const btn = $("#refreshBtn");
  btn.classList.add("spin");
  try {
    const { meta, online } = await mk.ensureMarket({ force, manual });
    await mk.applyPrices();
    const pAll = await data.getPortfolio({});
    const n = await alerts.check(pAll);
    if (n) toast(`${n} new alert${n > 1 ? "s" : ""} — see More › Alerts`);
    else if (!quiet) toast(online ? "Prices up to date" : "Offline — showing saved prices");
    mk.backfillPrevNavs().then(() => { if (S.tab === "home" && !sheets.length) render(); });
    updateInfo(meta);
  } catch (e) {
    if (!quiet) toast(e.message, 4000);
  } finally {
    btn.classList.remove("spin");
  }
  await render();
  updateBadge();
}
function updateInfo(meta) {
  meta = meta || mk.marketMeta();
  if (!meta) { $("#dataInfo").textContent = "No market data yet"; return; }
  const sd = meta.trade_dates?.NSE || meta.trade_dates?.BSE;
  $("#dataInfo").textContent = `Stocks ${sd ? fmtDate(sd) : "—"} · NAVs ${fmtDate(meta.nav_date)}`;
}
async function updateBadge() {
  const n = await alerts.unreadCount();
  const b = $("#moreBadge"); b.textContent = n; b.classList.toggle("hidden", !n);
}

// ---------------------------------------------------------------- navigation
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  S.tab = b.dataset.tab;
  $$("#nav button").forEach((x) => x.classList.toggle("on", x === b));
  window.scrollTo(0, 0);
  render();
});
$("#refreshBtn").addEventListener("click", () => refresh({ manual: true }));
$("#fab").addEventListener("click", () => openTxnForm({}));

async function render() {
  $("#fab").classList.toggle("hidden", S.tab !== "home");
  try {
    if (S.tab === "home") await renderHome();
    else if (S.tab === "growth") await renderGrowth();
    else if (S.tab === "insights") await renderInsights();
    else if (S.tab === "tax") await renderTax();
    else if (S.tab === "more") await renderMore();
  } catch (e) {
    view.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
  }
}
const loading = (t) => { view.innerHTML = `<div class="card muted">${t}</div>`; };
function filtersHtml(showSearch) {
  const accts = S.p?.accounts || [];
  return `<div class="filters">
    <div class="chips" id="kindChips">${[["", "All"], ["mf", "Funds"], ["stock", "Stocks"]].map(([k, l]) => `<button class="${S.kind === k ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
    ${accts.length > 1 ? `<select id="acctSel"><option value="">All accounts</option>${accts.map((a) => `<option ${a === S.account ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>` : ""}
    ${showSearch ? `<input id="q" type="search" placeholder="Search" value="${esc(S.q)}">
    <select id="sortSel">${[["value", "Value"], ["gain", "Ovr gain"], ["gain_pct", "Ovr gain %"], ["day_change", "Today"], ["day_change_pct", "Today %"], ["xirr", "XIRR"], ["r1y", "1Y return"], ["r3y", "3Y CAGR"], ["name", "Name"]].map(([k, l]) => `<option value="${k}" ${S.sort === k ? "selected" : ""}>Sort: ${l}</option>`).join("")}</select>
    <button class="chipbtn" id="sortDir" title="Reverse order">${S.asc ? "↑" : "↓"}</button>` : ""}
  </div>`;
}
function bindFilters(rerender) {
  $("#kindChips")?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.kind = b.dataset.k; rerender(); });
  $("#acctSel")?.addEventListener("change", (e) => { S.account = e.target.value; rerender(); });
}

// ---------------------------------------------------------------- Home
async function renderHome() {
  await loadPortfolio();
  const { summary: s, holdings } = S.p;
  if (!holdings.length && !S.kind && !S.account) {
    view.innerHTML = `<div class="card welcome"><h2>Welcome 👋</h2><p>Your portfolio lives only on this phone.</p>
      <button class="btn primary block" id="wImport">Import my Excel file</button>
      <button class="btn block" id="wAdd">Add a fund or stock</button>
      <p class="muted small">Import accepts your “My Funds” export or the PC app's “Portfolio Latest.xlsx”.</p></div>`;
    $("#wImport").onclick = importExcel; $("#wAdd").onclick = () => openTxnForm({});
    return;
  }
  const short = s.years > 0 && s.years < 1;
  const review = holdings.filter((h) => h.needs_review).length, noPrice = holdings.filter((h) => h.price_date == null).length;
  const mfV = holdings.filter((h) => h.kind === "mf").reduce((a, h) => a + (h.value || 0), 0), stV = s.value - mfV;
  view.innerHTML = `
    <div class="hero">
      <div class="k">Current value</div><div class="big">${inr(s.value)}</div>
      <div class="${cls(s.gain)}">${signed(s.gain)} (${pct(s.gain_pct)}) <span class="muted">overall</span></div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Today</div><div class="v ${cls(s.day_change)}">${signed(s.day_change)}</div><div class="s ${cls(s.day_change)}">${pct(s.day_change_pct)}</div></div>
      <div class="tile"><div class="k">Invested</div><div class="v">${inrShort(s.invested)}</div><div class="s muted">${s.count} holdings</div></div>
      <div class="tile"><div class="k">XIRR</div><div class="v ${cls(s.xirr)}">${pct(s.xirr, false)}</div><div class="s muted">money-weighted</div></div>
      <div class="tile"><div class="k">CAGR</div><div class="v ${cls(s.cagr)} ${short ? "dim" : ""}">${pct(s.cagr, false)}</div><div class="s muted">${s.years.toFixed(1)} yrs avg</div></div>
    </div>
    ${s.value ? `<div class="split"><div class="bar"><span style="width:${(mfV / s.value) * 100}%;background:var(--s1)"></span><span style="width:${(stV / s.value) * 100}%;background:var(--s2)"></span></div>
      <div class="legend"><span><i style="background:var(--s1)"></i>Funds ${inrShort(mfV)} · ${((mfV / s.value) * 100).toFixed(0)}%</span><span><i style="background:var(--s2)"></i>Stocks ${inrShort(stV)} · ${((stV / s.value) * 100).toFixed(0)}%</span></div></div>` : ""}
    ${review || noPrice ? `<div class="banner">${review ? `${review} holding(s) were linked to a price source automatically (marked “check”) — open them to confirm.` : ""}${noPrice ? `${noPrice} holding(s) have no price yet.` : ""}</div>` : ""}
    ${filtersHtml(true)}
    <div class="plbox" id="plBox"></div>
    <div class="list" id="hlist"></div>`;
  bindFilters(renderHome);
  const draw = (animate = false) => {
    holdings.forEach((h) => { const p = S.perf?.[h.id]; h.r1y = p ? p.r1y : null; h.r3y = p ? p.r3y : null; });
    const q = S.q.toLowerCase(), k = S.sort;
    const found = holdings.filter((h) => !q || h.name.toLowerCase().includes(q) || (h.symbol || "").toLowerCase().includes(q));
    // highest first (A→Z for names); the ↓/↑ button reverses; holdings without that figure always go last
    const has = found.filter((h) => k === "name" || h[k] != null), none = found.filter((h) => k !== "name" && h[k] == null);
    has.sort((a, b) => (k === "name" ? a.name.localeCompare(b.name) : b[k] - a[k]));
    if (S.asc) has.reverse();
    let rows = has.concat(none);
    // Overall / Today chips: counts come from the list before the chip filters, so they stay put when ticked
    renderPL(rows.filter((h) => h.units > 1e-9));
    const P = S.pl, ov = P.ovUp || P.ovDown, td = P.tdUp || P.tdDown, lag = P.y1 || P.y3;
    if (ov || td || lag) rows = rows.filter((h) => h.units > 1e-9 &&
      (!ov || (P.ovUp && h.gain > 0) || (P.ovDown && h.gain < 0)) &&
      (!td || (P.tdUp && h.day_change_pct > 0) || (P.tdDown && h.day_change_pct < 0)) &&
      // both "lagging" boxes ticked = lagging on BOTH 1 year and 3 years
      (!P.y1 || (h.r1y != null && h.r1y * 100 < S.th.y1)) &&
      (!P.y3 || (h.r3y != null && h.r3y * 100 < S.th.y3)));
    const pv = (v, th, suffix = "") => (v == null ? "—" : `<span class="${cls(v)}">${v * 100 < th ? '<i class="lagdot"></i>' : ""}${pct(v)}${suffix}</span>`);
    const list = $("#hlist");
    list.classList.toggle("animate", animate);
    list.innerHTML = rows.map((h, i) => `<button class="item" data-id="${h.id}" style="--i:${Math.min(i, 20)}">
      <div class="l"><div class="nm"><span class="tag">${h.kind === "mf" ? "MF" : "Stock"}</span>${h.needs_review ? `<span class="tag warn">check</span>` : ""}<span class="${h.units > 1e-9 ? cls(h.gain) : ""}">${esc(h.name)}</span></div>
        <div class="sub">${nf3.format(h.units)} units · ${h.price != null ? nf2.format(h.price) : "no price"}${h.accounts.length && S.p.accounts.length > 1 ? " · " + esc(h.accounts.join(", ")) : ""}</div>
        ${S.perf ? `<div class="sub perf">1Y ${pv(h.r1y, S.th.y1)} · 3Y ${pv(h.r3y, S.th.y3, " p.a.")}</div>` : ""}</div>
      <div class="r"><div class="v">${inr(h.value)}</div>
        <div class="gl ${cls(h.gain)}"><span class="lbl">Ovr</span> ${signed(h.gain)} · <b>${pct(h.gain_pct)}</b></div>
        <div class="gl ${cls(h.day_change)}"><span class="lbl">Today</span> ${h.day_change_pct != null ? `${signed(h.day_change)} · <b>${pct(h.day_change_pct)}</b>` : "—"}</div></div>
    </button>`).join("") || `<div class="card muted">${ov || td || lag ? "No holdings match the ticked boxes." : "Nothing matches."}</div>`;
  };
  // tick-box filters on the chips; threshold boxes recount while typing, refilter when done
  $("#plBox").addEventListener("change", (e) => {
    const k = e.target.dataset.pl;
    if (k) { S.pl[k] = e.target.checked; draw(true); return; }
    if (e.target.dataset.th) draw(true);
  });
  $("#plBox").addEventListener("input", (e) => {
    const k = e.target.dataset.th; if (!k) return;
    const v = parseFloat(e.target.value); if (!isFinite(v)) return;
    S.th[k] = v;
    try { localStorage.setItem("perfThresholds", JSON.stringify(S.th)); } catch (err) { /* ignore */ }
    const f = k === "y1" ? "r1y" : "r3y";
    const n = holdings.filter((h) => h.units > 1e-9 && h[f] != null && h[f] * 100 < v).length;
    const b = $(`#plBox b[data-k="${S.kind}-${k}"]`); if (b) countUp(b, n);
  });
  // 1Y / 3Y returns load in the background (cached per day), then the list refreshes
  feat.perfReturns(holdings).then((m) => { if (S.tab === "home") { S.perf = { ...(S.perf || {}), ...m }; draw(); } }).catch(() => {});
  $("#plBox").addEventListener("click", (e) => { if (e.target.id !== "plClear") return; Object.keys(S.pl).forEach((k) => (S.pl[k] = false)); draw(true); });
  draw(true);
  $("#q").addEventListener("input", (e) => { S.q = e.target.value; draw(); });
  $("#sortSel").addEventListener("change", (e) => { S.sort = e.target.value; draw(true); });
  $("#sortDir").addEventListener("click", () => { S.asc = !S.asc; $("#sortDir").textContent = S.asc ? "↑" : "↓"; draw(true); });
  $("#hlist").addEventListener("click", (e) => { const b = e.target.closest(".item"); if (b) openHolding(+b.dataset.id); });
}

// ---------------------------------------------------------------- Overall / Today profit-loss chips
const plShown = {};  // last number shown per chip, so changes count up from the old value
function countUp(el, to) {
  const from = plShown[el.dataset.k] ?? 0;
  plShown[el.dataset.k] = to;
  if (from === to) { el.textContent = to; return; }
  const chip = el.closest(".plchip");
  chip?.classList.remove("bump"); void el.offsetWidth; chip?.classList.add("bump");
  const t0 = performance.now(), dur = 650;
  const step = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - (1 - p) ** 3; el.textContent = Math.round(from + (to - from) * e); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function renderPL(held) {
  const box = $("#plBox");
  if (!box) return;
  if (!held.length) { box.innerHTML = ""; return; }
  const c = { ovUp: held.filter((h) => h.gain > 0).length, ovDown: held.filter((h) => h.gain < 0).length,
    tdUp: held.filter((h) => h.day_change_pct > 0).length, tdDown: held.filter((h) => h.day_change_pct < 0).length };
  const ovFlat = held.length - c.ovUp - c.ovDown, tdFlat = held.length - c.tdUp - c.tdDown;
  const chip = (k, dir, label) => `<label class="plchip ${dir} ${S.pl[k] ? "on" : ""}">
      <input type="checkbox" data-pl="${k}" ${S.pl[k] ? "checked" : ""}><span class="arrow">${dir === "up" ? "▲" : "▼"}</span>
      <b data-k="${S.kind}-${k}">${plShown[`${S.kind}-${k}`] ?? 0}</b><span>${label}</span></label>`;
  // under-performers: the stock / fund's own price return below your thresholds
  c.y1 = held.filter((h) => h.r1y != null && h.r1y * 100 < S.th.y1).length;
  c.y3 = held.filter((h) => h.r3y != null && h.r3y * 100 < S.th.y3).length;
  const perfChip = (k, label) => `<span class="plperf">${chip(k, "down", label)}<input type="number" inputmode="decimal" class="thr" data-th="${k}" value="${S.th[k]}" step="0.5">%</span>`;
  const any = Object.values(S.pl).some(Boolean);
  const what = S.kind === "stock" ? "stocks" : S.kind === "mf" ? "funds" : "holdings";
  box.innerHTML = `
    <div class="plgroup"><span class="pllab">Overall</span>${chip("ovUp", "up", "profit")}${chip("ovDown", "down", "loss")}${ovFlat ? `<span class="plflat">${ovFlat} flat</span>` : ""}</div>
    <div class="plgroup"><span class="pllab">Today</span>${chip("tdUp", "up", "up")}${chip("tdDown", "down", "down")}${tdFlat ? `<span class="plflat">${tdFlat} same</span>` : ""}</div>
    <div class="plgroup"><span class="pllab">Lagging</span>${S.perf ? perfChip("y1", "1Y &lt;") + perfChip("y3", "3Y &lt;") : `<span class="plflat">working out 1Y / 3Y returns…</span>`}</div>
    ${any ? `<button type="button" class="chipbtn" id="plClear">Show all ${what}</button>` : ""}`;
  box.querySelectorAll("b[data-k]").forEach((b) => countUp(b, c[b.dataset.k.split("-")[1]]));
}

// ---------------------------------------------------------------- Holding detail
async function openHolding(id) {
  const pAll = await data.getPortfolio({ includeClosed: true });
  const h = pAll.holdings.find((x) => x.id === id);
  if (!h) return;
  const lot = new Map(h.lots.map((l) => [l.txn_id, l]));
  const stat = (k, v, c = "") => `<div class="tile"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`;
  openSheet(h.kind === "mf" ? "Mutual fund" : "Stock", `
    <h3 class="title">${esc(h.name)}</h3>
    <p class="muted small">${esc(h.symbol || "No price source")}${h.source_name && h.source_name !== h.name ? " · " + esc(h.source_name) : ""} · price ${h.price != null ? nf2.format(h.price) : "—"} on ${fmtDate(h.price_date)}</p>
    ${h.needs_review ? `<div class="banner">This fund was matched to an AMFI scheme automatically. Check it's the right plan (Direct/Regular, Growth/IDCW) using “Edit / price source”.</div>` : ""}
    <div class="tiles">
      ${stat("Value", inr(h.value))}${stat("Ovr gain", `${signed(h.gain)}<div class="s">${pct(h.gain_pct)}</div>`, cls(h.gain))}
      ${stat("Today", `${signed(h.day_change)}<div class="s">${pct(h.day_change_pct)}</div>`, cls(h.day_change))}${stat("Invested", inr(h.invested))}
      ${stat("Units", nf3.format(h.units))}${stat("Avg cost", h.avg_cost != null ? nf2.format(h.avg_cost) : "—")}
      ${stat("XIRR", pct(h.xirr, false), cls(h.xirr))}${stat("CAGR", pct(h.cagr, false), cls(h.cagr))}
      ${h.realized ? stat("Realised", signed(h.realized), cls(h.realized)) : ""}
    </div>
    <div class="actions">
      <button class="btn primary" data-a="buy">+ Buy more</button><button class="btn" data-a="sell">Sell / redeem</button>
      <button class="btn" data-a="edit">Edit / price source</button><button class="btn" data-a="acct">Move account</button>
      <button class="btn" data-a="alert">Price alert</button><button class="btn danger" data-a="del">Delete</button>
    </div>
    <h4>Transactions</h4>
    <div class="list">${h.transactions.map((t) => { const l = lot.get(t.id); return `<button class="item" data-t="${t.id}">
      <div class="l"><div class="nm">${t.type === "SELL" ? '<span class="tag sell">SELL</span>' : ""}${fmtDate(t.date)}</div>
        <div class="sub">${nf3.format(t.units)} @ ${nf2.format(t.price)} · ${esc(t.account)}${l && Math.abs(l.units - t.units) > 1e-6 ? ` · ${nf3.format(l.units)} left` : ""}${t.note ? " · " + esc(t.note) : ""}</div></div>
      <div class="r"><div class="v">${inr(t.units * t.price)}</div>${l ? `<div class="${cls(l.gain)}">${signed(l.gain)}</div><div class="sub ${l.years < 1 ? "dim" : ""}">CAGR ${pct(l.cagr, false)}</div>` : ""}</div></button>`; }).join("")}</div>`,
  (body) => {
    body.querySelector(".actions").addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a; if (!a) return;
      if (a === "buy" || a === "sell") openTxnForm({ holding: h, type: a === "sell" ? "SELL" : "BUY" });
      else if (a === "edit") openEditInstrument(h);
      else if (a === "acct") {
        const acc = prompt(`Move all of "${h.name}" to which account?`, h.accounts[0] || "Main");
        if (acc) { await data.setInstrumentAccount(h.id, acc); toast("Moved"); closeSheet(); render(); }
      } else if (a === "alert") { S.tab = "more"; closeSheet(); setTimeout(() => { selectTab("more"); openAlerts(h.id); }, 300); }
      else if (a === "del") {
        if (confirm(`Delete "${h.name}" and all ${h.transactions.length} of its transactions? (A backup is kept.)`)) {
          await data.backupNow("manual"); await data.deleteInstrument(h.id); toast("Deleted"); closeSheet(); render();
        }
      }
    });
    body.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => openTxnForm({ holding: h, txn: h.transactions.find((t) => t.id === +b.dataset.t) })));
  });
}
function selectTab(t) { S.tab = t; $$("#nav button").forEach((x) => x.classList.toggle("on", x.dataset.tab === t)); render(); }

// ---------------------------------------------------------------- Add / edit transaction
function openTxnForm({ holding = null, txn = null, type = "BUY" }) {
  let inst = holding ? { id: holding.id, name: holding.name, kind: holding.kind, symbol: holding.symbol } : null;
  const accts = S.p?.accounts || [];
  const sheet = openSheet(txn ? "Edit transaction" : type === "SELL" ? "Sell / redeem" : holding ? "Buy more" : "Add transaction", `
    <div id="pick" class="${inst ? "hidden" : ""}">
      <input id="isq" type="search" placeholder="Search fund or stock (e.g. Parag Parikh, Polycab)" autocomplete="off">
      <div class="chips small" id="isk"><button class="on" data-k="">Both</button><button data-k="mf">Funds</button><button data-k="stock">Stocks</button></div>
      <div class="list" id="ires"></div>
    </div>
    <div id="chosen" class="chosen ${inst ? "" : "hidden"}"></div>
    <form id="tf" class="form">
      <label>Type<select id="tType"><option>BUY</option><option>SELL</option></select></label>
      <label>Date<input id="tDate" type="date" required></label>
      <label>Units<input id="tUnits" type="number" step="any" min="0" inputmode="decimal" required></label>
      <label>Price / NAV<span class="inline"><input id="tPrice" type="number" step="any" min="0" inputmode="decimal" required><button type="button" class="btn" id="tFetch">Fetch</button></span></label>
      <label>Amount<input id="tAmt" type="number" step="any" min="0" inputmode="decimal"></label>
      <label>Account<input id="tAcct" list="acctList" placeholder="Main"><datalist id="acctList">${accts.map((a) => `<option value="${esc(a)}">`).join("")}</datalist></label>
      <label class="full">Note<input id="tNote" placeholder="optional"></label>
      <p id="tMsg" class="msg full"></p>
      <div class="full row">${txn ? `<button type="button" class="btn danger" id="tDel">Delete</button>` : ""}<button class="btn primary grow" id="tSave">Save</button></div>
    </form>`, (b) => {
    const msg = (t, err) => { const m = b.querySelector("#tMsg"); m.textContent = t; m.className = "msg full " + (err ? "err" : "ok"); };
    b.querySelector("#tType").value = txn ? txn.type : type;
    b.querySelector("#tDate").value = txn ? txn.date : todayIST();
    b.querySelector("#tUnits").value = txn ? txn.units : "";
    b.querySelector("#tPrice").value = txn ? txn.price : holding?.price ?? "";
    b.querySelector("#tAcct").value = txn ? txn.account : holding ? holding.accounts[0] : accts[0] || "Main";
    b.querySelector("#tNote").value = txn?.note || "";
    const sync = () => { const u = +b.querySelector("#tUnits").value, p = +b.querySelector("#tPrice").value; b.querySelector("#tAmt").value = u && p ? (u * p).toFixed(2) : ""; };
    sync();
    b.querySelector("#tUnits").addEventListener("input", sync); b.querySelector("#tPrice").addEventListener("input", sync);
    b.querySelector("#tAmt").addEventListener("input", () => { const a = +b.querySelector("#tAmt").value, p = +b.querySelector("#tPrice").value; if (a && p) b.querySelector("#tUnits").value = +(a / p).toFixed(4); });
    const showChosen = () => {
      b.querySelector("#pick").classList.toggle("hidden", !!inst);
      const c = b.querySelector("#chosen"); c.classList.toggle("hidden", !inst);
      if (inst) {
        c.innerHTML = `<div><span class="tag">${inst.kind === "mf" ? "MF" : "Stock"}</span><b>${esc(inst.name)}</b><div class="sub">${esc(inst.symbol || "")}</div></div>${txn ? "" : `<button type="button" class="btn small" id="chg">Change</button>`}`;
        c.querySelector("#chg")?.addEventListener("click", () => { inst = null; showChosen(); b.querySelector("#isq").focus(); });
      }
    };
    showChosen();
    let kindF = "", results = [];
    const search = () => {
      const q = b.querySelector("#isq").value.trim();
      if (q.length < 2) { b.querySelector("#ires").innerHTML = ""; return; }
      const mine = (S.p?.holdings || []).filter((h) => h.name.toLowerCase().includes(q.toLowerCase()) && (!kindF || h.kind === kindF)).slice(0, 5)
        .map((h) => ({ existing: true, id: h.id, kind: h.kind, symbol: h.symbol, name: h.name, price: h.price, exchange: "your holding" }));
      const have = new Set(mine.map((m) => m.symbol));
      results = mine.concat([...(kindF !== "stock" ? mk.searchFunds(q, 25) : []), ...(kindF !== "mf" ? mk.searchStocks(q, 20) : [])].filter((r) => !have.has(r.symbol)));
      draw();
      // Fund list not downloaded (connection problem)? Search funds online instead.
      if (kindF !== "stock" && !mk.hasFundList() && mk.NATIVE) {
        const myQ = q;
        mk.searchFundsOnline(q).then((online) => {
          if (b.querySelector("#isq").value.trim() !== myQ) return;
          const seen = new Set(results.map((r) => r.symbol));
          results = results.concat(online.filter((r) => !seen.has(r.symbol)));
          draw();
        }).catch(() => {});
      }
    };
    const draw = () => {
      b.querySelector("#ires").innerHTML = results.map((r, i) => `<button type="button" class="item" data-i="${i}"><div class="l"><div class="nm"><span class="tag">${r.kind === "mf" ? "MF" : "Stock"}</span>${esc(r.name)}</div>
        <div class="sub">${esc(r.symbol)} · ${esc(r.exchange || "")}</div></div><div class="r"><div class="v">${r.price != null ? nf2.format(r.price) : ""}</div></div></button>`).join("") || `<div class="muted small pad">${mk.hasFundList() ? "Nothing found." : "Searching…"}</div>`;
    };
    b.querySelector("#isq").addEventListener("input", search);
    b.querySelector("#isk").addEventListener("click", (e) => { const x = e.target.closest("button"); if (!x) return; kindF = x.dataset.k; $$("button", x.parentNode).forEach((y) => y.classList.toggle("on", y === x)); search(); });
    b.querySelector("#ires").addEventListener("click", (e) => {
      const it = e.target.closest("[data-i]"); if (!it) return;
      const r = results[+it.dataset.i];
      const ex = (S.p?.holdings || []).find((h) => h.symbol && h.symbol === r.symbol);
      inst = r.existing ? { id: r.id, name: r.name, kind: r.kind, symbol: r.symbol } : ex ? { id: ex.id, name: ex.name, kind: ex.kind, symbol: ex.symbol }
        : { name: r.kind === "stock" ? `${r.name.toUpperCase()} - ${r.symbol}` : r.name, kind: r.kind, symbol: r.symbol, price: r.price };
      if (!b.querySelector("#tPrice").value && r.price != null) { b.querySelector("#tPrice").value = r.price; sync(); }
      if (mk.NATIVE && r.kind === "stock" && b.querySelector("#tDate").value === todayIST()) {
        mk.quoteNow(r.symbol).then((q) => { if (q?.close != null) { b.querySelector("#tPrice").value = q.close; sync(); msg(`Latest price: ${nf2.format(q.close)}`); } }).catch(() => {});
      }
      showChosen();
      if (b.querySelector("#tDate").value !== todayIST()) fetchPrice();
    });
    const fetchPrice = async () => {
      if (!inst?.symbol) { msg("Pick a fund or stock first", true); return; }
      const d = b.querySelector("#tDate").value; msg("Looking up…");
      try {
        let r;
        if (inst.kind === "mf") { const p = mk.navOn(await mk.mfHistory(inst.symbol), d); r = p && { date: p[0], price: p[1], exact: true }; }
        else r = await mk.stockPriceOn(inst.symbol, d);
        if (!r) throw new Error("No price found for that date");
        b.querySelector("#tPrice").value = +r.price.toFixed(4); sync();
        msg(r.exact ? `${inst.kind === "mf" ? "NAV" : "Close"} on ${fmtDate(r.date)}: ${nf2.format(r.price)}` : `Month-end close for ${monLabel(r.date)}: ${nf2.format(r.price)} (approximate, enter your actual price if you know it)`);
      } catch (e) { msg(e.message, true); }
    };
    b.querySelector("#tFetch").addEventListener("click", fetchPrice);
    b.querySelector("#tDel")?.addEventListener("click", async () => {
      if (!confirm("Delete this transaction?")) return;
      await data.deleteTransaction(txn.id); toast("Deleted"); history.go(-sheets.length); setTimeout(render, 300);
    });
    b.querySelector("#tf").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!inst) { msg("Pick a fund or stock first", true); return; }
      const body = { type: b.querySelector("#tType").value, date: b.querySelector("#tDate").value, units: +b.querySelector("#tUnits").value,
        price: +b.querySelector("#tPrice").value, account: b.querySelector("#tAcct").value, note: b.querySelector("#tNote").value.trim() };
      try {
        if (txn) await data.updateTransaction(txn.id, body);
        else await data.addTransaction(inst.id ? { ...body, instrument_id: inst.id } : { ...body, instrument: inst });
        toast("Saved");
        history.go(-sheets.length);
        if (mk.NATIVE && !inst.id && inst.kind === "stock") { await mk.invalidateQuotes(); setTimeout(() => refresh({ quiet: true }), 300); }
        else setTimeout(render, 300);
      } catch (err) { msg(err.message, true); }
    });
    if (!inst) setTimeout(() => b.querySelector("#isq").focus(), 300);
  });
  return sheet;
}

// ---------------------------------------------------------------- Edit holding / price source
function openEditInstrument(h) {
  openSheet("Edit holding", `
    <form class="form" id="ef">
      <label class="full">Display name<input id="eName" value="${esc(h.name)}" required></label>
      <label>Type<select id="eKind"><option value="mf">Mutual fund</option><option value="stock">Stock / ETF</option></select></label>
      <label>Price source<input id="eSym" value="${esc(h.symbol || "")}" placeholder="AMFI code or SYMBOL.NS"></label>
      <p class="muted small full" id="eSrc">${h.source_name ? "Now priced from: " + esc(h.source_name) : ""}</p>
      <label class="full">Find the right scheme / ticker<input id="eQ" type="search" value="${esc(h.kind === "mf" ? h.name.split(" - ")[0] : h.name.replace(/ - [A-Z0-9&.-]+$/, ""))}"></label>
      <div class="list full" id="eRes"></div>
      <p class="msg full" id="eMsg"></p>
      <button class="btn primary full">Save</button>
    </form>`, (b) => {
    b.querySelector("#eKind").value = h.kind;
    let res = [];
    const search = () => {
      const q = b.querySelector("#eQ").value.trim(), k = b.querySelector("#eKind").value;
      res = k === "mf" ? mk.searchFunds(q, 30) : mk.searchStocks(q, 20);
      if (k === "mf" && h.price) res.sort((a, c) => Math.abs(a.price - h.price) - Math.abs(c.price - h.price));
      b.querySelector("#eRes").innerHTML = res.map((r, i) => `<button type="button" class="item" data-i="${i}"><div class="l"><div class="nm">${esc(r.name)}</div><div class="sub">${esc(r.symbol)} · ${esc(r.exchange)}</div></div><div class="r"><div class="v">${r.price != null ? nf2.format(r.price) : ""}</div></div></button>`).join("");
    };
    search();
    b.querySelector("#eQ").addEventListener("input", search);
    b.querySelector("#eKind").addEventListener("change", search);
    b.querySelector("#eRes").addEventListener("click", (e) => {
      const it = e.target.closest("[data-i]"); if (!it) return;
      const r = res[+it.dataset.i];
      b.querySelector("#eSym").value = r.symbol; b.querySelector("#eSrc").textContent = "Will price from: " + r.name;
      $$(".item", b.querySelector("#eRes")).forEach((x) => x.classList.toggle("on", x === it));
    });
    b.querySelector("#ef").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await data.updateInstrument(h.id, { name: b.querySelector("#eName").value, kind: b.querySelector("#eKind").value, symbol: b.querySelector("#eSym").value });
        toast("Saved"); history.go(-sheets.length); setTimeout(render, 300);
      } catch (err) { const m = b.querySelector("#eMsg"); m.textContent = err.message; m.className = "msg full err"; }
    });
  });
}

// ---------------------------------------------------------------- Growth
async function renderGrowth() {
  await loadPortfolio();
  loading("Building your history from daily NAVs and prices… (first time can take ~20 seconds)");
  const d = await feat.growth(S.account, S.kind);
  if (S.tab !== "growth") return;
  if (!d.dates.length) { view.innerHTML = filtersHtml(false) + `<div class="card muted">No transactions for this filter.</div>`; bindFilters(renderGrowth); return; }
  const ranges = { "6M": 26, "1Y": 52, "3Y": 156, "5Y": 260, All: Infinity };
  const draw = () => {
    const take = Math.min(d.dates.length, (ranges[S.range] || Infinity) + 1), s0 = d.dates.length - take;
    const dates = d.dates.slice(s0), value = d.value.slice(s0), inv = d.invested.slice(s0);
    const v0 = value[0], v1 = value[value.length - 1], added = inv[inv.length - 1] - inv[0], market = v1 - v0 - added;
    const peak = Math.max(...value);
    view.innerHTML = filtersHtml(false) + `
      <div class="card">
        <div class="cardhead"><h3>Value vs invested</h3><div class="chips small" id="rng">${Object.keys(ranges).map((k) => `<button class="${k === S.range ? "on" : ""}" data-r="${k}">${k}</button>`).join("")}</div></div>
        <div class="legend"><span><i style="background:var(--s1)"></i>Current value</span><span><i style="background:var(--s2)"></i>Amount invested</span></div>
        <div class="chart" id="gc"></div>
        <p class="muted small">Weekly, from each fund's daily NAV${d.approxStocks ? " (some stocks without history use their purchase price)" : " and each stock's month-end close"}. Touch and drag to see values.</p>
      </div>
      <div class="tiles">
        <div class="tile"><div class="k">${fmtDate(dates[0])} → now</div><div class="v">${inrShort(v0)} → ${inrShort(v1)}</div></div>
        <div class="tile"><div class="k">New money added</div><div class="v">${inrShort(added)}</div></div>
        <div class="tile"><div class="k">Growth from the market</div><div class="v ${cls(market)}">${market < 0 ? "−" : "+"}${inrShort(Math.abs(market))}</div></div>
        <div class="tile"><div class="k">Highest value</div><div class="v">${inrShort(peak)}</div><div class="s muted">${fmtDate(dates[value.indexOf(peak)])}</div></div>
      </div>`;
    bindFilters(renderGrowth);
    lineChart($("#gc"), { dates, series: [{ values: value, color: "var(--s1)", area: true }, { values: inv, color: "var(--s2)" }],
      tooltip: (i) => `<div class="tt">${fmtDate(dates[i])}</div>${tipRow("var(--s1)", "Value", inr(value[i]))}${tipRow("var(--s2)", "Invested", inr(inv[i]))}${tipRow("", "Gain", signed(value[i] - inv[i]))}` });
    $("#rng").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.range = b.dataset.r; draw(); } });
  };
  draw();
}

// ---------------------------------------------------------------- Insights: Monthly / Exposure / Ratings
async function renderInsights() {
  await loadPortfolio();
  view.innerHTML = `<div class="seg" id="seg">${[["monthly", "Monthly"], ["exposure", "Exposure"], ["ratings", "Fund rating"]].map(([k, l]) => `<button class="${S.seg === k ? "on" : ""}" data-s="${k}">${l}</button>`).join("")}</div><div id="ins"></div>`;
  $("#seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.seg = b.dataset.s; renderInsights(); } });
  const el = $("#ins");
  if (S.seg === "monthly") await renderMonthly(el);
  else if (S.seg === "exposure") await renderExposure(el);
  else await renderRatings(el);
}

async function renderMonthly(el) {
  const d = await feat.monthlyActivity(S.account, S.kind);
  if (!d.months.length) { el.innerHTML = filtersHtml(false) + `<div class="card muted">No transactions.</div>`; bindFilters(renderInsights); return; }
  const draw = () => {
    const months = d.months.slice(-S.monthsRange), last12 = d.months.slice(-12), sum12 = last12.reduce((a, m) => a + m.bought, 0);
    const yrs = [...new Set(d.months.map((m) => m.month.slice(0, 4)))].reverse(), byKey = Object.fromEntries(d.months.map((m) => [m.month, m]));
    const nz = d.months.map((m) => m.bought).filter((v) => v > 0).sort((a, b) => a - b), q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] || 0;
    const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)], shade = (v) => (v <= 0 ? "" : `background:var(--q${1 + cuts.filter((c) => v > c).length})`);
    el.innerHTML = filtersHtml(false) + `
      <div class="tiles">
        <div class="tile"><div class="k">Last 12 months</div><div class="v">${inrShort(sum12)}</div><div class="s muted">avg ${inrShort(sum12 / 12)}/month</div></div>
        <div class="tile"><div class="k">Months invested</div><div class="v">${last12.filter((m) => m.bought > 0).length} of 12</div></div>
      </div>
      <div class="card"><div class="cardhead"><h3>Money in & out</h3><div class="chips small" id="mr">${[[12, "1Y"], [36, "3Y"], [9999, "All"]].map(([v, l]) => `<button class="${v === S.monthsRange ? "on" : ""}" data-r="${v}">${l}</button>`).join("")}</div></div>
        <div class="legend"><span><i style="background:var(--s1)"></i>Invested</span><span><i style="background:var(--s2)"></i>Redeemed</span></div><div class="chart" id="mc"></div></div>
      <div class="card"><h3>Calendar</h3><p class="muted small">Brighter = more invested. Tap a month.</p>
        <div class="scrollx"><table class="heat"><tr><th></th>${MON.map((m) => `<th>${m[0]}</th>`).join("")}</tr>
        ${yrs.map((y) => `<tr><td class="yr">${y}</td>${MON.map((_, i) => { const k = `${y}-${String(i + 1).padStart(2, "0")}`, m = byKey[k]; return `<td class="c" data-m="${k}" style="${m ? shade(m.bought) : "opacity:.3"}"></td>`; }).join("")}</tr>`).join("")}</table></div></div>
      <div class="card"><h3>Regular investments</h3><p class="muted small">Bought in 3+ of the last 6 months. Outlined = skipped month.</p>
        ${d.regular.length ? d.regular.map((r) => { const first = r.months.findIndex((v) => v > 0); return `<div class="regrow"><div class="nm">${esc(r.name)}</div>
          <div class="sub">${inr(r.typical)} · around day ${r.day}${r.missed ? ` · ${r.missed} skipped` : ""}</div>
          <div class="dots">${r.months.map((v, i) => `<span class="${v > 0 ? "on" : i > first && i < 11 ? "miss" : ""}"></span>`).join("")}</div></div>`; }).join("") : `<p class="muted">None found.</p>`}</div>
      <div class="card"><h3>By year</h3>${[...d.years].reverse().map((y) => `<div class="kv"><span>${y.year}</span><b>${inr(y.bought)}</b>${y.sold ? `<span class="muted small">redeemed ${inr(y.sold)}</span>` : ""}</div>`).join("")}</div>`;
    bindFilters(renderInsights);
    barChart($("#mc"), { labels: months.map((m) => m.month), up: months.map((m) => m.bought), down: months.map((m) => m.sold),
      tooltip: (i) => `<div class="tt">${monLabel(months[i].month)}</div>${tipRow("var(--s1)", "Invested", inr(months[i].bought))}${months[i].sold ? tipRow("var(--s2)", "Redeemed", inr(months[i].sold)) : ""}` });
    $("#mr").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.monthsRange = +b.dataset.r; draw(); } });
    el.querySelectorAll(".heat td.c").forEach((c) => c.addEventListener("click", (ev) => {
      const m = byKey[c.dataset.m]; if (!m) return;
      const r = c.getBoundingClientRect();
      showTip(`<div class="tt">${monLabel(m.month)}</div>${tipRow("var(--s1)", "Invested", inr(m.bought))}${m.sold ? tipRow("var(--s2)", "Redeemed", inr(m.sold)) : ""}`, r.left + r.width / 2, r.top);
      setTimeout(hideTip, 2200);
    }));
  };
  draw();
}

async function renderExposure(el) {
  const p = await data.getPortfolio({ account: S.account });
  const d = feat.exposure(p);
  if (!d.holdings.length) { el.innerHTML = `<div class="card muted">No holdings.</div>`; return; }
  el.innerHTML = filtersHtml(false).replace(/<div class="chips" id="kindChips">[\s\S]*?<\/div>/, "") + `
    ${d.flags.length ? `<div class="card"><h3>Worth knowing</h3><p class="muted small">Facts, not advice.</p><ul class="flags">${d.flags.map((f) => `<li class="${f.level}"><span class="ic">${f.level === "low" ? "i" : "!"}</span><span>${esc(f.text)}</span></li>`).join("")}</ul></div>` : ""}
    <div class="card"><h3>Market-cap mix</h3>
      <div class="stack">${d.caps.map((c) => `<span style="width:${(c.pct * 100).toFixed(2)}%;background:${CAP_COLORS[c.name]}"></span>`).join("")}</div>
      ${d.caps.map((c) => `<div class="kv"><span><i class="sw" style="background:${CAP_COLORS[c.name]}"></i>${c.name}<br><span class="muted small">${inrShort(c.value)}${c.mf && c.stock ? ` · funds ${inrShort(c.mf)}, stocks ${inrShort(c.stock)}` : ""}</span></span><b>${(c.pct * 100).toFixed(1)}%</b></div>`).join("")}
      <p class="muted small">Funds by SEBI category (multi-cap = ⅓ each, large &amp; mid = ½ each, flexi/ELSS/thematic = Flexible). Stocks by Nifty 100 / Midcap 150 / Smallcap 250 / Microcap 250 membership; others = “Other listed”.</p></div>
    <div class="card"><h3>By category</h3>${hbars(d.categories)}</div>
    <div class="card"><h3>Fund houses</h3>${hbars(d.amcs)}</div>
    ${d.sectors.length ? `<div class="card"><h3>Direct stocks by industry</h3>${hbars(d.sectors)}</div>` : ""}
    <div class="card"><h3>Biggest holdings</h3><p class="muted small">Top 10 = ${(d.top10 * 100).toFixed(1)}% of the portfolio.</p>${hbars(d.holdings.slice(0, 10))}</div>`;
  $("#acctSel")?.addEventListener("change", (e) => { S.account = e.target.value; renderInsights(); });
}

const METRICS = [["r5y", "5Y p.a."], ["r1y", "1Y"], ["r6m", "6M"], ["r3y", "3Y p.a."], ["excess", "vs benchmark"]];
async function renderRatings(el) {
  el.innerHTML = `<div class="card muted">Fetching NAV history for your funds and benchmarks…</div>`;
  const pAll = await data.getPortfolio({});
  const r = await feat.ratings(pAll);
  if (S.tab !== "insights" || S.seg !== "ratings") return;
  if (!r.funds.length) { el.innerHTML = `<div class="card muted">No mutual funds to rate.</div>`; return; }
  const draw = () => {
    const rows = r.funds.map((f) => {
      const b = r.benchmarks[f.benchmark] || {};
      let excess = null, per = null;
      if (f.r3y != null && b.r3y != null) { excess = f.r3y - b.r3y; per = "3Y"; } else if (f.r1y != null && b.r1y != null) { excess = f.r1y - b.r1y; per = "1Y"; }
      return { ...f, excess, per, pts: {}, rank: {}, of: {} };
    });
    for (const [k] of METRICS) {
      const have = rows.filter((x) => x[k] != null).sort((a, b) => a[k] - b[k]), m = have.length;
      for (let i = 0; i < m;) { let j = i; while (j + 1 < m && have[j + 1][k] === have[i][k]) j++; for (let x = i; x <= j; x++) { have[x].pts[k] = (i + j + 2) / 2; have[x].rank[k] = m - j; have[x].of[k] = m; } i = j + 1; }
      rows.filter((x) => x[k] == null).forEach((x) => (x.pts[k] = S.missing === "zero" ? 0 : (m + 1) / 2));
    }
    const max = METRICS.reduce((a, [k]) => a + S.weights[k] * rows.length, 0) || 1;
    rows.forEach((x) => { x.score = METRICS.reduce((a, [k]) => a + S.weights[k] * x.pts[k], 0); x.sp = x.score / max; });
    rows.sort((a, b) => b.score - a.score || (b.r5y ?? -9) - (a.r5y ?? -9));
    el.innerHTML = `<div class="card"><h3>Your weights</h3>
      <div class="weights">${METRICS.map(([k, l]) => `<label>${l}<input type="number" min="0" step="1" inputmode="numeric" data-w="${k}" value="${S.weights[k]}"></label>`).join("")}</div>
      <label class="inl">Too young for a measure: <select id="miss"><option value="zero" ${S.missing === "zero" ? "selected" : ""}>0 points</option><option value="mid" ${S.missing === "mid" ? "selected" : ""}>middle points</option></select></label>
      <p class="muted small">Worst fund gets 1 point per measure, best gets as many points as there are funds. Score = Σ weight × points. “vs benchmark” = 3Y return minus the index (1Y if younger).</p></div>
      ${rows.map((x, i) => `<div class="card rate ${i < 3 ? "top" : ""}">
        <div class="rhead"><span class="medal">${["🥇", "🥈", "🥉"][i] || i + 1}</span><div class="grow"><div class="nm">${esc(x.name)}</div><div class="sub">${esc((x.category || "").replace(/^Equity Schemes? - /, ""))}</div></div>
          <div class="score">${x.score.toFixed(0)}<div class="sub">${(x.sp * 100).toFixed(0)}%</div></div></div>
        <div class="scorebar"><span style="width:${(x.sp * 100).toFixed(1)}%"></span></div>
        <div class="metrics">${METRICS.map(([k, l]) => `<div><div class="k">${l}</div><div class="${cls(x[k])}">${x[k] == null ? "—" : pct(x[k])}</div><div class="sub">${x[k] == null ? "no history" : `#${x.rank[k]}/${x.of[k]}`}</div></div>`).join("")}</div>
        <label class="inl small">Benchmark <select data-b="${x.id}">${Object.values(r.benchmarks).map((b) => `<option value="${b.key}" ${b.key === x.benchmark ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>
      </div>`).join("")}
      <div class="card"><h3>Benchmarks</h3>${Object.values(r.benchmarks).map((b) => `<div class="kv"><span>${esc(b.name)}</span><span class="small">5Y ${pct(b.r5y)} · 1Y ${pct(b.r1y)} · 6M ${pct(b.r6m)} · 3Y ${pct(b.r3y)}</span></div>`).join("")}
      <p class="muted small">Tracked through Direct-Growth index funds/ETFs (dividends included). Returns as of ${fmtDate(r.funds[0].as_of)}.</p></div>`;
    el.querySelectorAll("[data-w]").forEach((inp) => inp.addEventListener("change", () => { S.weights[inp.dataset.w] = Math.max(0, +inp.value || 0); try { localStorage.setItem("weights", JSON.stringify(S.weights)); } catch (e) { /* */ } draw(); }));
    $("#miss").addEventListener("change", (e) => { S.missing = e.target.value; draw(); });
    el.querySelectorAll("[data-b]").forEach((s) => s.addEventListener("change", async () => { const f = r.funds.find((x) => x.id === +s.dataset.b); f.benchmark = s.value; await feat.setBenchmark(f.id, s.value); draw(); }));
  };
  draw();
}

// ---------------------------------------------------------------- Tax
async function renderTax() {
  loading("Working out your long-term gains…");
  const t = await feat.tax();
  if (S.tab !== "tax") return;
  view.innerHTML = `
    <div class="card"><p class="lead"><b>${inr(t.remaining)}</b> of your ₹1,25,000 tax-free long-term gain limit is unused in ${t.fy} <span class="muted">(${t.daysLeft} days left)</span>.</p>
      <div class="tiles">
        <div class="tile"><div class="k">LT gains booked</div><div class="v">${inr(t.realised.ltGain)}</div></div>
        <div class="tile"><div class="k">LT losses booked</div><div class="v">${inr(t.realised.ltLoss)}</div></div>
        <div class="tile"><div class="k">ST gains (net)</div><div class="v ${cls(t.realised.stNet)}">${signed(t.realised.stNet)}</div></div>
        <div class="tile"><div class="k">LT gains available</div><div class="v">${inrShort(t.unrealisedLT)}</div></div>
      </div></div>
    <div class="card"><h3>Suggested harvest</h3>
      ${t.plan.length ? `<p class="small">Sell these and buy the same back straight away: you book ${inr(t.planGain)} of gains tax-free, and pay about <b>${inr(t.taxSaved)}</b> less tax when you eventually sell.</p>
        ${t.plan.map((p) => `<div class="plan"><div class="nm">${esc(p.name)}</div><div class="kv"><span>Sell ${p.kind === "mf" ? p.units.toFixed(3) : nf0.format(p.units)} units (oldest first)</span><b>≈ ${inr(p.value)}</b></div>
          <div class="kv"><span>Gain booked tax-free</span><b class="up">${signed(p.gain)}</b></div><div class="kv"><span>Then buy back</span><b>≈ ${inr(p.value)}</b></div></div>`).join("")}
        <ul class="small muted notes"><li>Funds: the sale and the buy-back each get that day's NAV. Check for exit loads.</li><li>Stocks: brokerage + STT apply (~0.1% each way).</li>
          <li>Buying back starts a new 12-month clock. Amounts are estimates at the latest price.</li><li>A planning aid, not tax advice.</li></ul>`
      : `<p class="muted">${t.remaining <= 0 ? "This year's ₹1.25 lakh limit is already used." : "No holding has long-term gains you can sell right now."}</p>`}</div>
    <div class="card"><h3>Long-term gain available, by holding</h3>
      ${t.cands.map((c) => `<div class="kv2"><div class="nm">${esc(c.name)}${c.elss ? ' <span class="tag">ELSS</span>' : ""}</div>
        <div class="kv"><span>Long-term</span><b class="${cls(c.lt_gain)}">${c.lt_units ? signed(c.lt_gain) : "—"}</b></div>
        <div class="kv"><span>Short-term</span><b class="${cls(c.st_gain)}">${c.st_gain ? signed(c.st_gain) : "—"}</b></div>
        ${c.blocked ? `<div class="sub">${esc(c.blocked)}</div>` : ""}</div>`).join("")}</div>
    ${t.realisedRows.length ? `<div class="card"><h3>Sales this FY</h3>${t.realisedRows.map((x) => `<div class="kv"><span>${esc(x.name)}<br><span class="muted small">${fmtDate(x.date)} · ${x.term}</span></span><b class="${cls(x.gain)}">${signed(x.gain)}</b></div>`).join("")}</div>` : ""}
    <p class="muted small pad">Rules: long term = held more than 12 months; ₹1.25 lakh of LTCG per April–March is tax-free, the rest 12.5%; FIFO; ELSS 3-year lock-in; pre-Feb-2018 units use the 31-Jan-2018 price.</p>`;
}

// ---------------------------------------------------------------- More: alerts, data, backups, settings
async function renderMore() {
  const meta = mk.marketMeta();
  const n = await alerts.unreadCount();
  const LN = mk.NATIVE ? window.Capacitor.Plugins.LocalNotifications : null;
  const perm = LN ? ((await LN.checkPermissions().catch(() => ({}))).display === "granted" ? "granted" : "default")
    : "Notification" in window ? Notification.permission : "unsupported";
  view.innerHTML = `
    <div class="card menu">
      <button data-m="alerts"><span>🔔 Alerts${n ? ` <span class="badge">${n}</span>` : ""}</span><span>›</span></button>
      <button data-m="backups"><span>🗄️ Backups</span><span>›</span></button>
    </div>
    <div class="card"><h3>Your data</h3>
      <p class="muted small">Your portfolio is stored only on this phone. Save a backup file now and then (to Files, Google Drive or OneDrive) in case the phone is lost or reset.</p>
      <button class="btn block" id="mImport">Import Excel…</button>
      <button class="btn block" id="mExport">Export Excel (same layout as your sheet)</button>
      <button class="btn block" id="mSave">Save backup file</button>
      <button class="btn block" id="mRestore">Restore from backup file…</button>
    </div>
    <div class="card"><h3>Settings</h3>
      <div class="kv"><span>Theme</span><button class="btn small" id="mTheme">${document.documentElement.dataset.theme === "light" ? "Switch to black" : "Switch to light"}</button></div>
      <div class="kv"><span>Phone notifications</span>${perm === "granted" ? "<b class='up'>On</b>" : perm === "unsupported" ? "<span class='muted small'>Add the app to your Home Screen first</span>" : `<button class="btn small" id="mNotif">Turn on</button>`}</div>
    </div>
    <div class="card"><h3>Market data</h3>
      <div class="kv"><span>Stock closing prices</span><b>${fmtDate(meta?.trade_dates?.NSE)}</b></div>
      <div class="kv"><span>Fund NAVs</span><b>${fmtDate(meta?.nav_date)}</b></div>
      <div class="kv"><span>Last updated</span><b>${esc(meta?.built || "—")}</b></div>
      <p class="muted small">${mk.NATIVE
        ? "Stock prices come live from Yahoo Finance (refreshed every minute while NSE/BSE is open and the app is on screen). Fund NAVs come from AMFI and update in the evening. Tap ↻ any time."
        : "Prices are published once a day after market close (about 7:30 pm) and fund NAVs late evening. Tap ↻ to fetch the latest."}</p>
      ${Object.keys(mk.lastErrors()).length ? `<div class="banner">Last download problem: ${esc(Object.values(mk.lastErrors()).join(" · "))}</div>` : ""}
      <button class="btn block" id="mForce">Re-download all market data</button>
      ${mk.NATIVE ? `<button class="btn block" id="mDiag">Test connection to price sources</button><div id="diagOut"></div>` : ""}
    </div>
    ${mk.NATIVE ? "" : `<div class="card"><h3>Install on your phone</h3><p class="small"><b>iPhone:</b> open this page in Safari → Share → “Add to Home Screen”.<br><b>Android:</b> Chrome menu ⋮ → “Install app” / “Add to Home screen”.</p></div>`}`;
  view.querySelector(".menu").addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (!b) return; b.dataset.m === "alerts" ? openAlerts() : openBackups(); });
  $("#mImport").onclick = importExcel;
  $("#mExport").onclick = exportExcel;
  $("#mSave").onclick = async () => { const s = await data.snapshot(); await saveFile(new Blob([JSON.stringify(s)], { type: "application/json" }), `portfolio-backup-${todayIST()}.json`); await db.kvSet("last_file_backup", todayIST()); };
  $("#mRestore").onclick = async () => {
    const f = await pickFile(".json,application/json"); if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!confirm(`Replace everything on this phone with this backup (${d.txns?.length ?? "?"} transactions, saved ${d.saved || "?"})?`)) return; await data.restoreData(d); toast("Restored"); render(); }
    catch (e) { toast(e.message, 4000); }
  };
  $("#mTheme").onclick = () => { const light = document.documentElement.dataset.theme !== "light"; if (light) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme; try { localStorage.setItem("theme", light ? "light" : "dark"); } catch (e) { /* */ } renderMore(); };
  $("#mNotif")?.addEventListener("click", async () => {
    const ok = LN ? (await LN.requestPermissions()).display === "granted" : (await Notification.requestPermission()) === "granted";
    toast(ok ? "Notifications on" : "Notifications not allowed"); renderMore();
  });
  $("#mForce").onclick = () => refresh({ force: true });
  $("#mDiag")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Testing… (up to a minute)";
    const res = await mk.diagnose();
    $("#diagOut").innerHTML = res.map((r) => `<div class="kv"><span>${r.ok ? "✅" : "❌"} ${esc(r.name)}</span><span class="small ${r.ok ? "muted" : "down"}">${esc(r.detail)}</span></div>`).join("") +
      `<p class="muted small">If something shows ❌, take a screenshot of this list. A work profile, VPN, or Wi-Fi filter on the phone can block some sites.</p>`;
    e.target.disabled = false; e.target.textContent = "Test connection to price sources";
  });
}

/** Shared by Excel import and Wi-Fi import: overwrite/append choice, import, prices, summary */
async function applyImport(rows, sourceLabel) {
  // Import doesn't need the internet: if prices can't be downloaded right now, funds are
  // linked to their schemes automatically the next time they are.
  let marketOk = true;
  try { await mk.ensureMarket(); } catch (e) { marketOk = false; }
  const have = (await db.all("txns")).length;
  let replace = true;
  if (have) {
    replace = confirm(`Import ${rows.length} rows from ${sourceLabel}.\n\nOK = Overwrite (replace the ${have} transactions on this phone; a backup is saved first)\nCancel = choose Append instead`);
    if (!replace && !confirm("Append the new rows to what's already here? (Exact duplicates are skipped.)")) return;
  }
  toast("Importing and matching funds…", 6000);
  const r = await data.importRows(rows, replace);
  if (mk.NATIVE) { await mk.invalidateQuotes(); try { await mk.ensureMarket(); marketOk = true; } catch (e) { marketOk = false; } }
  await mk.applyPrices();
  updateInfo();
  const review = marketOk && mk.hasFundList() ? r.review.length : 0;
  toast(`${r.mode === "replace" ? "Loaded" : "Added"} ${r.added} transactions (${r.created} holdings)${r.skipped ? `, ${r.skipped} duplicates skipped` : ""}` +
    (marketOk && mk.hasFundList() ? (review ? `. Check ${review} automatically linked holding(s) (marked “check”).` : "") : ". Prices couldn't be downloaded right now; they'll fill in when you tap ↻."), 7000);
  selectTab("home");
}

async function importExcel() {
  const f = await pickFile(".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); if (!f) return;
  try {
    const rows = readWorkbook(await f.arrayBuffer(), "Main");
    await applyImport(rows, `“${f.name}”`);
  } catch (e) {
    // a dialog (not a brief toast) so the details can be read or screenshotted
    alert(`Couldn't import “${f.name}” (${Math.round(f.size / 1024)} KB, ${f.type || "unknown type"}).\n\n${e.message}`);
  }
}

async function exportExcel() {
  try {
    const p = await data.getPortfolio({ includeClosed: true });
    const r = await saveFile(buildWorkbook(p), `myfunds_export_${todayIST().replace(/-/g, "_")}.xlsx`);
    if (r !== "cancelled") toast("Excel ready");
  } catch (e) { toast(e.message, 4000); }
}

async function openAlerts(focusId) {
  const [s, rules, logs, pAll] = await Promise.all([alerts.settings(), db.all("rules"), db.all("log"), data.getPortfolio({})]);
  await alerts.markRead(); updateBadge();
  const byId = new Map(pAll.holdings.map((h) => [h.id, h]));
  const kinds = { above: "goes above", below: "goes below", move: "moves more than (% a day)" };
  openSheet("Alerts", `
    <div class="card"><h3>Settings</h3>
      <label class="inl">Alert when any holding moves more than <input id="aMove" type="number" step="0.5" min="0" inputmode="decimal" value="${s.move_pct}" style="width:70px">% in a day</label>
      <label class="inl"><input type="checkbox" id="aSum" ${s.daily_summary ? "checked" : ""}> Daily summary after market close</label>
      <label class="inl"><input type="checkbox" id="aNot" ${s.notify ? "checked" : ""}> Show as phone notifications too</label>
      <p class="muted small">Phones don't let web apps run in the background, so alerts are checked each time you open the app or tap ↻.</p>
      <div class="row"><button class="btn" id="aTest">Test notification</button><button class="btn" id="aSumNow">Today's summary</button></div></div>
    <div class="card"><h3>Price alerts</h3>
      <form class="form" id="aForm">
        <label class="full">Holding<select id="aInst">${[...pAll.holdings].sort((a, b) => a.name.localeCompare(b.name)).map((h) => `<option value="${h.id}" ${h.id === focusId ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>
        <label>When it<select id="aKind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Value<input id="aVal" type="number" step="any" min="0" inputmode="decimal" required></label>
        <button class="btn primary full">Add alert</button></form>
      <div id="aRules">${rules.map((r) => { const h = byId.get(r.instrument_id); return `<div class="kv"><span>${esc(h?.name || "?")}<br><span class="muted small">${kinds[r.kind]} ${r.kind === "move" ? r.value + "%" : nf2.format(r.value)} · now ${h?.price != null ? nf2.format(h.price) : "—"}</span></span><button class="btn small danger" data-del="${r.id}">Remove</button></div>`; }).join("") || `<p class="muted small">No price alerts yet.</p>`}</div></div>
    <div class="card"><h3>Recent</h3>${logs.sort((a, b) => b.id - a.id).slice(0, 60).map((l) => `<div class="log"><b>${esc(l.title)}</b><div class="small">${esc(l.body || "")}</div><div class="muted small">${esc(l.ts)}</div></div>`).join("") || `<p class="muted small">Nothing yet.</p>`}</div>`,
  (b) => {
    const save = () => alerts.saveSettings({ move_pct: +b.querySelector("#aMove").value || 0, daily_summary: b.querySelector("#aSum").checked, notify: b.querySelector("#aNot").checked });
    ["#aMove", "#aSum", "#aNot"].forEach((x) => b.querySelector(x).addEventListener("change", save));
    b.querySelector("#aTest").onclick = async () => {
      if (mk.NATIVE) await window.Capacitor.Plugins.LocalNotifications.requestPermissions().catch(() => {});
      else if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
      await alerts.notify("test", "Portfolio alerts are working", "Alerts appear here (and as notifications if allowed)."); toast("Sent"); history.back(); setTimeout(() => openAlerts(), 350);
    };
    b.querySelector("#aSumNow").onclick = async () => { await alerts.sendSummary(pAll); toast("Summary added"); history.back(); setTimeout(() => openAlerts(), 350); };
    const ph = () => { const h = byId.get(+b.querySelector("#aInst").value); b.querySelector("#aVal").placeholder = b.querySelector("#aKind").value === "move" ? "e.g. 3" : h?.price != null ? nf2.format(h.price) : ""; };
    b.querySelector("#aInst").onchange = ph; b.querySelector("#aKind").onchange = ph; ph();
    b.querySelector("#aForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const iid = +b.querySelector("#aInst").value;
      try { await alerts.addRule(iid, b.querySelector("#aKind").value, b.querySelector("#aVal").value, byId.get(iid)?.price); toast("Alert added"); history.back(); setTimeout(() => openAlerts(), 350); }
      catch (err) { toast(err.message); }
    });
    b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", async () => { await alerts.deleteRule(+x.dataset.del); history.back(); setTimeout(() => openAlerts(), 350); }));
  });
}

async function openBackups() {
  const list = await data.listBackups();
  const tags = { daily: "Daily", "before-import": "Before import", "before-restore": "Before restore", manual: "Manual" };
  openSheet("Backups", `<div class="card"><p class="small">A copy is saved on this phone every day you open the app (last 30 kept) and before every import or restore.
    For safety off the phone, use More › Save backup file.</p><button class="btn block" id="bNow">Back up now</button></div>
    <div class="card">${list.map((x) => `<div class="kv"><span>${esc(x.ts)}<br><span class="muted small">${tags[x.tag] || x.tag} · ${x.count} transactions</span></span><button class="btn small" data-r="${x.id}">Restore</button></div>`).join("") || `<p class="muted">No backups yet.</p>`}</div>`,
  (b) => {
    b.querySelector("#bNow").onclick = async () => { await data.backupNow("manual"); toast("Backed up"); history.back(); setTimeout(openBackups, 350); };
    b.querySelectorAll("[data-r]").forEach((x) => x.addEventListener("click", async () => {
      if (!confirm("Replace current data with this backup? (Current data is backed up first.)")) return;
      await data.restoreBackup(+x.dataset.r); toast("Restored"); history.back(); setTimeout(render, 300);
    }));
  });
}

// ---------------------------------------------------------------- start
(async function start() {
  if (!mk.NATIVE && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (mk.NATIVE) document.documentElement.classList.add("native");
  db.persist();
  updateInfo();
  await render();  // show saved data immediately
  await data.dailyBackupIfNeeded().catch(() => {});
  refresh({ quiet: true });
  if (mk.NATIVE) {
    // live prices: refresh every minute while NSE/BSE is open and the app is on screen
    setInterval(() => {
      const t = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000), m = t.getHours() * 60 + t.getMinutes();
      const open = t.getDay() > 0 && t.getDay() < 6 && m >= 555 && m <= 935;
      if (open && document.visibilityState === "visible" && !sheets.length) refresh({ quiet: true });
    }, 60000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !sheets.length) refresh({ quiet: true }); });
  }
})();
