# R1·M1·M2·T Method 3 Scanner (BingX USDT-M)

BingX **USDT-M perpetual swap** · Method 3 · Gmail · No proxy.

## Symbols
`BTC-USDT`, `ETH-USDT`, … only pairs ending `-USDT` (USDT-M). Coin-M ignored.

## Auto trading later
Yes — BingX has full futures trade API (API key + secret).
- Create key: trade permission ON, withdraw OFF
- Demo/copy trading available on platform for practice
- Scanner stays public-data only; order bot is separate later

## Lag
Background: top **150** by volume (`SCAN_TOP_N`). UI: Top N or All.

## Setup
Upload zip files → `.github/workflows/scanner.yml` → secrets GMAIL_* → Pages + Run workflow.

Not financial advice.
