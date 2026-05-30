// Cloudflare Worker：StockWatch 數據代理
// 把它整段貼到 Cloudflare Worker 編輯器並 Deploy。
//
// 資料來源：Yahoo Finance chart API（免金鑰、全球可存取）。
//   為什麼不用 stooq / TWSE？
//     - stooq 的每日歷史端點現在需要 apikey，且免費報價對台股回傳 N/D。
//     - TWSE 官方端點會擋 Cloudflare 機房 IP：大盤指數可通，但個股
//       STOCK_DAY 從 Worker 呼叫一律回空資料（本機可通、Worker 不行）。
//   Yahoo Finance 對 ^TWII（加權指數）、2330.TW、0050.TW 都能穩定回傳。
//
// 前端契約維持不變：POST { type: 'stooq', sym }，回傳 { csv }，
//   CSV 格式為 "Date,Open,High,Low,Close,Volume"，日期 YYYY-MM-DD，最舊在前。
//   sym = '^taiex' → 加權指數（Yahoo: ^TWII）
//   sym = '2330.tw' / '0050.tw' → 個股 / ETF（Yahoo: 2330.TW / 0050.TW）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    try {
      const body = await request.json().catch(() => ({}));
      const sym = String(body.sym || '').toLowerCase().trim();
      const range = ['1mo', '3mo', '6mo', '1y', '2y'].includes(body.range) ? body.range : '6mo';

      const yahooSym = toYahooSymbol(sym);
      if (!yahooSym) return json({ csv: '', error: 'unsupported sym: ' + sym });

      const rows = await fetchYahoo(yahooSym, range);
      const header = 'Date,Open,High,Low,Close,Volume';
      const csv = header + '\n' + rows.map(r => r.join(',')).join('\n');
      return json({ csv, count: rows.length });
    } catch (e) {
      return json({ csv: '', error: String((e && e.message) || e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// 前端 sym → Yahoo Finance symbol
function toYahooSymbol(sym) {
  if (sym === '^taiex' || sym === 'taiex' || sym === '^twii') return '^TWII';
  if (sym.endsWith('.tw')) {
    const code = sym.replace('.tw', '').replace(/[^0-9a-z]/gi, '');
    if (!code) return null;
    return code.toUpperCase() + '.TW';
  }
  return null;
}

function round2(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}

async function fetchYahoo(yahooSym, range) {
  // query1 為主，query2 備援；Yahoo 偶爾單一節點 429。
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr = null;
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=1d`;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (!r.ok) { lastErr = 'http ' + r.status; continue; }
      const j = await r.json();
      const result = j && j.chart && j.chart.result && j.chart.result[0];
      if (!result || !Array.isArray(result.timestamp)) { lastErr = 'no result'; continue; }
      const ts = result.timestamp;
      const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        const close = round2(q.close ? q.close[i] : null);
        if (close === null) continue; // 跳過停牌 / 無資料日
        const iso = new Date(ts[i] * 1000).toISOString().slice(0, 10);
        rows.push([
          iso,
          round2(q.open ? q.open[i] : null) ?? close,
          round2(q.high ? q.high[i] : null) ?? close,
          round2(q.low ? q.low[i] : null) ?? close,
          close,
          (q.volume && q.volume[i] != null) ? Math.round(q.volume[i]) : 0,
        ]);
      }
      if (rows.length) return rows; // 拿到資料就回傳
      lastErr = 'empty';
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  throw new Error('yahoo fetch failed: ' + lastErr);
}
