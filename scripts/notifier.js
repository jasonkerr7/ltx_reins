#!/usr/bin/env node
/**
 * Standalone Telegram alert notifier for BTC / Gold / GBPUSD.
 *
 * Polls free public price APIs (Yahoo Finance) every POLL_SECONDS, compares
 * to alert levels in notifier_alerts.json, and sends a Telegram message when
 * price crosses any level.
 *
 * Setup:
 *   1. Create a Telegram bot via @BotFather → save the bot token
 *   2. Send /start to your bot, then visit
 *      https://api.telegram.org/bot<TOKEN>/getUpdates → save the chat.id
 *   3. Export env vars:
 *        export TG_BOT_TOKEN="123:ABC..."
 *        export TG_CHAT_ID="12345678"
 *   4. Edit notifier_alerts.json to set your levels
 *   5. Run: node scripts/notifier.js
 *
 * Price sources (all public, no auth):
 *   - Yahoo Finance chart endpoint — works for BTC-USD, GBPUSD=X, GC=F (gold futures)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = path.join(__dirname, 'notifier_alerts.json');
const STATE_FILE  = path.join(__dirname, 'notifier_state.json');

const POLL_SECONDS = 60;

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('ERROR: set TG_BOT_TOKEN and TG_CHAT_ID environment variables.');
  console.error('See header comment in this file for setup steps.');
  process.exit(1);
}

// Yahoo Finance symbol mapping for our 3 markets
const SYMBOLS = {
  BTC:    { yahoo: 'BTC-USD',  display: 'BTC/USD',    decimals: 0 },
  GOLD:   { yahoo: 'GC=F',     display: 'Gold (XAU)', decimals: 2 },
  GBPUSD: { yahoo: 'GBPUSD=X', display: 'GBP/USD',    decimals: 5 },
};

async function fetchYahooPrice(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; alert-notifier/1.0)' },
  });
  if (!r.ok) throw new Error(`Yahoo ${yahooSymbol} HTTP ${r.status}`);
  const data = await r.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo ${yahooSymbol} no meta`);
  return Number(meta.regularMarketPrice);
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
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

function fmtPrice(price, decimals) {
  return price.toFixed(decimals);
}

// Crossing detection: detect when price transitions across the level in
// either direction between two consecutive polls. Only fires on actual cross,
// not on continuous price on one side.
function crossed(prevPrice, currPrice, level) {
  if (prevPrice == null) return false;
  if (prevPrice <= level && currPrice > level) return 'up';
  if (prevPrice >= level && currPrice < level) return 'down';
  return false;
}

async function pollOnce(alerts, state) {
  for (const market of Object.keys(SYMBOLS)) {
    const cfg = SYMBOLS[market];
    const marketAlerts = alerts[market] || [];
    if (marketAlerts.length === 0) continue;

    let currPrice;
    try {
      currPrice = await fetchYahooPrice(cfg.yahoo);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${market} fetch failed:`, err.message);
      continue;
    }

    const prevPrice = state.lastPrice?.[market];
    state.lastPrice = state.lastPrice || {};
    state.lastPrice[market] = currPrice;

    for (const alert of marketAlerts) {
      if (state.fired?.[alert.id]) continue; // already fired this alert

      const direction = crossed(prevPrice, currPrice, alert.level);
      if (!direction) continue;

      // Directional filter: alert.direction is 'up', 'down', or 'any'
      if (alert.direction && alert.direction !== 'any' && alert.direction !== direction) continue;

      // Fire the alert
      const msg = [
        `🔔 *${cfg.display} alert*`,
        ``,
        `*${alert.label}*`,
        `Price crossed *${direction === 'up' ? '↑' : '↓'}* ${fmtPrice(alert.level, cfg.decimals)}`,
        `Current: *${fmtPrice(currPrice, cfg.decimals)}*`,
        ``,
        alert.note || '',
      ].filter(Boolean).join('\n');

      console.log(`[${new Date().toISOString()}] FIRED: ${market} ${alert.id} — ${alert.label}`);
      await sendTelegram(msg);

      state.fired = state.fired || {};
      state.fired[alert.id] = {
        firedAt: new Date().toISOString(),
        price: currPrice,
        direction,
      };
    }
  }
  saveJson(STATE_FILE, state);
}

async function main() {
  // Write example alerts file if missing
  if (!fs.existsSync(ALERTS_FILE)) {
    const example = {
      BTC: [
        { id: 'btc_long_pullback', level: 73780, direction: 'down',
          label: 'BTC LONG — pullback entry',
          note: 'Entry 73780, stop 73400, T1 74500, T2 75000' },
      ],
      GOLD: [
        { id: 'gold_long_pullback', level: 4790, direction: 'down',
          label: 'GOLD LONG — pullback entry',
          note: 'Entry 4790, stop 4770, T1 4810, T2 4830' },
      ],
      GBPUSD: [
        { id: 'gbpusd_long_pullback', level: 1.35646, direction: 'down',
          label: 'GBPUSD LONG — pullback entry',
          note: 'Entry 1.35646, stop 1.35400, T1 1.36000, T2 1.36300' },
      ],
    };
    saveJson(ALERTS_FILE, example);
    console.log(`Wrote example alerts to ${ALERTS_FILE}. Edit and restart.`);
  }

  const alerts = loadJson(ALERTS_FILE, {});
  const state  = loadJson(STATE_FILE, { lastPrice: {}, fired: {} });

  console.log(`[${new Date().toISOString()}] Notifier started. Polling every ${POLL_SECONDS}s.`);
  console.log(`Markets: ${Object.keys(SYMBOLS).join(', ')}`);
  console.log(`Active alerts: ${Object.values(alerts).flat().filter(a => !state.fired?.[a.id]).length}`);

  // Startup ping so you know Telegram works
  await sendTelegram(`✅ Alert notifier online. Watching BTC / Gold / GBPUSD every ${POLL_SECONDS}s.`);

  // Polling loop
  while (true) {
    try {
      await pollOnce(alerts, state);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] poll error:`, err);
    }
    await new Promise(r => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
