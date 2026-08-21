/**
 * scanner.js — Bybit USDT Perpetual Signal Scanner (R1·M1·M2·T)
 *
 * Runs every 5 minutes via GitHub Actions.
 * Uses Cloudflare Worker as proxy so Bybit API is reachable from GitHub runners
 * (Bybit blocks most US / cloud IPs via CloudFront).
 *
 * Timeframe schedule (aligned to 5-minute boundaries):
 *   Every 5m  → scan 5m
 *   Every 15m → scan 5m + 15m
 *   Every 30m → scan 5m + 15m + 30m
 *   Every 1h  → + 1h
 *   Every 2h  → + 2h
 *   (3h removed — Bybit has no 180-min interval)
 */

'use strict';

const https    = require('https');
const fs       = require('fs');
const nodemailer = require('nodemailer');
const path     = require('path');

/* ============================== CONFIG ============================== */
// ★★★ IMPORTANT: Replace with your Cloudflare Worker URL after deploying ★★★
// Example: https://bybit-proxy.yourname.workers.dev
const BYBIT_PROXY = process.env.BYBIT_PROXY || 'https://YOUR-WORKER.workers.dev';

const INTERVAL_MAP = {
  '5m':  '5',
  '15m': '15',
  '30m': '30',
  '1h':  '60',
  '2h':  '120',
  '4h':  '240',
};

const DEEP_LIMIT    = 500;
const CONFIRM_LIMIT = 400;
const EMA_FAST = 50, EMA_MID = 100, EMA_SLOW = 200;
const RSI_PERIOD    = 14;
const RSI_OB        = 70;
const M1_M2_MAX_BARS = 150;
const FIB_LEVELS    = { entryHigh: 0.5, entryLow: 0.382, sl: 0.618 };
const SCAN_CONCURRENCY = 4;   // lower = safer for free CF Worker
const STATE_FILE    = path.join(__dirname, 'signal-state.json');

// Method 3 defaults
const M3_MAX_DISTANCE = 5;
const M3_REQUIRE_4H_T = false;

const ALL_TIMEFRAMES = ['5m', '15m', '30m', '1h', '2h'];  // no 3h on Bybit

/* ============================== TIMEFRAME SELECTION ============================== */
function getTimeframesToScan(){
  const now = new Date();
  const totalMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const tfs = ['5m'];
  if(totalMinutes % 15  === 0) tfs.push('15m');
  if(totalMinutes % 30  === 0) tfs.push('30m');
  if(totalMinutes % 60  === 0) tfs.push('1h');
  if(totalMinutes % 120 === 0) tfs.push('2h');
  return tfs;
}

/* ============================== HTTP HELPER ============================== */
function fetchJSON(url){
  return new Promise((resolve, reject)=>{
    const req = https.get(url, {
      headers:{ 'User-Agent': 'Mozilla/5.0 (compatible; BybitScanner/1.0)', 'Accept': 'application/json' }
    }, res=>{
      if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data='';
      res.on('data', c=>data+=c);
      res.on('end', ()=>{
        if(res.statusCode !== 200){
          return reject(new Error(`HTTP ${res.statusCode} for ${url}\nBody: ${data.slice(0,300)}`));
        }
        try{ resolve(JSON.parse(data)); }
        catch(e){ reject(new Error('JSON parse error: '+e.message+'\nBody: '+data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, ()=>{ req.destroy(); reject(new Error('Timeout: '+url)); });
  });
}

async function fetchJSONWithRetry(url, retries=3, delayMs=2000){
  for(let attempt=1; attempt<=retries; attempt++){
    try{
      return await fetchJSON(url);
    }catch(e){
      console.warn(`[fetch] Attempt ${attempt}/${retries} failed: ${e.message.split('\n')[0]}`);
      if(attempt===retries) throw e;
      await new Promise(r=>setTimeout(r, delayMs*attempt));
    }
  }
}

/* ============================== BYBIT DATA ============================== */
async function fetchKlines(symbol, interval, limit){
  const bybitInterval = INTERVAL_MAP[interval];
  if(!bybitInterval) throw new Error(`Unsupported interval: ${interval}`);

  const url = `${BYBIT_PROXY}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
  const raw = await fetchJSONWithRetry(url);

  if(!raw || raw.retCode !== 0 || !raw.result || !Array.isArray(raw.result.list)){
    throw new Error(`fetchKlines: unexpected response for ${symbol} ${interval}\nMessage: ${raw && raw.retMsg}`);
  }

  // Bybit returns newest → oldest. We need oldest → newest.
  const list = raw.result.list.slice().reverse();

  const minutes = parseInt(bybitInterval, 10) || 5;
  return list.map(k => {
    const openTime = parseInt(k[0], 10);
    return {
      openTime,
      open:  +k[1],
      high:  +k[2],
      low:   +k[3],
      close: +k[4],
      volume:+k[5],
      closeTime: openTime + minutes * 60 * 1000,
    };
  }).filter(c => c.close > 0);
}

const FALLBACK_SYMBOL_LIST = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT',
  'AVAXUSDT','LINKUSDT','DOTUSDT','MATICUSDT','LTCUSDT','TRXUSDT','SHIBUSDT',
  'ATOMUSDT','NEARUSDT','UNIUSDT','APTUSDT','FILUSDT','ARBUSDT','OPUSDT',
  'SUIUSDT','SEIUSDT','TIAUSDT','INJUSDT','WIFUSDT','PEPEUSDT','BONKUSDT',
];

async function fetchPerpetualSymbols(){
  try{
    // Paginate instruments-info (Bybit returns max 1000 per page)
    let symbols = [];
    let cursor = '';
    do {
      let url = `${BYBIT_PROXY}/v5/market/instruments-info?category=linear&limit=1000`;
      if(cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const data = await fetchJSONWithRetry(url);
      if(!data || data.retCode !== 0 || !data.result || !Array.isArray(data.result.list)){
        throw new Error('unexpected instruments response: ' + (data && data.retMsg));
      }

      const page = data.result.list
        .filter(s =>
          s.contractType === 'LinearPerpetual' &&
          s.quoteCoin === 'USDT' &&
          s.status === 'Trading' &&
          s.symbol && s.symbol.endsWith('USDT')
        )
        .map(s => s.symbol);

      symbols = symbols.concat(page);
      cursor = data.result.nextPageCursor || '';
    } while(cursor);

    symbols = [...new Set(symbols)].sort();
    if(symbols.length === 0) throw new Error('parsed 0 symbols');
    console.log(`[scanner] Discovered ${symbols.length} USDT linear perpetuals via Bybit`);
    return symbols;
  }catch(err){
    console.log(`[scanner] fetchPerpetualSymbols failed (${err.message}), using fallback list of ${FALLBACK_SYMBOL_LIST.length}`);
    return FALLBACK_SYMBOL_LIST.slice().sort();
  }
}

/* ============================== INDICATORS ============================== */
function calcEMA(values, period){
  const out = new Array(values.length).fill(null);
  if(values.length<period) return out;
  const k=2/(period+1);
  let sum=0;
  for(let i=0;i<period;i++) sum+=values[i];
  out[period-1]=sum/period;
  for(let i=period;i<values.length;i++) out[i]=values[i]*k+out[i-1]*(1-k);
  return out;
}

function calcRSI(closes, period){
  const out=new Array(closes.length).fill(null);
  if(closes.length<=period) return out;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){
    const d=closes[i]-closes[i-1];
    if(d>=0) gain+=d; else loss-=d;
  }
  let ag=gain/period, al=loss/period;
  out[period]=al===0?100:100-100/(1+ag/al);
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    const g=d>0?d:0,l=d<0?-d:0;
    ag=(ag*(period-1)+g)/period;
    al=(al*(period-1)+l)/period;
    out[i]=al===0?100:100-100/(1+ag/al);
  }
  return out;
}

function findCrosses(fast,slow){
  const crosses=[];
  for(let i=1;i<fast.length;i++){
    if(fast[i-1]==null||slow[i-1]==null||fast[i]==null||slow[i]==null) continue;
    const pd=fast[i-1]-slow[i-1], cd=fast[i]-slow[i];
    if(pd===0) continue;
    if((pd<0&&cd>0)||(pd>0&&cd<0)) crosses.push({index:i,dir:cd>0?'bull':'bear'});
  }
  return crosses;
}

function isClosed(c){ return c.closeTime < Date.now(); }

/* ============================== STRATEGY PIPELINE ============================== */
function buildCandidate(symbol, candles, method, m3MaxDist){
  const closes=candles.map(c=>c.close);
  const ema50 =calcEMA(closes,EMA_FAST);
  const ema100=calcEMA(closes,EMA_MID);
  const ema200=calcEMA(closes,EMA_SLOW);
  const rsi   =calcRSI(closes,RSI_PERIOD);
  const ind={ema50,ema100,ema200,rsi};

  // M1
  const m1Crosses=findCrosses(ema50,ema200).filter(c=>isClosed(candles[c.index]));
  if(!m1Crosses.length) return {stage:'no_m1'};
  const m1Index=m1Crosses[m1Crosses.length-1].index;

  // R1
  let r1Index=-1;
  for(let i=m1Index-1;i>=0;i--){
    if(rsi[i]!=null&&rsi[i]>RSI_OB){r1Index=i;break;}
  }
  if(r1Index===-1) return {stage:'no_r1'};

  // M2
  let m2Index=-1;
  for(let i=m1Index+1;i<=Math.min(m1Index+M1_M2_MAX_BARS,candles.length-1);i++){
    const pdA=ema50[i-1]-ema200[i-1],cdA=ema50[i]-ema200[i];
    if(ema50[i-1]!=null&&ema200[i-1]!=null&&ema50[i]!=null&&ema200[i]!=null&&pdA!==0&&((pdA<0&&cdA>0)||(pdA>0&&cdA<0)))
      return {stage:'invalidated'};
    const pdB=ema200[i-1]-ema100[i-1],cdB=ema200[i]-ema100[i];
    if(ema200[i-1]!=null&&ema100[i-1]!=null&&ema200[i]!=null&&ema100[i]!=null&&pdB!==0&&((pdB<0&&cdB>0)||(pdB>0&&cdB<0))){
      m2Index=i;break;
    }
  }
  if(m2Index===-1) return {stage:'no_m2'};

  // Method 3 early filter
  if(method==='3'){
    const dist=m2Index-m1Index;
    if(dist>m3MaxDist) return {stage:'m3_distance_fail',dist,max:m3MaxDist};
  }

  // T — first closed candle after M2 with ascending EMA200 touch
  let tIndex=-1;
  for(let i=m2Index+1;i<candles.length;i++){
    if(!isClosed(candles[i])) break;
    if(ema200[i]==null||ema200[i-1]==null) continue;
    const touches=candles[i].low<=ema200[i]&&candles[i].high>=ema200[i];
    if(!touches) continue;
    if(candles[i-1].close<ema200[i-1]){tIndex=i;break;}
  }
  if(tIndex===-1) return {stage:'no_t'};

  return {stage:'has_t',r1Index,m1Index,m2Index,tIndex,ind,candles,symbol};
}

async function confirm4h(symbol, tTimeMs){
  const c4=await fetchKlines(symbol,'4h',CONFIRM_LIMIT);
  const ema50_4h=calcEMA(c4.map(c=>c.close),EMA_FAST);
  for(let i=0;i<c4.length;i++){
    if(tTimeMs>=c4[i].openTime&&tTimeMs<c4[i].closeTime){
      if(ema50_4h[i]==null) return {ok:false};
      return {ok:c4[i].low<=ema50_4h[i]&&c4[i].high>=ema50_4h[i]};
    }
  }
  return {ok:false};
}

function computeFib(candles,r1Index,m1Index,tIndex){
  let p1=-Infinity,p1i=r1Index;
  for(let i=r1Index;i<=m1Index;i++) if(candles[i].high>p1){p1=candles[i].high;p1i=i;}
  let p2=Infinity,p2i=r1Index;
  for(let i=r1Index;i<=tIndex;i++) if(candles[i].low<p2){p2=candles[i].low;p2i=i;}
  const range=p1-p2;
  return {
    price1:p1,price1Idx:p1i,price2:p2,price2Idx:p2i,
    fib50:p1-range*FIB_LEVELS.entryHigh,
    fib618:p1-range*FIB_LEVELS.entryLow,
    fib786:p1-range*FIB_LEVELS.sl,
  };
}

function findEMA100Touch(candles,ema100,fromIndex){
  for(let i=fromIndex+1;i<candles.length;i++){
    if(!isClosed(candles[i])) break;
    if(ema100[i]==null) continue;
    if(candles[i].low<=ema100[i]&&candles[i].high>=ema100[i]) return i;
  }
  return -1;
}

async function processSymbol(symbol, tf, method){
  try{
    const candles=await fetchKlines(symbol,tf,DEEP_LIMIT);
    if(candles.length<EMA_SLOW+20) return null;

    const cand=buildCandidate(symbol,candles,method,M3_MAX_DISTANCE);
    if(cand.stage!=='has_t') return null;

    const tTimeMs=candles[cand.tIndex].openTime;
    const require4h=method==='3'?M3_REQUIRE_4H_T:true;
    const conf=await confirm4h(symbol,tTimeMs);
    if(!conf.ok&&!(method==='3'&&!require4h)) return null;

    const fib=computeFib(candles,cand.r1Index,cand.m1Index,cand.tIndex);
    const ema200AtT=cand.ind.ema200[cand.tIndex];
    if(ema200AtT==null||!(fib.fib618>ema200AtT)) return null;

    // Entry tracking
    let entryIndex=-1,slIndex=-1;
    for(let i=cand.tIndex+1;i<candles.length;i++){
      if(!isClosed(candles[i])) break;
      if(candles[i].low<=fib.fib50&&candles[i].high>=fib.fib50){entryIndex=i;break;}
    }
    if(entryIndex>=0){
      for(let i=entryIndex+1;i<candles.length;i++){
        if(!isClosed(candles[i])) break;
        if(candles[i].low<=fib.fib786){slIndex=i;break;}
      }
    }

    // Method 3 extra: 100T + M3 Fib
    let m3_100TIndex=-1,m3Fib=null;
    const m3Dist=cand.m2Index-cand.m1Index;
    if(method==='3'){
      const p1i=fib.price1Idx,p2i=fib.price2Idx;
      if(!(p1i<p2i&&p2i<cand.m1Index&&cand.m1Index<cand.m2Index)) return null;
      m3_100TIndex=findEMA100Touch(candles,cand.ind.ema100,cand.m2Index);
      if(m3_100TIndex<0) return null;
      let fibHigh=-Infinity,fibHighIdx=-1;
      for(let i=p2i;i<=m3_100TIndex;i++){
        if(candles[i].high>fibHigh){fibHigh=candles[i].high;fibHighIdx=i;}
      }
      if(fibHighIdx<cand.m1Index||fibHigh<=candles[p2i].low) return null;
      const p2Price=candles[p2i].low,range2=fibHigh-p2Price;
      m3Fib={price1:p2Price,price1Idx:p2i,price2:fibHigh,price2Idx:fibHighIdx,
              fib50:fibHigh-range2*0.5,fib618:fibHigh-range2*0.618,fib786:fibHigh-range2*0.786};
    }

    return {
      symbol,tf,method,
      r1Time:candles[cand.r1Index].openTime,
      m1Time:candles[cand.m1Index].openTime,
      m2Time:candles[cand.m2Index].openTime,
      tTime: candles[cand.tIndex].openTime,
      entryTime:entryIndex>=0?candles[entryIndex].openTime:null,
      slTime:slIndex>=0?candles[slIndex].openTime:null,
      price1:fib.price1, price2:fib.price2,
      fib50:fib.fib50, fib618:fib.fib618, fib786:fib.fib786,
      ema200AtT,
      m3Dist,
      m3_100TTime:m3_100TIndex>=0?candles[m3_100TIndex].openTime:null,
      m3Fib,
      scannedAt: Date.now(),
    };
  }catch(e){
    console.warn(`[process] ${symbol} ${tf}: ${e.message.split('\n')[0]}`);
    return null;
  }
}

async function scanSymbols(symbols, tf, method){
  const results = [];
  let idx = 0;

  async function worker(){
    while(idx < symbols.length){
      const i = idx++;
      const sig = await processSymbol(symbols[i], tf, method);
      if(sig) results.push(sig);
    }
  }

  await Promise.all(Array.from({length: SCAN_CONCURRENCY}, worker));
  return results;
}

/* ============================== STATE ============================== */
function loadState(){
  try{
    if(fs.existsSync(STATE_FILE)){
      return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    }
  }catch(e){}
  return { signals: {} };
}

function saveState(state){
  try{
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }catch(e){
    console.warn('[state] Could not save state:', e.message);
  }
}

/* ============================== EMAIL ============================== */
function fmtTime(ms){
  if(!ms) return '—';
  return new Date(ms).toLocaleString('en-GB', { timeZone:'UTC', dateStyle:'medium', timeStyle:'short' }) + ' UTC';
}
function fmtPrice(p){
  if(p==null) return '—';
  return Number(p).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:8 });
}

function buildEmailHtml(sig){
  const m3section = sig.m3Fib ? `
    <tr><td colspan="2" style="padding:10px 0 4px;font-weight:700;color:#f0b429;font-size:12px;">METHOD 3 FIB</td></tr>
    <tr><td>M3 Fib 0.5</td><td>${fmtPrice(sig.m3Fib.fib50)}</td></tr>
    <tr><td>M3 Fib 0.618</td><td>${fmtPrice(sig.m3Fib.fib618)}</td></tr>
  ` : '';

  let entryBlock = '';
  if(sig.entryTime){
    entryBlock = `<tr><td style="color:#3dd68c;">ENTRY TRIGGERED</td><td>${fmtTime(sig.entryTime)}</td></tr>`;
  } else {
    entryBlock = `<tr><td colspan="2" style="color:#8892a4;">Status: Awaiting return to Fib 0.5</td></tr>`;
  }

  let slBlock = '';
  if(sig.slTime){
    slBlock = `<tr><td style="color:#f6465d;">SL HIT</td><td>${fmtTime(sig.slTime)}</td></tr>`;
  }

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0c11;font-family:system-ui,sans-serif;">
  <div style="max-width:480px;margin:24px auto;background:#12151d;border-radius:12px;overflow:hidden;border:1px solid #242a38;">
    <div style="background:#1a1f2b;padding:16px 20px;border-bottom:1px solid #242a38;">
      <div style="font-size:18px;font-weight:700;color:#e8eaed;">🚨 ${sig.symbol} ${sig.tf.toUpperCase()}</div>
      <div style="font-size:13px;color:#8892a4;margin-top:4px;">New Signal · Method ${sig.method}</div>
    </div>
    <div style="padding:16px 20px;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#c9d1d9;">
        <tr><td style="padding:4px 0;color:#8892a4;">R1</td><td>${fmtTime(sig.r1Time)}</td></tr>
        <tr><td style="padding:4px 0;color:#8892a4;">M1</td><td>${fmtTime(sig.m1Time)}</td></tr>
        <tr><td style="padding:4px 0;color:#8892a4;">M2</td><td>${fmtTime(sig.m2Time)}</td></tr>
        <tr><td style="padding:4px 0;color:#8892a4;">T (EMA200 Touch)</td><td>${fmtTime(sig.tTime)}</td></tr>
        <tr><td colspan="2" style="padding:10px 0 4px;font-weight:700;color:#f0b429;font-size:12px;">FIBONACCI (Base)</td></tr>
        <tr><td>Price 1</td><td>${fmtPrice(sig.price1)}</td></tr>
        <tr><td>Price 2</td><td>${fmtPrice(sig.price2)}</td></tr>
        <tr><td>Fib 0.5 <small style="color:#565f73">(entry)</small></td><td>${fmtPrice(sig.fib50)}</td></tr>
        <tr><td>Fib 0.382</td><td>${fmtPrice(sig.fib618)}</td></tr>
        <tr><td>Fib 0.618 <small style="color:#565f73">(SL)</small></td><td>${fmtPrice(sig.fib786)}</td></tr>
        <tr><td>EMA200 @ T</td><td>${fmtPrice(sig.ema200AtT)}</td></tr>
        ${m3section}
        <tr><td colspan="2" style="padding:10px 0 4px;border-top:1px solid #242a38;"></td></tr>
        ${entryBlock}
        ${slBlock}
      </table>
    </div>
    <div style="padding:12px 20px;font-size:11px;color:#565f73;border-top:1px solid #242a38;">
      Scanned ${fmtTime(sig.scannedAt)} · Bybit USDT Perpetual · Not financial advice
    </div>
  </div></body></html>`;
}

async function sendAlert(sig){
  const user     = process.env.GMAIL_USER;
  const pass     = process.env.GMAIL_APP_PASS;
  const to       = process.env.ALERT_EMAIL || user;
  if(!user||!pass){ console.log('[email] Skipped — GMAIL_USER / GMAIL_APP_PASS not configured'); return; }

  const transporter = nodemailer.createTransport({
    service:'gmail',
    auth:{user,pass},
  });

  const subject = `🚨 ${sig.symbol} ${sig.tf.toUpperCase()} — New Signal (Method ${sig.method})`;
  await transporter.sendMail({
    from:`"Signal Scanner" <${user}>`,
    to,
    subject,
    html: buildEmailHtml(sig),
  });
  console.log(`[email] Alert sent → ${to} for ${sig.symbol} ${sig.tf}`);
}

/* ============================== MAIN ============================== */
async function main(){
  const dryRun = process.argv.includes('--dry-run');
  const now = new Date();
  const tfsToScan = getTimeframesToScan();
  console.log(`[${now.toISOString()}] Timeframes to scan this run: ${tfsToScan.join(', ')}`);
  console.log(`[scanner] Using Bybit proxy: ${BYBIT_PROXY}`);

  if(BYBIT_PROXY.includes('YOUR-WORKER')){
    console.error('[scanner] ERROR: You must set BYBIT_PROXY to your Cloudflare Worker URL!');
    console.error('          Either edit scanner.js or set the BYBIT_PROXY environment variable / GitHub secret.');
    process.exit(1);
  }

  const method = process.env.STRATEGY_METHOD || '3';
  const state = loadState();
  let newSignals = 0;

  try{
    const symbols = await fetchPerpetualSymbols();
    console.log(`[scanner] ${symbols.length} symbols · method=${method}`);

    for(const tf of tfsToScan){
      console.log(`[scanner] Scanning ${tf}…`);
      const signals = await scanSymbols(symbols, tf, method);
      console.log(`[scanner] ${tf}: ${signals.length} confirmed signal(s)`);

      for(const sig of signals){
        const key = `${sig.symbol}_${tf}_${method}`;
        const prev = state.signals[key];

        const isNew = !prev;
        const entryChanged = prev && !prev.entryTime && sig.entryTime;
        const slChanged    = prev && !prev.slTime && sig.slTime;

        if(isNew||entryChanged||slChanged){
          const reason = isNew?'NEW SIGNAL':entryChanged?'ENTRY TRIGGERED':'SL HIT';
          console.log(`[signal] ${reason}: ${sig.symbol} ${tf}`);
          newSignals++;
          if(!dryRun) await sendAlert(sig).catch(e=>console.error('[email] Error:',e.message));
        }

        state.signals[key] = {
          entryTime: sig.entryTime,
          slTime:    sig.slTime,
          scannedAt: sig.scannedAt,
        };
      }

      const cutoff = Date.now() - 7*24*60*60*1000;
      for(const k of Object.keys(state.signals)){
        if((state.signals[k].scannedAt||0) < cutoff) delete state.signals[k];
      }
    }
  }catch(e){
    console.error('[scanner] Fatal error:', e.message);
    process.exit(1);
  }

  saveState(state);
  console.log(`[done] ${newSignals} new alert(s) sent`);
}

main();
