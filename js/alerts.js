// Alerts: checked whenever the app opens or refreshes prices (phones don't let web apps run in the background).
import * as db from "./db.js";
import { todayIST, nowStamp, inr, signed, nowIST } from "./util.js";

const DEFAULTS = { move_pct: 5, daily_summary: true, notify: true };
export async function settings() { return { ...DEFAULTS, ...((await db.kvGet("alert_settings")) || {}) }; }
export async function saveSettings(s) { await db.kvSet("alert_settings", { ...(await settings()), ...s }); }

const short = (n) => { n = / - [A-Z0-9&.-]+\.(NS|BO)$/.test(n) ? n.split(" - ")[0] : n; return n.length > 40 ? n.slice(0, 38) + "…" : n; };

export async function notify(kind, title, body) {
  await db.put("log", { ts: nowStamp(), kind, title, body, unread: true });
  const logs = (await db.all("log")).sort((a, b) => b.id - a.id);
  for (const l of logs.slice(300)) await db.del("log", l.id);
  const s = await settings();
  const LN = window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.LocalNotifications;
  if (s.notify && LN) {
    try {
      if ((await LN.checkPermissions()).display === "granted") {
        await LN.schedule({ notifications: [{ id: Math.floor(Date.now() % 2e9), title, body, smallIcon: "ic_stat_notify" }] });
      }
    } catch (e) { /* in-app list still has it */ }
    return;
  }
  if (s.notify && "Notification" in window && Notification.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(title, { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: kind + title });
      else new Notification(title, { body });
    } catch (e) { /* in-app list still has it */ }
  }
}

export async function addRule(instrument_id, kind, value, currentPrice) {
  value = +value;
  if (!(value > 0)) throw new Error("Enter a positive value");
  const rules = await db.all("rules");
  if (kind === "move") for (const r of rules.filter((r) => r.instrument_id === instrument_id && r.kind === "move")) await db.del("rules", r.id);
  const state = kind !== "move" && currentPrice != null ? (currentPrice >= value ? "above" : "below") : null;
  await db.put("rules", { instrument_id, kind, value, last_state: state, created: nowStamp() });
}
export const deleteRule = (id) => db.del("rules", id);

/** Run after prices are applied. p = full portfolio (all accounts) */
export async function check(p) {
  const s = await settings();
  const fired = (await db.kvGet("move_fired")) || {};
  const rules = await db.all("rules");
  const moveThr = new Map(rules.filter((r) => r.kind === "move").map((r) => [r.instrument_id, r.value]));
  const latest = p.holdings.reduce((m, h) => (h.price_date && h.price_date > m ? h.price_date : m), "");
  let n = 0;
  for (const h of p.holdings) {
    if (h.units <= 0 || h.price == null || !h.prev_close || !h.price_date) continue;
    // only alert on today's / the latest session's move, once per holding per price date
    if (h.price_date < latest && h.kind === "stock") continue;
    const thr = moveThr.get(h.id) ?? s.move_pct;
    const pct = ((h.price - h.prev_close) / h.prev_close) * 100;
    const key = `${h.id}`;
    if (thr && Math.abs(pct) >= thr && fired[key] !== h.price_date) {
      await notify("move", `${short(h.name)} ${pct > 0 ? "▲" : "▼"} ${pct > 0 ? "+" : ""}${pct.toFixed(2)}% (${h.price_date})`,
        `${h.kind === "mf" ? "NAV" : "Close"} ${h.price.toFixed(2)} (was ${h.prev_close.toFixed(2)}). Your holding ${signed(h.day_change)} that day, now ${inr(h.value)}.`);
      fired[key] = h.price_date; n++;
    }
  }
  await db.kvSet("move_fired", fired);
  for (const r of rules.filter((r) => r.kind !== "move")) {
    const h = p.holdings.find((x) => x.id === r.instrument_id);
    if (!h || h.price == null) continue;
    const state = h.price >= r.value ? "above" : "below";
    if (r.last_state && state !== r.last_state && state === r.kind) {
      await notify("target", `${short(h.name)} is now ${r.kind} ${r.value.toFixed(2)}`, `Latest ${h.kind === "mf" ? "NAV" : "close"} ${h.price.toFixed(2)} (${h.price_date}). Worth ${inr(h.value)}.`);
      n++;
    }
    if (state !== r.last_state) await db.put("rules", { ...r, last_state: state });
  }
  if (s.daily_summary) await maybeSummary(p);
  return n;
}

/** One summary per new trading day, the first time the app sees that day's closing prices */
async function maybeSummary(p) {
  const stockDate = p.holdings.filter((h) => h.kind === "stock").reduce((m, h) => (h.price_date > m ? h.price_date : m), "");
  const navDate = p.holdings.filter((h) => h.kind === "mf").reduce((m, h) => (h.price_date > m ? h.price_date : m), "");
  const day = stockDate > navDate ? stockDate : navDate;
  if (!day || (await db.kvGet("summary_day")) === day) return;
  if (day === todayIST() && nowIST().getHours() < 16) return;  // wait for the close
  await sendSummary(p, day);
  await db.kvSet("summary_day", day);
}
export async function sendSummary(p, day) {
  const s = p.summary;
  const mv = p.holdings.filter((h) => h.units > 0 && h.day_change_pct != null).sort((a, b) => b.day_change_pct - a.day_change_pct);
  const up = mv.filter((h) => h.day_change_pct > 0).slice(0, 3).map((h) => `${short(h.name)} +${(h.day_change_pct * 100).toFixed(1)}%`).join(", ");
  const dn = mv.filter((h) => h.day_change_pct < 0).slice(-3).reverse().map((h) => `${short(h.name)} ${(h.day_change_pct * 100).toFixed(1)}%`).join(", ");
  const body = [`Value ${inr(s.value)} · total gain ${signed(s.gain)} · XIRR ${((s.xirr || 0) * 100).toFixed(1)}%`, up && "Top: " + up, dn && "Bottom: " + dn].filter(Boolean).join("\n");
  await notify("summary", `Portfolio ${day ? "on " + day : "today"}: ${signed(s.day_change)} (${s.day_change_pct != null ? (s.day_change_pct * 100).toFixed(2) + "%" : "—"})`, body);
}
export async function unreadCount() { return (await db.all("log")).filter((l) => l.unread).length; }
export async function markRead() { for (const l of (await db.all("log")).filter((x) => x.unread)) await db.put("log", { ...l, unread: false }); }
