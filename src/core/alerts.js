/**
 * Core alert logic.
 *
 * Alert creation uses the pricealerts.tradingview.com REST API directly
 * (discovered via live network sniffing). The endpoint accepts a JSON body
 * wrapped in { payload: {...} } and uses cookie auth via credentials:'include'.
 * Content-Type is omitted so the browser defaults to text/plain (CORS-safe).
 */
import { evaluate, evaluateAsync } from '../connection.js';

// Map user-facing condition names to TradingView's internal condition types.
// TV's conditions array expects an object per condition; for a simple price
// level, `series` is [{type:'barset'}, {type:'value', value: <price>}].
function buildConditions(condition, price, resolution) {
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum)) throw new Error('price must be a finite number');

  const series = [{ type: 'barset' }, { type: 'value', value: priceNum }];
  const c = String(condition || 'crossing').toLowerCase();

  // crossing / cross / crosses → "cross" with cross_interval:true (crosses either direction)
  if (/^cross/.test(c)) {
    return [{ type: 'cross', frequency: 'on_first_fire', series, resolution }];
  }
  // greater_than / greater / above / >
  if (/^(greater|above|>)/.test(c)) {
    return [{ type: 'greater', frequency: 'on_first_fire', series, resolution }];
  }
  // less_than / less / below / <
  if (/^(less|below|<)/.test(c)) {
    return [{ type: 'less', frequency: 'on_first_fire', series, resolution }];
  }
  // crossing_up / cross_up → cross with cross_interval:false + direction
  if (/cross.*up|up.*cross/.test(c)) {
    return [{ type: 'cross-up', frequency: 'on_first_fire', series, resolution }];
  }
  if (/cross.*down|down.*cross/.test(c)) {
    return [{ type: 'cross-down', frequency: 'on_first_fire', series, resolution }];
  }
  // entering / inside
  if (/^(enter|inside)/.test(c)) {
    return [{ type: 'enter', frequency: 'on_first_fire', series, resolution }];
  }
  // exiting / outside
  if (/^(exit|outside)/.test(c)) {
    return [{ type: 'exit', frequency: 'on_first_fire', series, resolution }];
  }
  // Default: crossing
  return [{ type: 'cross', frequency: 'on_first_fire', series, resolution }];
}

export async function create({ condition, price, message }) {
  if (price === undefined || price === null) throw new Error('price is required');

  // Pull current chart symbol + resolution so the alert is tied to what the user sees.
  const chartInfo = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
        if (!chart) return { error: 'no active chart' };
        return { symbol: chart.symbol(), resolution: chart.resolution() };
      } catch(e) { return { error: e.message }; }
    })()
  `);

  if (!chartInfo || chartInfo.error) {
    throw new Error('Could not read chart state: ' + (chartInfo?.error || 'unknown'));
  }

  const symbol = chartInfo.symbol;
  const resolution = chartInfo.resolution || '1';
  // TradingView's symbol format in alerts is `=JSON(symbolinfo)` — pass minimal,
  // the server fills in adjustment/currency-id/etc. automatically.
  const symbolParam = '=' + JSON.stringify({ symbol, session: 'regular' });

  const conditions = buildConditions(condition, price, resolution);
  const defaultMessage = message || `${symbol} ${condition || 'crossing'} ${price}`;

  // Expiration: 30 days out (matches TV's default).
  const expiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const payload = {
    symbol: symbolParam,
    resolution,
    message: defaultMessage,
    sound_file: null,
    sound_duration: 0,
    popup: true,
    expiration,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: true,
    web_hook: null,
    name: null,
    conditions,
    active: true,
  };

  // POST to the TV REST API. Note: no Content-Type header → browser uses text/plain
  // which is CORS-safe (same-origin cookie auth works, no preflight).
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(JSON.stringify({ payload }))}
    })
    .then(function(r) { return r.json().then(function(data) { return { status: r.status, data: data }; }); })
    .catch(function(e) { return { error: e.message }; })
  `);

  if (!result || result.error) {
    return { success: false, error: result?.error || 'no response', source: 'rest_api' };
  }

  if (result.data && result.data.s === 'ok') {
    const created = result.data.r || {};
    return {
      success: true,
      alert_id: created.alert_id,
      symbol,
      resolution,
      price: Number(price),
      condition: conditions[0].type,
      message: defaultMessage,
      source: 'rest_api',
    };
  }

  return {
    success: false,
    error: result.data?.errmsg || result.data?.err?.code || 'create failed',
    status: result.status,
    response: result.data,
    source: 'rest_api',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
