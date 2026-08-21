# R1·M1·M2·T සිග්නල් ස්කෑනර් (Bybit) — Setup මාර්ගෝපදේශය

Bybit USDT Linear Perpetual futures scan කර, නව සිග්නලයක් හොයාගත්තොත් Gmail alert එකක් යවන automated trading scanner.

- **Web UI** → GitHub Pages හරහා ඕනෑම phone/browser එකෙන් බලන්න
- **Background scanner** → GitHub Actions හරහා හැම මිනිත්තු 5කටම run වෙනවා
- **Email alerts** → නව confirmed signal එකක් ආවාම Gmail alert එකක් ලැබෙනවා
- **Phone off** වුණත් scanner run වෙනවා — cloud server run කරනවා

> **වැදගත්:** Bybit ඔවුන්ගේ API එක US / cloud IPs වලට block කරන නිසා  
> **Cloudflare Worker** එකක් proxy විදිහට use කරනවා. ඒක free.

---

## ගොනු ලැයිස්තුව

| ගොනුව | කරන දේ |
|-------|---------|
| `index.html` | Scanner web app (GitHub Pages) |
| `scanner.js` | Background scanner (GitHub Actions) |
| `package.json` | Node.js dependencies |
| `.github/workflows/scanner.yml` | Scheduled workflow (හැම මිනිත්තු 5කටම) |
| `../cloudflare-worker/worker.js` | Cloudflare Worker proxy code |

---

## පියවර 1 — Cloudflare Worker හදාගන්න (අනිවාර්යයි)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Sign up / Login (free account ප්‍රමාණවත්)
2. Left menu → **Workers & Pages** → **Create** → **Create Worker**
3. Name එකක් දෙන්න (උදා: `bybit-proxy`) → **Deploy**
4. **Edit code** click කරලා තියෙන default code එක **delete** කරලා  
   `cloudflare-worker/worker.js` file එකේ **සම්පූර්ණ content** paste කරන්න
5. **Deploy** click කරන්න
6. Worker URL එක copy කරගන්න  
   උදා: `https://bybit-proxy.your-subdomain.workers.dev`

> මේ URL එක පස්සේ secrets + files වලට ඕනේ වෙනවා.

---

## පියවර 2 — GitHub Repository හදාගන්න

1. [github.com](https://github.com) → Sign up / Login
2. **New repository** click කරන්න
3. Repository name: `bybit-scanner` (ඕනෑ නමක් දෙන්න)
4. **Public** select කරන්න ✓ (GitHub Pages free plan සඳහා Public ඕනෑ)
5. **Create repository** click කරන්න

---

## පියවර 3 — Files Upload කරන්න

ZIP extract කළාට පස්සේ files ඔක්කොම GitHub එකට upload කරන්න.

### Phone/Browser හරහා (GUI method)

**සාමාන්‍ය files (index.html, scanner.js, package.json, README.md):**

1. Repo page → **Add file** → **Upload files**
2. Files drag කරන්න / select කරන්න
3. **Commit changes** click කරන්න

**`.github/workflows/scanner.yml` file** (folder structure ඕනෑ):

1. Repo page → **Add file** → **Create new file**
2. File name field එකට type කරන්න:
   ```
   .github/workflows/scanner.yml
   ```
3. `scanner.yml` file එකේ content paste කරන්න
4. **Commit new file** click කරන්න

### Git command line හරහා

```bash
git clone https://github.com/YOUR_USERNAME/bybit-scanner.git
cd bybit-scanner
# ZIP extract කළ files ඔක්කොම folder ඇතුළට copy කරන්න
git add .
git commit -m "Bybit scanner with Cloudflare proxy"
git push
```

---

## පියවර 4 — GitHub Pages Enable කරන්න

1. Repo → **Settings** tab
2. Left sidebar → **Pages**
3. **Source** → **Deploy from a branch** select කරන්න
4. Branch: **main** · Folder: **/ (root)**
5. **Save** click කරන්න
6. මිනිත්තු 1-2 බලන්න → URL ලැබෙනවා:
   ```
   https://YOUR_USERNAME.github.io/bybit-scanner/
   ```

---

## පියවර 5 — index.html එකේ Worker URL දාන්න

1. Repo එකේ `index.html` file එක open කරන්න
2. **Edit** click කරන්න
3. මේ line එක හොයාගන්න:
   ```js
   const FAPI = 'https://YOUR-WORKER.workers.dev';
   ```
4. `YOUR-WORKER.workers.dev` ටුක ඔයාගේ Cloudflare Worker URL එකට change කරන්න  
   උදා:
   ```js
   const FAPI = 'https://bybit-proxy.abc123.workers.dev';
   ```
5. **Commit changes**

---

## පියවර 6 — Gmail Alert + Secrets Setup කරන්න

### 6a — Gmail App Password හදාගන්න

1. [myaccount.google.com/security](https://myaccount.google.com/security) → **2-Step Verification** enable කරන්න
2. [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) open කරන්න
3. App name: `bybit-scanner` → **Create**
4. 16-character password copy කරගන්න

### 6b — GitHub Secrets Add කරන්න

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret Name     | Value                                      |
|-----------------|--------------------------------------------|
| `BYBIT_PROXY`   | ඔයාගේ Cloudflare Worker URL (පියවර 1)     |
| `GMAIL_USER`    | ඔයාගේ Gmail address                        |
| `GMAIL_APP_PASS`| Step 6a ගත් 16-char App Password           |
| `ALERT_EMAIL`   | Alert යවන email (same Gmail හෝ වෙන email)  |

---

## පියවර 7 — Workflow Verify කරන්න

1. Repo → **Actions** tab
2. **Bybit Signal Scanner** list වෙනවා
3. හැම මිනිත්තු 5කටම auto-run වෙනවා
4. Manual trigger: **Run workflow** → **Run workflow** button
5. Log එකේ `Using Bybit proxy: https://...` කියලා පේන්න ඕනේ
6. Error එකක් ආවොත් `BYBIT_PROXY` secret එක හරිද කියලා check කරන්න

---

## Multi-Timeframe Scanning Logic

| Time (UTC) | Scan කරන Timeframes      |
|------------|---------------------------|
| හැම 5m     | 5m                        |
| හැම 15m    | 5m + 15m                  |
| හැම 30m    | 5m + 15m + 30m            |
| හැම 1h     | + 1h                      |
| හැම 2h     | + 2h                      |

> **සටහන:** Bybit එකේ 3-hour (180 min) interval නැති නිසා 3h timeframe ඉවත් කරලා තියෙනවා.

---

## Email Alert Example

```
Subject: 🚨 BTCUSDT 15M — New Signal (Method 3)

R1:      Aug 10, 03:30 AM UTC
M1:      Aug 10, 08:15 PM UTC
M2:      Aug 10, 09:30 PM UTC
T:       Aug 11, 05:30 PM UTC

FIBONACCI
Price 1:    65,482.70
Price 2:    63,788.00
Fib 0.5:   62,940.65   ← entry level
Fib 0.382: 62,740.68
Fib 0.618: 62,455.97   ← stop loss

Status: Awaiting return to Fib 0.5
```

---

## Default Settings

| Setting                | Value              |
|------------------------|--------------------|
| M1 → M2 Max Distance   | **5 candles**      |
| 4H EMA50 Confirmation  | **Disabled**       |
| Strategy Method        | **Method 3 only**  |

Settings panel (⚙) හරහා M1→M2 distance change කරන්න පුළුවන්.

---

## Troubleshooting

| ප්‍රශ්නය                          | විසඳුම                                                                 |
|-----------------------------------|------------------------------------------------------------------------|
| Worker URL වැඩ නෑ                 | Cloudflare dashboard එකේ Worker Deploy වෙලා තියෙනවාද check කරන්න     |
| `BYBIT_PROXY` not set error       | GitHub Secrets එකේ `BYBIT_PROXY` add කරලා තියෙනවාද check කරන්න       |
| Pages 404 error                   | Enable කරලා මිනිත්තු 2-3 wait කරන්න, hard refresh                       |
| Email නොලැබේ                      | Spam folder check; App Password verify; Actions log check              |
| Workflow run නොවේ                 | `.github/workflows/scanner.yml` commit වෙලා තියෙනවාද check             |
| Actions tab හිස්                  | Repo → Actions → "I understand my workflows" enable කරන්න              |
| index.html එකේ data නෑ            | `const FAPI = ...` line එකේ Worker URL හරිද කියලා check කරන්න         |

---

## Free Tier Limits

- Cloudflare Workers: **100,000 requests/day** free ✓
- GitHub Actions: Public repo → **unlimited minutes** ✓
- GitHub Pages: Public repo → **free** ✓
- Bybit API: **No API key required** ✓
- Gmail: App Password → **free** ✓

---

## වෙනස්කම් (v1 → v2)

- Binance → **Bybit** Linear Perpetual
- CryptoCompare ඉවත් කළා
- Cloudflare Worker proxy එකතු කළා (GitHub Actions වලින් Bybit call කරන්න)
- 3h timeframe ඉවත් කළා (Bybit එකේ නැති නිසා)
