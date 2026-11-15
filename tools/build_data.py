"""Daily market-data job for the Portfolio phone app.

Builds static JSON files that the phone app downloads (same website, so no
browser blocking). It publishes the WHOLE market — never anyone's holdings.

  data/meta.json      when it was built, latest trading day, NAV date
  data/amfi.json      every live mutual fund scheme: code, name, NAV, previous NAV, date, category, fund house
  data/stocks.json    every NSE + BSE stock: symbol, name, close, previous close, date
  data/indices.json   Nifty 100 / Midcap 150 / Smallcap 250 / Microcap 250 members + industry (for cap mix)
  data/monthly.json   month-end closes for NSE stocks (for the growth chart and 2018 grandfathering)

Run:  python tools/build_data.py --out _site/data [--prev-url https://<you>.github.io/<repo>/data]
The previous build (fetched from --prev-url) supplies previous NAVs and the monthly history.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor

import requests

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt"
NSE_BHAV = "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
BSE_BHAV = "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{d:%Y%m%d}_F_0000.CSV"
INDEX_LISTS = {
    "large": "https://www.niftyindices.com/IndexConstituent/ind_nifty100list.csv",
    "mid": "https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv",
    "small": "https://www.niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv",
    "micro": "https://www.niftyindices.com/IndexConstituent/ind_niftymicrocap250_list.csv",
}
HERE = os.path.dirname(os.path.abspath(__file__))
SEED_MONTHLY = os.path.join(HERE, "..", "seed", "monthly.json")


def log(*a):
    print(*a, flush=True)


def get(url, timeout=60, tries=3):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code == 404:
                break
        except Exception as e:
            last = str(e)
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def load_prev(prev_url: str | None, name: str):
    if not prev_url:
        return None
    try:
        return get(f"{prev_url.rstrip('/')}/{name}?t={int(time.time())}", tries=2).json()
    except Exception as e:
        log(f"  (no previous {name}: {e})")
        return None


# ---------------------------------------------------------------- mutual funds
def build_amfi(prev):
    r = get(AMFI_URL, timeout=90)
    r.encoding = "utf-8"
    cats, amcs = [], []
    cat_i = amc_i = -1
    prev_map = {s[0]: s for s in (prev or {}).get("s", [])}
    out = []
    cutoff = (dt.date.today() - dt.timedelta(days=45)).isoformat()
    lines = r.text.splitlines()
    for idx, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(";")]
        if len(parts) >= 6 and parts[0].isdigit():
            try:
                nav = float(parts[-2])
                d = dt.datetime.strptime(parts[-1], "%d-%b-%Y").date().isoformat()
            except ValueError:
                continue
            if d < cutoff:
                continue
            name = " - ".join(p for p in parts[3:-2] if p and p != "-")
            code = parts[0]
            prev_nav = None
            p = prev_map.get(code)
            if p:  # [code, name, nav, prev, date, cat, amc]
                if p[4] < d:
                    prev_nav = p[2]
                elif p[4] == d:
                    prev_nav = p[3]
            out.append([code, name, nav, prev_nav, d, cat_i, amc_i])
        elif ";" not in line:
            if "(" in line and line.endswith(")") and ("Scheme" in line or "Schemes" in line):
                c = line[line.index("(") + 1:-1].strip()
                if c not in cats:
                    cats.append(c)
                cat_i = cats.index(c)
            else:  # fund-house header (repeats in every category section)
                if line not in amcs:
                    amcs.append(line)
                amc_i = amcs.index(line)
    if len(out) < 1000:
        raise RuntimeError(f"AMFI file looks wrong ({len(out)} schemes)")
    nav_date = max(s[4] for s in out)
    log(f"  AMFI: {len(out)} live schemes, latest NAV date {nav_date}")
    return {"fields": ["code", "name", "nav", "prev", "date", "cat", "amc"], "cats": cats, "amcs": amcs, "s": out}, nav_date


# ---------------------------------------------------------------- stocks
def _bhav_rows(text):
    return csv.DictReader(io.StringIO(text))


def fetch_bhav(kind: str, max_back: int = 8):
    today = dt.datetime.now(IST).date()
    for back in range(max_back):
        d = today - dt.timedelta(days=back)
        if d.weekday() >= 5:
            continue
        url = (NSE_BHAV if kind == "NSE" else BSE_BHAV).format(d=d)
        try:
            r = get(url, tries=2)
        except Exception as e:
            log(f"  {kind} {d}: {e}")
            continue
        body = r.content
        if url.endswith(".zip"):
            z = zipfile.ZipFile(io.BytesIO(body))
            body = z.read(z.namelist()[0])
        return d.isoformat(), body.decode("utf-8", "replace")
    raise RuntimeError(f"no {kind} bhavcopy in the last {max_back} days")


def build_stocks(prev):
    stocks = {}
    dates = {}
    for kind, suffix in (("NSE", ".NS"), ("BSE", ".BO")):
        try:
            d, text = fetch_bhav(kind)
        except Exception as e:
            log(f"  {kind} failed: {e} — keeping previous {kind} prices")
            for sym, v in (prev or {}).get("q", {}).items():
                if sym.endswith(suffix):
                    stocks[sym] = v
            continue
        n = 0
        for row in _bhav_rows(text):
            if row.get("FinInstrmTp") != "STK":
                continue
            sym = (row.get("TckrSymb") or "").strip()
            if not sym:
                continue
            try:
                close = float(row["ClsPric"])
                prevc = float(row["PrvsClsgPric"]) if row.get("PrvsClsgPric") else None
            except (ValueError, KeyError):
                continue
            # [name, close, prevClose, date, isin]
            stocks[sym + suffix] = [(row.get("FinInstrmNm") or "").strip(), close, prevc, row.get("TradDt") or d,
                                    (row.get("ISIN") or "").strip()]
            n += 1
        dates[kind] = d
        log(f"  {kind}: {n} stocks for {d}")
    if not stocks:
        raise RuntimeError("no stock prices at all")
    return {"fields": ["name", "close", "prev", "date", "isin"], "q": stocks}, dates


def build_indices(prev):
    out = {}
    for cap, url in INDEX_LISTS.items():
        try:
            rows = list(csv.DictReader(io.StringIO(get(url).text)))
            out[cap] = {r["Symbol"].strip(): r.get("Industry", "").strip() for r in rows if r.get("Symbol")}
            log(f"  index {cap}: {len(out[cap])}")
        except Exception as e:
            log(f"  index {cap} failed: {e}")
            if prev and cap in prev:
                out[cap] = prev[cap]
    return out


def update_monthly(prev_monthly, stocks):
    """{sym: {"YYYY-MM": close}} — the current month's value is overwritten each day, so it
    ends up as that month's last close."""
    m = prev_monthly
    if not m:
        try:
            with open(SEED_MONTHLY, encoding="utf-8") as f:
                m = json.load(f)
            log(f"  monthly: starting from seed ({len(m.get('h', {}))} symbols)")
        except FileNotFoundError:
            m = {"h": {}}
    h = m.setdefault("h", {})
    for sym, v in stocks["q"].items():
        if not sym.endswith(".NS"):
            continue
        month = (v[3] or "")[:7]
        if month:
            h.setdefault(sym, {})[month] = round(v[1], 2)
    return m


# ---------------------------------------------------------------- weekly NAV history per fund
NON_GROWTH = re.compile(r"idcw|dividend|payout|reinvest|bonus|income distribution", re.I)
MFAPI = "https://api.mfapi.in/mf/{code}"


def _week(iso):
    y, w, _ = dt.date.fromisoformat(iso).isocalendar()
    return y * 100 + w


def _weekly(points):
    """points ascending [[iso, nav]] -> last point of each ISO week"""
    out = []
    for p in points:
        if out and _week(out[-1][0]) == _week(p[0]):
            out[-1] = p
        else:
            out.append(p)
    return out


def _bootstrap(code):
    try:
        r = get(MFAPI.format(code=code), timeout=40, tries=2)
        rows = []
        for x in r.json().get("data", []):
            dd, mm, yy = x["date"].split("-")
            rows.append([f"{yy}-{mm}-{dd}", round(float(x["nav"]), 4)])
        rows.sort()
        return code, _weekly(rows)
    except Exception as e:
        return code, None


def update_nav_store(amfi, store_dir, out_dir, limit=6000):
    """Keeps data/nav/<code>.json = weekly NAVs (last point = latest NAV) for every growth plan.
    New schemes are fetched once from mfapi.in; after that each run just appends AMFI's latest NAV."""
    os.makedirs(store_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    schemes = [s for s in amfi["s"] if not NON_GROWTH.search(s[1])]
    missing = [s[0] for s in schemes if not os.path.exists(os.path.join(store_dir, s[0] + ".json"))][:limit]
    if missing:
        log(f"  NAV history: downloading {len(missing)} funds from mfapi.in (first run only)…")
        done = 0
        with ThreadPoolExecutor(12) as ex:
            for code, pts in ex.map(_bootstrap, missing):
                done += 1
                if pts:
                    with open(os.path.join(store_dir, code + ".json"), "w") as f:
                        json.dump(pts, f, separators=(",", ":"))
                if done % 500 == 0:
                    log(f"    {done}/{len(missing)}")
    n = 0
    for s in schemes:
        code, nav, d = s[0], s[2], s[4]
        p = os.path.join(store_dir, code + ".json")
        if not os.path.exists(p):
            pts = [[d, nav]]
        else:
            with open(p) as f:
                pts = json.load(f)
            if not pts or pts[-1][0] < d:
                if pts and _week(pts[-1][0]) == _week(d):
                    pts[-1] = [d, nav]
                else:
                    pts.append([d, nav])
        with open(p, "w") as f:
            json.dump(pts, f, separators=(",", ":"))
        shutil.copyfile(p, os.path.join(out_dir, code + ".json"))
        n += 1
    log(f"  NAV history: {n} funds published")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev-url", default=os.environ.get("PREV_URL"))
    ap.add_argument("--nav-store", default=os.environ.get("NAV_STORE", "_navstore"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    errors = []

    log("Mutual funds…")
    prev_amfi = load_prev(a.prev_url, "amfi.json")
    try:
        amfi, nav_date = build_amfi(prev_amfi)
    except Exception as e:
        errors.append(f"AMFI: {e}")
        amfi, nav_date = prev_amfi, (prev_amfi or {}).get("nav_date")
    if amfi:
        log("Fund NAV history…")
        try:
            update_nav_store(amfi, a.nav_store, os.path.join(a.out, "nav"))
        except Exception as e:
            errors.append(f"NAV history: {e}")
    log("Stocks…")
    prev_stocks = load_prev(a.prev_url, "stocks.json")
    try:
        stocks, trade_dates = build_stocks(prev_stocks)
    except Exception as e:
        errors.append(f"stocks: {e}")
        stocks, trade_dates = prev_stocks, (prev_stocks or {}).get("dates", {})
    log("Index lists…")
    indices = build_indices(load_prev(a.prev_url, "indices.json"))
    log("Monthly history…")
    monthly = update_monthly(load_prev(a.prev_url, "monthly.json"), stocks) if stocks else load_prev(a.prev_url, "monthly.json")

    if amfi:
        amfi["nav_date"] = nav_date
    if stocks:
        stocks["dates"] = trade_dates
    files = {"amfi.json": amfi, "stocks.json": stocks, "indices.json": indices, "monthly.json": monthly}
    for name, obj in files.items():
        if obj is None:
            errors.append(f"{name} missing")
            continue
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    meta = {"built": dt.datetime.now(IST).strftime("%Y-%m-%d %H:%M"), "nav_date": nav_date,
            "trade_dates": trade_dates, "errors": errors,
            "versions": {n: int(time.time()) for n in files}}
    with open(os.path.join(a.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    log("Done.", json.dumps(meta))
    if amfi is None and stocks is None:
        sys.exit(1)


if __name__ == "__main__":
    main()
