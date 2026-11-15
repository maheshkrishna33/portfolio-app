# Portfolio — phone app

A phone version of the Portfolio Tracker that runs on **Android and iPhone**. You install it from the browser and it opens full-screen like a normal app. It works offline too.

**Your portfolio stays on your phone.** The website only serves the app and the whole market's daily prices. It never receives your holdings.

## Features (same as the PC app)

| Tab | What's there |
|---|---|
| **Home** | Value, total gain, today's change, XIRR, CAGR, funds vs stocks split. Holdings with search, filters and sorting. Tap a holding to see its details, lots, buy/sell/edit, price source, account and alerts. **+** adds a transaction (search any fund or NSE/BSE stock; **Fetch** fills in the price on a date). |
| **Growth** | Value vs money invested since your first purchase (6M to All). Touch and drag the chart to see values. |
| **Insights** | **Monthly**: money in and out per month, a calendar view, regular SIPs and skipped months. **Exposure**: market-cap mix, categories, fund houses, industries, biggest holdings, concentration facts. **Fund rating**: your 5Y/1Y/6M/3Y/benchmark weighted ranking, with editable weights. |
| **Tax** | How much of this year's ₹1.25 lakh tax-free long-term gain limit is unused, and which units to sell and buy back to use it. Follows FIFO, the 12-month rule, ELSS lock-in and 2018 grandfathering. |
| **More** | Alerts (daily move %, price targets, daily summary), backups, Excel import/export, backup files, theme, market-data dates. |

## Prices

- A free scheduled GitHub job runs every evening: about 7:15 pm IST for stock closes, 11:15 pm for NAVs, and 8:30 am for late NAVs.
- It publishes closing prices for every NSE and BSE stock (from the exchanges' official daily files), every fund's NAV and weekly NAV history (from AMFI), and the Nifty index lists.
- The app picks these up when you open it or tap ↻. Stock prices are end-of-day, not live.

## Keep your data safe

The data lives only on the phone. Use **More › Save backup file** now and then and keep the file in Google Drive, OneDrive or Files. **More › Restore from backup file** brings it back on any phone. The app also keeps automatic daily copies on the phone (**More › Backups**).

## Alerts on a phone

Phones don't let web apps run in the background, so alerts are checked whenever you open the app or tap ↻. If you allow notifications (**More › Settings**), they also show as phone notifications. On iPhone this needs iOS 16.4 or later, with the app added to the Home Screen.

## Updating the app

Change the files in this folder, then double-click **deploy.bat**. Phones pick up the new version the next time the app is opened.

## Local preview (on the PC)

```bash
python tools/build_data.py --out _site/data
python tools/preview.py
```
Then open http://127.0.0.1:8090.
