# R1·M1·M2·T Method 3 Scanner (KuCoin USDT-M Futures)

KuCoin Futures **USDT-M** perpetual · Method 3 · Gmail · **No proxy**.

## Symbols
Format: `XBTUSDTM`, `ETHUSDTM`, `SOLUSDTM`, … (not BTCUSDT).

## Mock / Demo trading (auto trading පෙර)
KuCoin has **Futures Demo Trading** (paper):
1. KuCoin app/web → Futures → switch to **Demo** / Practice account  
2. Virtual balance එක්ක order place කරලා strategy test කරන්න  
3. Real API auto trading පස්සේ — separate **live** API key (trade only, withdraw off)

## Lag (700+ pairs)
Background default: **Top 150** by 24h turnover (`SCAN_TOP_N`).  
UI: Top N or All Coins.

## Setup
1. Public repo — upload all files from zip  
2. `.github/workflows/scanner.yml`  
3. Secrets: `GMAIL_USER`, `GMAIL_APP_PASS`  
4. Variables optional: `SCAN_TOP_N=150`, `M3_MAX_DISTANCE=30`, `M3_REQUIRE_4H_T=false`  
5. Pages + Actions → Run workflow  

No Cloudflare Worker.

Not financial advice.
