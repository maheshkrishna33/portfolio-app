// Lightweight SVG charts with touch tooltips (drag a finger across the chart).
import { $, esc, inrShort, monLabel } from "./util.js";

export function niceTicks(min, max, count = 4) {
  const span = max - min || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw)), e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag, out = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}

export function showTip(html, x, y) {
  const tip = $("#tip");
  tip.innerHTML = html; tip.classList.add("show");
  const r = tip.getBoundingClientRect();
  let left = x - r.width / 2, top = y - r.height - 18;
  if (top < 8) top = y + 22;
  left = Math.max(8, Math.min(innerWidth - r.width - 8, left));
  tip.style.left = left + "px"; tip.style.top = top + "px";
}
export const hideTip = () => $("#tip").classList.remove("show");
export const tipRow = (c, l, v) => `<div class="row"><span>${c ? `<i style="background:${c}"></i>` : ""}${l}</span><b>${v}</b></div>`;

function track(svg, W, onIndex, onLeave) {
  const at = (ev) => { const r = svg.getBoundingClientRect(); return [((ev.clientX - r.left) * W) / r.width, ev.clientX, ev.clientY]; };
  svg.addEventListener("pointerdown", (ev) => { svg.setPointerCapture?.(ev.pointerId); onIndex(...at(ev)); });
  svg.addEventListener("pointermove", (ev) => { if (ev.pointerType === "mouse" || ev.buttons) onIndex(...at(ev)); });
  svg.addEventListener("pointerup", (ev) => { if (ev.pointerType !== "mouse") setTimeout(onLeave, 1800); });
  svg.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") onLeave(); });
}

export function lineChart(el, { dates, series, height = 240, tooltip }) {
  const W = Math.max(300, el.clientWidth || 360), H = height, m = { l: 48, r: 54, t: 8, b: 22 };
  const n = dates.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ticks = niceTicks(0, Math.max(1, ...series.flatMap((s) => s.values)), 4), ymax = ticks[ticks.length - 1];
  const x = (i) => m.l + (n <= 1 ? iw : (i * iw) / (n - 1)), y = (v) => m.t + ih * (1 - v / ymax);
  let g = "";
  ticks.forEach((t) => { g += `<line class="${t === 0 ? "base" : "gridl"}" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${inrShort(t)}</text>`; });
  const spanDays = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 864e5;
  let lastKey = null, lastX = -1e9;
  dates.forEach((d, i) => {
    const key = spanDays > 900 ? d.slice(0, 4) : d.slice(0, 7);
    if (key !== lastKey && i > 0 && x(i) - lastX > 46) { g += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle">${spanDays > 900 ? key : monLabel(key)}</text>`; lastX = x(i); }
    lastKey = key;
  });
  const path = (v) => v.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join("");
  series.forEach((s) => { if (s.area) g += `<path d="${path(s.values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="${s.color}" opacity=".14"/>`; });
  series.forEach((s) => { g += `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`; });
  const ends = series.map((s) => ({ s, yy: y(s.values[n - 1]) })).sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 14) ends[i].yy = ends[i - 1].yy + 14;
  ends.forEach(({ s, yy }) => { g += `<text class="endlab" x="${W - m.r + 5}" y="${yy + 4}">${inrShort(s.values[n - 1])}</text>`; });
  g += `<g class="hov"></g>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${g}</svg>`;
  const svg = el.querySelector("svg"), hov = svg.querySelector(".hov");
  track(svg, W, (sx, cx, cy) => {
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - m.l) / iw) * (n - 1))));
    hov.innerHTML = `<line class="xhair" x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${m.t + ih}"/>` +
      series.map((s) => `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="4.5" fill="${s.color}" stroke="var(--panel)" stroke-width="2"/>`).join("");
    const r = svg.getBoundingClientRect();
    showTip(tooltip(i), r.left + (x(i) * r.width) / W, cy);
  }, () => { hov.innerHTML = ""; hideTip(); });
}

export function barChart(el, { labels, up, down, height = 220, tooltip }) {
  const W = Math.max(300, el.clientWidth || 360), H = height, m = { l: 48, r: 8, t: 8, b: 22 };
  const n = labels.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ticks = niceTicks(-Math.max(0, ...down), Math.max(1, ...up), 4), lo = Math.min(0, ticks[0]), hi = ticks[ticks.length - 1];
  const y = (v) => m.t + ih * (1 - (v - lo) / (hi - lo)), band = iw / n, bw = Math.max(2, Math.min(22, band - 2));
  let g = "";
  ticks.forEach((t) => { g += `<line class="${t === 0 ? "base" : "gridl"}" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${inrShort(t)}</text>`; });
  const every = Math.ceil(50 / band);
  labels.forEach((l, i) => { if ((n - 1 - i) % every === 0) g += `<text x="${m.l + band * i + band / 2}" y="${H - 5}" text-anchor="middle">${monLabel(l)}</text>`; });
  const bar = (cx, v, color, isUp) => {
    if (!v) return "";
    const h = Math.abs(y(v) - y(0)), r = Math.min(4, h / 2, bw / 2), x0 = cx - bw / 2, y0 = y(0), s = isUp ? -1 : 1;
    return `<path d="M${x0},${y0}V${y0 + s * (h - r)}Q${x0},${y0 + s * h} ${x0 + r},${y0 + s * h}H${x0 + bw - r}Q${x0 + bw},${y0 + s * h} ${x0 + bw},${y0 + s * (h - r)}V${y0}Z" fill="${color}"/>`;
  };
  labels.forEach((l, i) => { const cx = m.l + band * i + band / 2; g += bar(cx, up[i], "var(--s1)", true) + bar(cx, down[i], "var(--s2)", false); });
  g += `<g class="hov"></g>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${g}</svg>`;
  const svg = el.querySelector("svg"), hov = svg.querySelector(".hov");
  track(svg, W, (sx, cx, cy) => {
    const i = Math.max(0, Math.min(n - 1, Math.floor((sx - m.l) / band)));
    hov.innerHTML = `<rect x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}" fill="var(--text)" opacity=".06"/>`;
    showTip(tooltip(i), cx, cy);
  }, () => { hov.innerHTML = ""; hideTip(); });
}

export function hbars(rows, color = "var(--s1)") {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r) => `<div class="hbar"><div class="lab"><span>${esc(r.name)}</span><b>${(r.pct * 100).toFixed(1)}%</b></div>
    <div class="trk"><span style="width:${((r.value / max) * 100).toFixed(1)}%;background:${color}"></span></div><div class="val">${inrShort(r.value)}</div></div>`).join("")}</div>`;
}
