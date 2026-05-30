// Cloudflare Worker：StockWatch 數據代理
// 把它整段貼到 Cloudflare Worker 編輯器並 Deploy。
//
// 為什麼不用 stooq？
//   stooq 的「每日歷史」下載端點（/q/d/l/）現在需要 apikey，
//   且 stooq 的免費即時報價對台股（^taiex、2330.tw）一律回傳 N/D。
//   因此改用台灣證券交易所 TWSE 官方公開資料（免金鑰、免費）。
//
// 前端契約維持不變：POST { type: 'stooq', sym }，回傳 { csv }，
//   CSV 格式為 "Date,Open,High,Low,Close,Volume"，日期為 YYYY-MM-DD，最舊在前。
//   sym = '^taiex' → 加權指數；sym = '2330.tw' / '0050.tw' → 個股/ETF。

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
      const months = Math.min(Math.max(parseInt(body.months, 10) || 4, 1), 12);

      let rows;
      if (sym === '^taiex' || sym === 'taiex') {
        rows = await fetchTaiex(months);
      } else if (sym.endsWith('.tw')) {
        const stockNo = sym.replace('.tw', '').replace(/\D/g, '');
        rows = await fetchStock(stockNo, months);
      } else {
        return json({ csv: '', error: 'unsupported sym: ' + sym });
      }

      const header = 'Date,Open,High,Low,Close,Volume';
      const csv = header + '\n' + rows.map(r => r.join(',')).join('\n');
      return json({ csv });
    } catch (e) {
      return json({ csv: '', error: String(e && e.message || e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// 取最近 n 個月（最舊在前），回傳 [{ y, m }]（m 為 1-12）
function lastMonths(n) {
  const out = [];
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1; // 1-12
  for (let i = 0; i < n; i++) {
    out.push({ y, m });
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return out.reverse();
}

// 民國日期 "115/05/04" → "2026-05-04"
function rocToISO(roc) {
  const parts = String(roc).trim().split('/');
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10) + 1911;
  const mm = parts[1].padStart(2, '0');
  const dd = parts[2].padStart(2, '0');
  if (isNaN(y)) return null;
  return `${y}-${mm}-${dd}`;
}

// 去除千分位逗號後轉數字；無效回傳 NaN
function num(s) {
  const v = parseFloat(String(s).replace(/,/g, '').trim());
  return v;
}

const TWSE_HEADERS = {
  // 帶上一般瀏覽器標頭，降低被擋的機率
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.twse.com.tw/',
};

async function fetchTWSE(url) {
  const r = await fetch(url, { headers: TWSE_HEADERS });
  if (!r.ok) return null;
  // TWSE 偶爾回傳非 JSON（過載訊息），用 try/catch 保護
  try { return await r.json(); } catch (e) { return null; }
}

// 加權指數：indicesReport/MI_5MINS_HIST
// fields: [日期, 開盤指數, 最高指數, 最低指數, 收盤指數]
async function fetchTaiex(months) {
  const all = [];
  for (const p of lastMonths(months)) {
    const date = `${p.y}${String(p.m).padStart(2, '0')}01`;
    const url = `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date=${date}`;
    const j = await fetchTWSE(url);
    if (!j || j.stat !== 'OK' || !Array.isArray(j.data)) continue;
    for (const row of j.data) {
      const iso = rocToISO(row[0]);
      const close = num(row[4]);
      if (!iso || isNaN(close)) continue;
      all.push([iso, num(row[1]), num(row[2]), num(row[3]), close, 0]);
    }
  }
  return all;
}

// 個股 / ETF：exchangeReport/STOCK_DAY
// fields: [日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數, 註記]
async function fetchStock(stockNo, months) {
  const all = [];
  for (const p of lastMonths(months)) {
    const date = `${p.y}${String(p.m).padStart(2, '0')}01`;
    const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${stockNo}`;
    const j = await fetchTWSE(url);
    if (!j || j.stat !== 'OK' || !Array.isArray(j.data)) continue;
    for (const row of j.data) {
      const iso = rocToISO(row[0]);
      const close = num(row[6]);
      if (!iso || isNaN(close)) continue;
      all.push([iso, num(row[3]), num(row[4]), num(row[5]), close, num(row[1])]);
    }
  }
  return all;
}
