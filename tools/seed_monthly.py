"""One-time seed: ~10 years of month-end closes for every NSE equity, from Yahoo Finance.
The daily job then keeps it current from the NSE price file. Output: seed/monthly.json
Run:  python tools/seed_monthly.py"""
import csv
import io
import json
import os
import time

import requests
import yfinance as yf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "seed", "monthly.json")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}


def main():
    text = requests.get("https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv", headers=UA, timeout=60).text
    syms = sorted({r["SYMBOL"].strip() + ".NS" for r in csv.DictReader(io.StringIO(text), skipinitialspace=True)
                   if r.get("SYMBOL")})
    print(len(syms), "symbols", flush=True)
    hist = {}
    for i in range(0, len(syms), 150):
        chunk = syms[i:i + 150]
        for attempt in range(3):
            try:
                df = yf.download(chunk, period="10y", interval="1mo", progress=False, auto_adjust=False, threads=True)
                close = df["Close"]
                for s in chunk:
                    if s in close.columns:
                        ser = close[s].dropna()
                        if len(ser):
                            hist[s] = {idx.strftime("%Y-%m"): round(float(v), 2) for idx, v in ser.items()}
                break
            except Exception as e:
                print("retry", i, e, flush=True)
                time.sleep(10)
        print(f"{min(i + 150, len(syms))}/{len(syms)} done, {len(hist)} with data", flush=True)
        time.sleep(1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"h": hist}, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
