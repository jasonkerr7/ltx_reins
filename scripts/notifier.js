#!/usr/bin/env node
/**
 * Smart Telegram alert notifier — 4H close with indicator & structure confirmation.
 *
 * Fires when ALL of:
 *   1. A new 4H bar has closed since last poll,
 *   2. The 4H close crossed the alert's level in the configured direction,
 *   3. Per-market indicator confirmation matches the trade side (long/short),
 *   4. Prior swing high (shorts) / swing low (longs) has not been broken.
 *
 * Side "warning" bypasses checks (2) fires only, (3) and (4) are skipped — used for
 * invalidation-style pings.
 *
 * Data: Yahoo Finance chart API (public, no auth). Indicators computed client-side.
 *
 * Caveat: state (lastClose, fired) is file-based and resets on DO App Platform
 * redeploy. On boot, lastClose is seeded from the current latest completed bar so
 * we don't retroactively re-fire old crosses. `fired` may re-fire an alert once
 * across a redeploy if its conditions happen to cross again.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = path.join(__dirname, 'notifier_alerts.json');
const STATE_FILE  = path.join(__dirname, 'notifier_state.json');

const POLL_SECONDS = 60;
const TF = '4h';
const TF_MS = 4 * 60 * 60 * 1000;
const SWING_LOOKBACK = 10;

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('ERROR: set TG_BOT_TOKEN and TG_CHAT_ID environment variables.');
  process.exit(1);
}

const MARKETS = {
  BTC: {
    yahoo: 'BTC-USD', display: 'BTC/USD', decimals: 0,
    long_confirm:  { rsi_min: 50, ema_side: 'above' },
    short_confirm: { rsi_max: 50, ema_side: 'below' },
  },
  GOLD: {
    yahoo: 'GC=F', display: 'Gold (XAU)', decimals: 2,
    long_confirm:  { rsi_min: 45, bb_touch: 'lower' },
    short_confirm: { rsi_max: 55, bb_touch: 'upper' },
  },
  GBPUSD: {
    yahoo: 'GBPUSD=X', display: 'GBP/USD', decimals: 5,
    long_confirm:  { rsi_min: 50, ema_side: 'above' },
    short_confirm: { rsi_max: 50, ema_side: 'below' },
  },
  EURUSD: {
    yahoo: 'EURUSD=X', display: 'EUR/USD', decimals: 5,
    long_confirm:  { rsi_min: 50, ema_side: 'above' },
    short_confirm: { rsi_max: 50, ema_side: 'below' },
  },
};

async function fetchBars(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${TF}&range=60d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; alert-notifier/2.0)' } });
  if (!r.ok) throw new Error(`Yahoo ${yahooSymbol} HTTP ${r.status}`);
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${yahooSymbol} no result`);
  const ts = result.timestamp || [];
  const q = result.indicators.quote[0];
  return ts
    .map((t, i) => ({
      t: t * 1000,
      open:  q.open[i],
      high:  q.high[i],
      low:   q.low[i],
      close: q.close[i],
    }))
    .filter(b => b.close != null && b.high != null && b.low != null);
}

function ema(values, n) {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  const out = new Array(values.length);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) {
    e = (values[i] - e) * k + e;
    out[i] = e;
  }
  return out;
}

function rsi(closes, n) {
  if (closes.length < n + 1) return [];
  const out = new Array(closes.length);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum += -d;
  }
  let avgGain = gainSum / n;
  let avgLoss = lossSum / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function bollinger(closes, n, mult) {
  const mid = new Array(closes.length);
  const upper = new Array(closes.length);
  const lower = new Array(closes.length);
  for (let i = n - 1; i < closes.length; i++) {
    const window = closes.slice(i - n + 1, i + 1);
    const m = window.reduce((a, b) => a + b, 0) / n;
    const variance = window.reduce((a, b) => a + (b - m) ** 2, 0) / n;
    const sd = Math.sqrt(variance);
    mid[i] = m;
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

function latestCompletedBarIndex(bars) {
  const now = Date.now();
  for (let i = bars.length - 1; i >= 0; i--) {
    if (now > bars[i].t + TF_MS) return i;
  }
  return -1;
}

function checkConfirm(confirm, { rsi: rsiVal, close, ema21, bb }, decimals) {
  if (confirm.rsi_min != null && !(rsiVal >= confirm.rsi_min))
    return { ok: false, reason: `RSI ${rsiVal.toFixed(1)} < ${confirm.rsi_min}` };
  if (confirm.rsi_max != null && !(rsiVal <= confirm.rsi_max))
    return { ok: false, reason: `RSI ${rsiVal.toFixed(1)} > ${confirm.rsi_max}` };
  if (confirm.ema_side === 'above' && !(close > ema21))
    return { ok: false, reason: `close ${close.toFixed(decimals)} below EMA21 ${ema21.toFixed(decimals)}` };
  if (confirm.ema_side === 'below' && !(close < ema21))
    return { ok: false, reason: `close ${close.toFixed(decimals)} above EMA21 ${ema21.toFixed(decimals)}` };
  if (confirm.bb_touch === 'lower' && !(close <= bb.lower))
    return { ok: false, reason: `close not at lower BB ${bb.lower.toFixed(decimals)}` };
  if (confirm.bb_touch === 'upper' && !(close >= bb.upper))
    return { ok: false, reason: `close not at upper BB ${bb.upper.toFixed(decimals)}` };
  return { ok: true };
}

async function evaluateMarket(marketKey, alerts, state) {
  const cfg = MARKETS[marketKey];
  const bars = await fetchBars(cfg.yahoo);
  if (bars.length < 30) throw new Error(`${marketKey}: not enough bars (${bars.length})`);

  const idx = latestCompletedBarIndex(bars);
  if (idx < 1) return;
  const bar = bars[idx];
  const prev = bars[idx - 1];

  state.lastClose = state.lastClose || {};
  if (state.lastClose[marketKey] === bar.t) return;
  state.lastClose[marketKey] = bar.t;

  const closes = bars.slice(0, idx + 1).map(b => b.close);
  const rsiArr = rsi(closes, 14);
  const emaArr = ema(closes, 21);
  const bb = bollinger(closes, 20, 2);

  const snapshot = {
    close: bar.close,
    rsi:   rsiArr[idx],
    ema21: emaArr[idx],
    bb:    { upper: bb.upper[idx], mid: bb.mid[idx], lower: bb.lower[idx] },
  };

  const swingBars = bars.slice(Math.max(0, idx - SWING_LOOKBACK), idx);
  const swingHigh = Math.max(...swingBars.map(b => b.high));
  const swingLow  = Math.min(...swingBars.map(b => b.low));

  console.log(`[${new Date().toISOString()}] ${marketKey} new 4H close=${snapshot.close} RSI=${snapshot.rsi.toFixed(1)} EMA21=${snapshot.ema21.toFixed(cfg.decimals)} swingH=${swingHigh} swingL=${swingLow}`);

  for (const alert of alerts) {
    if (state.fired?.[alert.id]) continue;

    const crossedUp   = prev.close <  alert.level && bar.close >= alert.level;
    const crossedDown = prev.close >  alert.level && bar.close <= alert.level;
    let crossDir = null;
    if (alert.direction === 'up'   && crossedUp)   crossDir = 'up';
    if (alert.direction === 'down' && crossedDown) crossDir = 'down';
    if (!crossDir) continue;

    const side = alert.side || (alert.direction === 'down' ? 'long' : 'short');

    let confirmNote = '';
    let invalidated = null;

    if (side !== 'warning') {
      const confirm = side === 'long' ? cfg.long_confirm : cfg.short_confirm;
      const { ok, reason } = checkConfirm(confirm, snapshot, cfg.decimals);
      if (!ok) {
        console.log(`[${new Date().toISOString()}] ${marketKey} ${alert.id}: cross but NOT confirmed — ${reason}`);
        continue;
      }
      if (side === 'long'  && bar.close < swingLow)  invalidated = `close ${bar.close} < swing low ${swingLow}`;
      if (side === 'short' && bar.close > swingHigh) invalidated = `close ${bar.close} > swing high ${swingHigh}`;
      if (invalidated) {
        console.log(`[${new Date().toISOString()}] ${marketKey} ${alert.id}: cross but structure invalidated — ${invalidated}`);
        continue;
      }
      confirmNote = [
        `RSI(14): ${snapshot.rsi.toFixed(1)}`,
        `EMA(21): ${snapshot.ema21.toFixed(cfg.decimals)}`,
        `BB: ${snapshot.bb.lower.toFixed(cfg.decimals)} / ${snapshot.bb.mid.toFixed(cfg.decimals)} / ${snapshot.bb.upper.toFixed(cfg.decimals)}`,
      ].join(' • ');
    }

    const header = side === 'warning'
      ? `⚠️ *${cfg.display} — WARNING*`
      : `🔔 *${cfg.display} — ${side.toUpperCase()}*`;
    const confirmLine = side === 'warning'
      ? ''
      : `✅ Confirmed: ${confirmNote}`;

    const msg = [
      header,
      ``,
      `*${alert.label}*`,
      `4H close *${bar.close.toFixed(cfg.decimals)}* crossed *${crossDir === 'up' ? '↑' : '↓'}* ${Number(alert.level).toFixed(cfg.decimals)}`,
      ``,
      confirmLine,
      confirmLine ? '' : null,
      alert.note || '',
    ].filter(l => l !== null && l !== '' ? true : l === '').join('\n');

    console.log(`[${new Date().toISOString()}] FIRED: ${marketKey} ${alert.id}`);
    await sendTelegram(msg);

    state.fired = state.fired || {};
    state.fired[alert.id] = {
      firedAt: new Date().toISOString(),
      close: bar.close,
      rsi: snapshot.rsi,
      ema21: snapshot.ema21,
    };
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
  if (!r.ok) {
    const body = await r.text();
    console.error(`Telegram send failed: ${r.status} ${body}`);
  }
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function seedLastCloseFromCurrentBars(state) {
  state.lastClose = state.lastClose || {};
  for (const market of Object.keys(MARKETS)) {
    try {
      const bars = await fetchBars(MARKETS[market].yahoo);
      const idx = latestCompletedBarIndex(bars);
      if (idx >= 0 && state.lastClose[market] == null) {
        state.lastClose[market] = bars[idx].t;
      }
    } catch (err) {
      console.error(`seed ${market}:`, err.message);
    }
  }
}

async function pollOnce(alertsByMarket, state) {
  for (const market of Object.keys(MARKETS)) {
    const alerts = alertsByMarket[market] || [];
    if (alerts.length === 0) continue;
    try {
      await evaluateMarket(market, alerts, state);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${market} poll error:`, err.message);
    }
  }
  saveJson(STATE_FILE, state);
}

async function main() {
  if (!fs.existsSync(ALERTS_FILE)) {
    console.error(`Missing ${ALERTS_FILE}`);
    process.exit(1);
  }
  const alertsByMarket = loadJson(ALERTS_FILE, {});
  const state = loadJson(STATE_FILE, { lastClose: {}, fired: {} });

  await seedLastCloseFromCurrentBars(state);
  saveJson(STATE_FILE, state);

  const totalAlerts = Object.values(alertsByMarket).flat().filter(a => !state.fired?.[a.id]).length;
  console.log(`[${new Date().toISOString()}] Smart notifier started. Evaluating on 4H close, poll ${POLL_SECONDS}s.`);
  console.log(`Markets: ${Object.keys(MARKETS).join(', ')} | Active alerts: ${totalAlerts}`);

  await sendTelegram(
    `✅ *Smart notifier online.*\n` +
    `4H close-based, with RSI/EMA/BB confirmation + swing-break invalidation.\n` +
    `Markets: ${Object.keys(MARKETS).join(', ')}\n` +
    `Active alerts: ${totalAlerts}`
  );

  while (true) {
    try { await pollOnce(alertsByMarket, state); }
    catch (err) { console.error(`poll error:`, err); }
    await new Promise(r => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
