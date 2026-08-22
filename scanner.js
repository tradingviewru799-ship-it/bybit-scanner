/**
 * scanner.js — BingX USDT-M Perpetual Swap · R1·M1·M2·T · Method 3
 * Base: https://open-api.bingx.com
 * Symbols: BTC-USDT, ETH-USDT (USDT-M only)
 * Top SCAN_TOP_N by volume (default 150)
 */

'use strict';

const https = require('https');
const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');

const BINGX = 'https://open-api.bingx.com';

const INTERVAL_MAP = {
  '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h',
};

const DEEP_LIMIT = 500;
const CONFIRM_LIMIT = 300;
const EMA_FAST = 50, EMA_MID = 100, EMA_SLOW = 200;
const RSI_PERIOD = 14, RSI_OB = 70, M1_M2_MAX_BARS = 150;
const FIB_LEVELS = { entryHigh: 0.5, entryLow: 0.382, sl: 0.618 };
const SCAN_CONCURRENCY = 5;
const STATE_FILE = path.join(__dirname, 'signal-state.json');

const METHOD = process.env.STRATEGY_METHOD || '3';
const M3_MAX_DISTANCE = (() => {
  const n = parseInt(process.env.M3_MAX_DISTANCE || '30', 10);
  return Number.isInteger(n) && n >= 1 && n <= 150 ? n : 30;
})();
const M3_REQUIRE_4H_T = String(process.env.M3_REQUIRE_4H_T || 'false').toLowerCase() === 'true';
const SCAN_TOP_N = (() => {
  const n = parseInt(process.env.SCAN_TOP_N || '150', 10);
  return Number.isInteger(n) && n >= 20 && n <= 800 ? n : 150;
})();

const FALLBACK = [
  'BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','DOGE-USDT','BNB-USDT','ADA-USDT',
  'AVAX-USDT','LINK-USDT','DOT-USDT','LTC-USDT','TRX-USDT','ATOM-USDT','NEAR-USDT',
  'APT-USDT','ARB-USDT','OP-USDT','SUI-USDT',
];

function getTimeframesToScan() {
  const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const tfs = ['5m'];
  if (m % 15 === 0) tfs.push('15m');
  if (m % 30 === 0) tfs.push('30m');
  if (m % 60 === 0) tfs.push('1h');
  return tfs;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'BingXM3Scanner/1.0', 'Accept': 'application/json' },
      timeout: 25000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve, reject);
      }
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          if (!raw.trim()) return reject(new Error('empty ' + res.statusCode));
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('JSON ' + res.statusCode + ' ' + raw.slice(0, 100)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJSONWithRetry(url, retries = 3, delayMs = 1200) {
  let last;
  for (let i = 0; i < retries; i++) {
    try { return await fetchJSON(url); }
    catch (e) {
      last = e;
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

function withTs(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return `${BINGX}${pathAndQuery}${sep}timestamp=${Date.now()}`;
}

async function fetchKlines(symbol, interval, limit) {
  const iv = INTERVAL_MAP[interval] || '15m';
  const url = withTs(
    `/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(symbol)}&interval=${iv}&limit=${limit}`
  );
  const raw = await fetchJSONWithRetry(url);
  if (!raw || (raw.code !== 0 && raw.code !== '0') || !Array.isArray(raw.data)) {
    throw new Error(`klines ${symbol}: ${raw && (raw.msg || raw.message)}`);
  }
  // BingX often: open, close, high, low as strings; time fields vary
  const minutes = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240 }[iv] || 15;
  const rows = raw.data.map(k => {
    // array form [openTime, open, high, low, close, volume, closeTime] OR object
    if (Array.isArray(k)) {
      const openTime = +k[0];
      return {
        openTime,
        open: +k[1], high: +k[2], low: +k[3], close: +k[4],
        volume: +k[5],
        closeTime: k[6] != null ? +k[6] : openTime + minutes * 60 * 1000 - 1,
      };
    }
    const openTime = +(k.time || k.openTime || k.t);
    return {
      openTime,
      open: +k.open, high: +k.high, low: +k.low, close: +k.close,
      volume: +(k.volume || k.vol || 0),
      closeTime: openTime + minutes * 60 * 1000 - 1,
    };
  });
  rows.sort((a, b) => a.openTime - b.openTime);
  return rows;
}

async function fetchAllSymbols() {
  const url = withTs('/openApi/swap/v2/quote/contracts');
  const data = await fetchJSONWithRetry(url);
  if (!data || (data.code !== 0 && data.code !== '0') || !Array.isArray(data.data)) {
    throw new Error(data && data.msg);
  }
  return data.data
    .filter(s => {
      const sym = s.symbol || '';
      if (!sym.endsWith('-USDT')) return false;
      const st = s.status;
      if (st === 1 || st === '1' || st === true) return true;
      const status = String(st || s.contractStatus || '').toLowerCase();
      return !status || status === 'trading' || status === 'online' || status === 'true';
    })
    .map(s => s.symbol)
    .sort();
}

async function fetchTopNSymbols(n) {
  try {
    const eligible = new Set(await fetchAllSymbols());
    const url = withTs('/openApi/swap/v2/quote/ticker');
    const data = await fetchJSONWithRetry(url);
    if (!data || (data.code !== 0 && data.code !== '0') || !Array.isArray(data.data)) {
      return [...eligible].slice(0, n);
    }
    return data.data
      .filter(t => eligible.has(t.symbol))
      .map(t => ({
        symbol: t.symbol,
        vol: +(t.quoteVolume || t.volume || t.turnover || t.quoteVol || 0),
      }))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, n)
      .map(t => t.symbol);
  } catch (e) {
    console.log('[scanner] topN fail:', e.message);
    return FALLBACK.slice(0, n);
  }
}

function calcEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcRSI(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function findCrosses(fast, slow) {
  const crosses = [];
  for (let i = 1; i < fast.length; i++) {
    if (fast[i - 1] == null || slow[i - 1] == null || fast[i] == null || slow[i] == null) continue;
    const pd = fast[i - 1] - slow[i - 1], cd = fast[i] - slow[i];
    if (pd === 0) continue;
    if ((pd < 0 && cd > 0) || (pd > 0 && cd < 0)) crosses.push({ index: i });
  }
  return crosses;
}

function isClosed(c) { return c.closeTime < Date.now(); }

function buildCandidate(symbol, candles, method, m3MaxDist) {
  const closes = candles.map(c => c.close);
  const ema50 = calcEMA(closes, EMA_FAST);
  const ema100 = calcEMA(closes, EMA_MID);
  const ema200 = calcEMA(closes, EMA_SLOW);
  const rsi = calcRSI(closes, RSI_PERIOD);
  const ind = { ema50, ema100, ema200, rsi };

  const m1Crosses = findCrosses(ema50, ema200).filter(c => isClosed(candles[c.index]));
  if (!m1Crosses.length) return { stage: 'no_m1' };
  const m1Index = m1Crosses[m1Crosses.length - 1].index;

  let r1Index = -1;
  for (let i = m1Index - 1; i >= 0; i--) {
    if (rsi[i] != null && rsi[i] > RSI_OB) { r1Index = i; break; }
  }
  if (r1Index === -1) return { stage: 'no_r1' };

  let m2Index = -1;
  for (let i = m1Index + 1; i <= Math.min(m1Index + M1_M2_MAX_BARS, candles.length - 1); i++) {
    const pdA = ema50[i - 1] - ema200[i - 1], cdA = ema50[i] - ema200[i];
    if (ema50[i - 1] != null && ema200[i - 1] != null && ema50[i] != null && ema200[i] != null &&
        pdA !== 0 && ((pdA < 0 && cdA > 0) || (pdA > 0 && cdA < 0))) {
      return { stage: 'invalidated' };
    }
    const pdB = ema200[i - 1] - ema100[i - 1], cdB = ema200[i] - ema100[i];
    if (ema200[i - 1] != null && ema100[i - 1] != null && ema200[i] != null && ema100[i] != null &&
        pdB !== 0 && ((pdB < 0 && cdB > 0) || (pdB > 0 && cdB < 0))) {
      m2Index = i; break;
    }
  }
  if (m2Index === -1) return { stage: 'no_m2' };

  if (method === '3') {
    const dist = m2Index - m1Index;
    if (dist > m3MaxDist) return { stage: 'm3_distance_fail', dist, max: m3MaxDist };
  }

  let tIndex = -1;
  for (let i = m2Index + 1; i < candles.length; i++) {
    if (!isClosed(candles[i])) break;
    if (ema200[i] == null || ema200[i - 1] == null) continue;
    if (!(candles[i].low <= ema200[i] && candles[i].high >= ema200[i])) continue;
    if (candles[i - 1].close < ema200[i - 1]) { tIndex = i; break; }
  }
  if (tIndex === -1) return { stage: 'no_t' };

  return { stage: 'has_t', r1Index, m1Index, m2Index, tIndex, ind, candles, symbol };
}

async function confirm4h(symbol, tTimeMs) {
  const c4 = await fetchKlines(symbol, '4h', CONFIRM_LIMIT);
  const ema50_4h = calcEMA(c4.map(c => c.close), EMA_FAST);
  for (let i = 0; i < c4.length; i++) {
    if (tTimeMs >= c4[i].openTime && tTimeMs < c4[i].closeTime) {
      if (ema50_4h[i] == null) return { ok: false };
      return { ok: c4[i].low <= ema50_4h[i] && c4[i].high >= ema50_4h[i] };
    }
  }
  return { ok: false };
}

function computeFib(candles, r1Index, m1Index, tIndex) {
  let p1 = -Infinity, p1i = r1Index;
  for (let i = r1Index; i <= m1Index; i++) if (candles[i].high > p1) { p1 = candles[i].high; p1i = i; }
  let p2 = Infinity, p2i = r1Index;
  for (let i = r1Index; i <= tIndex; i++) if (candles[i].low < p2) { p2 = candles[i].low; p2i = i; }
  const range = p1 - p2;
  return {
    price1: p1, price1Idx: p1i, price2: p2, price2Idx: p2i,
    fib50: p1 - range * FIB_LEVELS.entryHigh,
    fib618: p1 - range * FIB_LEVELS.entryLow,
    fib786: p1 - range * FIB_LEVELS.sl,
  };
}

function findEMA100Touch(candles, ema100, fromIndex) {
  for (let i = fromIndex + 1; i < candles.length; i++) {
    if (!isClosed(candles[i])) break;
    if (ema100[i] == null) continue;
    if (candles[i].low <= ema100[i] && candles[i].high >= ema100[i]) return i;
  }
  return -1;
}

async function processSymbol(symbol, tf, method) {
  try {
    const candles = await fetchKlines(symbol, tf, DEEP_LIMIT);
    if (candles.length < EMA_SLOW + 20) return null;
    const cand = buildCandidate(symbol, candles, method, M3_MAX_DISTANCE);
    if (cand.stage !== 'has_t') return null;

    const tTimeMs = candles[cand.tIndex].openTime;
    const require4h = method === '3' ? M3_REQUIRE_4H_T : true;
    const conf = await confirm4h(symbol, tTimeMs);
    if (!conf.ok && !(method === '3' && !require4h)) return null;

    const fib = computeFib(candles, cand.r1Index, cand.m1Index, cand.tIndex);
    const ema200AtT = cand.ind.ema200[cand.tIndex];
    if (ema200AtT == null || !(fib.fib618 > ema200AtT)) return null;

    let entryIndex = -1, slIndex = -1;
    for (let i = cand.tIndex + 1; i < candles.length; i++) {
      if (!isClosed(candles[i])) break;
      if (candles[i].low <= fib.fib50 && candles[i].high >= fib.fib50) { entryIndex = i; break; }
    }
    if (entryIndex >= 0) {
      for (let i = entryIndex + 1; i < candles.length; i++) {
        if (!isClosed(candles[i])) break;
        if (candles[i].low <= fib.fib786) { slIndex = i; break; }
      }
    }

    let m3_100TIndex = -1, m3Fib = null;
    const m3Dist = cand.m2Index - cand.m1Index;
    if (method === '3') {
      const p1i = fib.price1Idx, p2i = fib.price2Idx;
      if (!(p1i < p2i && p2i < cand.m1Index && cand.m1Index < cand.m2Index)) return null;
      m3_100TIndex = findEMA100Touch(candles, cand.ind.ema100, cand.m2Index);
      if (m3_100TIndex < 0) return null;
      let fibHigh = -Infinity, fibHighIdx = -1;
      for (let i = p2i; i <= m3_100TIndex; i++) {
        if (candles[i].high > fibHigh) { fibHigh = candles[i].high; fibHighIdx = i; }
      }
      if (fibHighIdx < cand.m1Index || fibHigh <= candles[p2i].low) return null;
      const p2Price = candles[p2i].low, range2 = fibHigh - p2Price;
      m3Fib = {
        price1: p2Price, price1Idx: p2i, price2: fibHigh, price2Idx: fibHighIdx,
        fib50: fibHigh - range2 * 0.5, fib618: fibHigh - range2 * 0.618, fib786: fibHigh - range2 * 0.786,
      };
    }

    return {
      symbol, tf, method,
      r1Time: candles[cand.r1Index].openTime,
      m1Time: candles[cand.m1Index].openTime,
      m2Time: candles[cand.m2Index].openTime,
      tTime: candles[cand.tIndex].openTime,
      entryTime: entryIndex >= 0 ? candles[entryIndex].openTime : null,
      slTime: slIndex >= 0 ? candles[slIndex].openTime : null,
      price1: fib.price1, price2: fib.price2,
      fib50: fib.fib50, fib618: fib.fib618, fib786: fib.fib786,
      ema200AtT, m3Dist, m3Max: M3_MAX_DISTANCE, m3Require4h: require4h,
      m3_100TTime: m3_100TIndex >= 0 ? candles[m3_100TIndex].openTime : null,
      m3Fib, scannedAt: Date.now(),
    };
  } catch (e) {
    console.warn(`[process] ${symbol} ${tf}: ${e.message.split('\n')[0]}`);
    return null;
  }
}

async function scanSymbols(symbols, tf, method) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < symbols.length) {
      const i = idx++;
      const sig = await processSymbol(symbols[i], tf, method);
      if (sig) results.push(sig);
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return results;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return { signals: {} };
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  const abs = Math.abs(p);
  const dec = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtTime(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'Asia/Colombo', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function buildEmailHtml(sig) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#0a0c11;font-family:system-ui,sans-serif;">
  <div style="max-width:480px;margin:20px auto;background:#12151d;border:1px solid #242a38;border-radius:12px;overflow:hidden;">
    <div style="padding:16px 20px;background:#0d1621;border-bottom:1px solid #242a38;">
      <div style="font-size:11px;color:#8892a4;">R1·M1·M2·T · Method ${sig.method} · BingX USDT-M</div>
      <div style="font-size:22px;font-weight:700;color:#e9edf4;margin-top:4px;">${sig.symbol} · ${sig.tf.toUpperCase()}</div>
    </div>
    <div style="padding:16px 20px;font-size:13px;color:#c9d1d9;">
      <div>R1 ${fmtTime(sig.r1Time)} · M1 ${fmtTime(sig.m1Time)} · M2 ${fmtTime(sig.m2Time)} · T ${fmtTime(sig.tTime)}</div>
      <div style="margin-top:8px;">Fib 0.5 ${fmtPrice(sig.fib50)} · SL ${fmtPrice(sig.fib786)}</div>
      <div style="margin-top:6px;color:#8892a4;">M1→M2 ${sig.m3Dist}/${sig.m3Max}</div>
      <div style="margin-top:8px;">Entry ${sig.entryTime ? fmtTime(sig.entryTime) : 'waiting'}</div>
    </div>
    <div style="padding:12px 20px;font-size:11px;color:#565f73;border-top:1px solid #242a38;">${fmtTime(sig.scannedAt)} · Not financial advice</div>
  </div></body></html>`;
}

async function sendAlert(sig) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASS;
  const to = process.env.ALERT_EMAIL || user;
  if (!user || !pass) { console.log('[email] Skipped'); return; }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({
    from: `"BingX Signal Scanner" <${user}>`,
    to,
    subject: `🚨 ${sig.symbol} ${sig.tf.toUpperCase()} — Method ${sig.method}`,
    html: buildEmailHtml(sig),
  });
  console.log(`[email] → ${to} · ${sig.symbol} ${sig.tf}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tfs = getTimeframesToScan();
  console.log(`[${new Date().toISOString()}] TFs: ${tfs.join(', ')}`);
  console.log(`[config] method=${METHOD} m3Max=${M3_MAX_DISTANCE} 4h=${M3_REQUIRE_4H_T} topN=${SCAN_TOP_N}`);
  console.log('[api] BingX USDT-M swap direct');

  try {
    const h = await fetchJSON(withTs('/openApi/swap/v2/server/time'));
    console.log('[api] time OK', h && (h.data || h.serverTime || h.code));
  } catch (e) {
    console.error('[fatal] BingX unreachable:', e.message);
    process.exit(1);
  }

  const state = loadState();
  let newSignals = 0;

  try {
    const symbols = await fetchTopNSymbols(SCAN_TOP_N);
    console.log(`[scanner] ${symbols.length} symbols (top volume, USDT-M)`);

    for (const tf of tfs) {
      console.log(`[scanner] Scanning ${tf}…`);
      const signals = await scanSymbols(symbols, tf, METHOD);
      console.log(`[scanner] ${tf}: ${signals.length} confirmed`);

      for (const sig of signals) {
        const key = `${sig.symbol}_${tf}_${METHOD}`;
        const prev = state.signals[key];
        const isNew = !prev;
        const entryChanged = prev && !prev.entryTime && sig.entryTime;
        const slChanged = prev && !prev.slTime && sig.slTime;
        if (isNew || entryChanged || slChanged) {
          console.log(`[signal] ${isNew ? 'NEW' : entryChanged ? 'ENTRY' : 'SL'}: ${sig.symbol} ${tf}`);
          newSignals++;
          if (!dryRun) await sendAlert(sig).catch(e => console.error('[email]', e.message));
        }
        state.signals[key] = { entryTime: sig.entryTime, slTime: sig.slTime, scannedAt: sig.scannedAt };
      }
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const k of Object.keys(state.signals)) {
        if ((state.signals[k].scannedAt || 0) < cutoff) delete state.signals[k];
      }
    }
  } catch (e) {
    console.error('[scanner] Fatal:', e.message);
    process.exit(1);
  }

  saveState(state);
  console.log(`[done] ${newSignals} new alert(s)`);
}

main();
