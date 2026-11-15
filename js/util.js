export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const nf0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const nf2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const nf3 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
export const inr = (v, dp = 0) => (v == null || !isFinite(v) ? "—" : (v < 0 ? "−₹" : "₹") + (dp ? nf2 : nf0).format(Math.abs(v)));
export const signed = (v, dp = 0) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + inr(v, dp));
export const pct = (v, sign = true) => (v == null || !isFinite(v) ? "—" : (sign && v > 0 ? "+" : "") + (v * 100).toFixed(2) + "%");
export const cls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
export const inrShort = (v) => {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e7) return s + "₹" + (a / 1e7).toFixed(2).replace(/\.?0+$/, "") + " Cr";
  if (a >= 1e5) return s + "₹" + (a / 1e5).toFixed(1).replace(/\.0$/, "") + " L";
  if (a >= 1e3) return s + "₹" + Math.round(a / 1e3) + "K";
  return s + "₹" + Math.round(a);
};
export const fmtDate = (s) => (s ? new Date(s.slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monLabel = (ym) => `${MON[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;

/** Today's date in India (the market's clock), as YYYY-MM-DD */
export function todayIST() {
  const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  return d.toISOString().slice(0, 10);
}
export function nowIST() { return new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); }
export const nowStamp = () => { const d = nowIST(); return d.toISOString().slice(0, 16).replace("T", " "); };

let toastT;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), ms);
}

/** Share a file (phone share sheet: save to Files/OneDrive/Drive/WhatsApp…) or download it */
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return "downloaded";
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = accept;
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}
