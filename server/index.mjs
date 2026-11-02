import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
const CACHE_MS = 60_000;
const launchApiKey = process.env.FINNHUB_API_KEY;
let activeApiKey = null;

function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
const port = Number(process.env.API_PORT || 3001);

function getApiKey() {
  // Read the local file for every request so edits to .env take effect without
  // requiring users to remember that the API process also needs a restart.
  let fileKey = null;
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*FINNHUB_API_KEY\s*=\s*(.*?)\s*$/);
      if (match) { fileKey = match[1].replace(/^['"]|['"]$/g, ''); break; }
    }
  }
  const key = launchApiKey || fileKey || process.env.FINNHUB_API_KEY || '';
  if (key !== activeApiKey) { activeApiKey = key; cache.clear(); }
  return key;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const number = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const mean = (values) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
const sma = (values, size) => values.length >= size ? mean(values.slice(-size)) : null;
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, i) => value - values[i]);
  const gains = changes.slice(-period).map((v) => Math.max(0, v));
  const losses = changes.slice(-period).map((v) => Math.max(0, -v));
  const avgGain = mean(gains); const avgLoss = mean(losses);
  if (!avgLoss) return avgGain ? 100 : 50;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
function emaLast(values, period) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((prev, value) => prev + alpha * (value - prev), values[0]);
}
function buildForecast(closes, currentPrice, symbol, anchor) {
  const returns = closes.slice(1).map((value, i) => Math.log(value / closes[i])).filter(Number.isFinite).slice(-252);
  if (!(currentPrice > 0) || returns.length < 20) return null;
  // Bootstrap complete observed daily returns rather than extrapolating one
  // straight-line target. The seed makes a given quote snapshot reproducible.
  let seed = [...`${symbol}:${anchor}`].reduce((hash, char) => (Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0), 2166136261) || 1;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const pathCount = 600; const sessions = 252;
  const paths = Array.from({ length: pathCount }, () => currentPrice);
  const anchorDate = new Date(anchor || Date.now());
  if (!Number.isFinite(anchorDate.getTime())) anchorDate.setTime(Date.now());
  const points = [{ day: 0, date: anchorDate.toISOString(), p10: currentPrice, p50: currentPrice, p90: currentPrice, probabilityUp: 0.5 }];
  for (let day = 1; day <= sessions; day += 1) {
    const outcomes = [];
    for (let path = 0; path < pathCount; path += 1) {
      const sampledReturn = returns[Math.floor(random() * returns.length)];
      paths[path] *= Math.exp(sampledReturn);
      outcomes.push(paths[path]);
    }
    outcomes.sort((a, b) => a - b);
    const date = new Date(anchorDate);
    let added = 0;
    while (added < day) {
      date.setUTCDate(date.getUTCDate() + 1);
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) added += 1;
    }
    points.push({
      day, date: date.toISOString(), p10: Number(outcomes[Math.floor((pathCount - 1) * 0.1)].toFixed(4)),
      p50: Number(outcomes[Math.floor((pathCount - 1) * 0.5)].toFixed(4)), p90: Number(outcomes[Math.floor((pathCount - 1) * 0.9)].toFixed(4)),
      probabilityUp: outcomes.filter((price) => price > currentPrice).length / pathCount,
    });
  }
  return { startPrice: currentPrice, anchor: anchorDate.toISOString(), sessionsUsed: returns.length, paths: pathCount, method: '600-path bootstrap of observed daily log returns; 10th–90th percentile range', points };
}
function calculate(closes, symbol, exchange, interval) {
  if (!closes.length) return {
    technicals: null,
    scenarios: null,
    changePctFromPrevious: null,
    instrument: { symbol, exchange: exchange || null },
  };
  const returns = closes.slice(1).map((value, i) => Math.log(value / closes[i])).filter(Number.isFinite);
  const dailyDrift = mean(returns) ?? 0;
  const dailyVol = Math.sqrt(mean(returns.map((v) => (v - dailyDrift) ** 2)) ?? 0);
  const current = closes.at(-1);
  const periodsPerYear = { '5': 78 * 252, '30': 13 * 252, D: 252, W: 52, M: 12 }[interval] || 252;
  const annualVol = dailyVol * Math.sqrt(periodsPerYear);
  const change = current && closes.length > 1 ? ((current - closes.at(-2)) / closes.at(-2)) * 100 : null;
  const macd = emaLast(closes, 12) - emaLast(closes, 26);
  return {
    technicals: {
      rsi14: rsi(closes), sma20: sma(closes, 20), sma50: sma(closes, 50),
      macd, trend: closes.length > 1 ? (current > closes[0] ? 'Uptrend' : current < closes[0] ? 'Downtrend' : 'Flat') : 'Insufficient history',
      annualizedVolatility: annualVol * 100,
    },
    changePctFromPrevious: change,
    instrument: { symbol, exchange: exchange || null },
  };
}

async function provider(endpoint, params) {
  const key = getApiKey();
  if (!key) { const error = new Error('Market data is not connected. Add FINNHUB_API_KEY to .env and restart the app.'); error.status = 503; throw error; }
  const url = new URL(`https://finnhub.io/api/v1/${endpoint}`);
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(name, value);
  url.searchParams.set('token', key);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Market provider returned invalid JSON (${response.status}).`); }
  if (!response.ok || data.status === 'error' || data.code >= 400 || data.error) {
    const error = new Error(data.error || data.message || `Market provider error (${response.status}).`);
    error.status = data.code === 429 || response.status === 429 ? 429 : 502;
    throw error;
  }
  return data;
}
async function cached(key, loader) {
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < CACHE_MS) return existing.value;
  const value = await loader();
  if (!value?.historyError) cache.set(key, { at: Date.now(), value });
  return value;
}
function paramsFrom(url) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const exchange = (url.searchParams.get('exchange') || '').trim().toUpperCase();
  // Allow punctuation used in exchange-qualified symbols and indices.
  if (!/^[A-Z0-9.^=_/:-]{1,32}$/.test(symbol)) { const error = new Error('Enter a valid ticker symbol.'); error.status = 400; throw error; }
  return { symbol, exchange };
}
function intervals(range) {
  if (range === '1D') return { interval: '5min', outputsize: 78 };
  if (range === '1W') return { interval: '30min', outputsize: 80 };
  if (range === '3M') return { interval: '1day', outputsize: 65 };
  if (range === '1Y') return { interval: '1day', outputsize: 260 };
  if (range === 'ALL') return { interval: '1month', outputsize: 120 };
  return { interval: '1day', outputsize: 30 };
}
async function yahooCandles(symbol, range) {
  let ticker = symbol.split(':').at(-1);
  const exchangeSuffix = /\.(NS|BO|L|TO|AX|AS|DE|PA|F|HK|T|N)$/i;
  if (ticker.includes('.') && !exchangeSuffix.test(ticker)) ticker = ticker.replaceAll('.', '-');
  const query = {
    '1D': ['1d', '5m'], '1W': ['5d', '30m'], '1M': ['1mo', '1d'],
    '3M': ['3mo', '1d'], '1Y': ['1y', '1d'], ALL: ['max', '1mo'],
  }[range];
  const controllers = [];
  let result = null;
  try {
    result = await Promise.any(['query1.finance.yahoo.com', 'query2.finance.yahoo.com'].map(async (host) => {
      const controller = new AbortController(); controllers.push(controller);
    const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}`);
    url.searchParams.set('range', query[0]);
    url.searchParams.set('interval', query[1]);
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 MarketLens/1.0' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      const body = await response.json().catch(() => ({}));
      const row = body.chart?.result?.[0];
      if (!response.ok || !row) throw new Error(body.chart?.error?.description || `Historical candles unavailable (${response.status}).`);
      return row;
    }));
  } catch (error) {
    const lastError = error.errors?.at(-1) || error;
    throw lastError || new Error('Historical candles are unavailable.');
  } finally {
    for (const controller of controllers) controller.abort();
  }
  const quote = result.indicators?.quote?.[0] || {};
  const values = (result.timestamp || []).map((timestamp, i) => ({
    datetime: new Date(timestamp * 1000).toISOString(), open: quote.open?.[i], high: quote.high?.[i],
    low: quote.low?.[i], close: quote.close?.[i], volume: quote.volume?.[i],
  })).filter((row) => number(row.close) !== null);
  if (!values.length) throw new Error('No historical candles were found for this symbol.');
  return { values, meta: result.meta, interval: query[1] };
}
async function yahooSearch(query) {
  const url = new URL('https://query1.finance.yahoo.com/v1/finance/search');
  url.searchParams.set('q', query);
  url.searchParams.set('quotesCount', '12');
  url.searchParams.set('newsCount', '0');
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 MarketLens/1.0' }, signal: AbortSignal.timeout(12_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Instrument search failed (${response.status}).`);
  return (body.quotes || []).filter((row) => row.symbol && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY'].includes(row.quoteType)).map((row) => ({
    symbol: row.symbol, name: row.shortname || row.longname || row.symbol, exchange: row.exchange || '',
    country: '', currency: row.currency || '', type: row.quoteType || '',
  }));
}
async function market(url) {
  const { symbol, exchange } = paramsFrom(url);
  const name = (url.searchParams.get('name') || '').trim().slice(0, 120);
  const range = ['1D', '1W', '1M', '3M', '1Y', 'ALL'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '1M';
  // Quotes are intentionally fetched on every request. Historical search/news
  // can use short caches, but a market refresh must never replay a saved quote.
  return (async () => {
    const now = Math.floor(Date.now() / 1000);
    const windows = { '1D': 2 * 86400, '1W': 7 * 86400, '1M': 31 * 86400, '3M': 92 * 86400, '1Y': 366 * 86400, 'ALL': 10 * 365 * 86400 };
    const resolutions = { '1D': '5', '1W': '30', '1M': 'D', '3M': 'D', '1Y': 'D', 'ALL': 'M' };
    const query = { symbol };
    const [quoteResult, seriesResult, profileResult] = await Promise.allSettled([
      provider('quote', query),
      provider('stock/candle', { ...query, resolution: resolutions[range], from: now - windows[range], to: now }),
      provider('stock/profile2', query),
    ]);
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    const series = seriesResult.status === 'fulfilled' ? seriesResult.value : null;
    const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
    let values = Array.isArray(series?.t) ? series.t.map((timestamp, i) => ({
      datetime: new Date(timestamp * 1000).toISOString(), open: series.o?.[i], high: series.h?.[i],
      low: series.l?.[i], close: series.c?.[i], volume: series.v?.[i],
    })) : [];
    let historySource = 'Finnhub';
    let historyError = '';
    let yahooMeta = null;
    if (!values.some((row) => number(row.close) !== null)) {
      try {
        const fallback = await yahooCandles(symbol, range);
        values = fallback.values;
        yahooMeta = fallback.meta;
        historySource = 'Yahoo Finance';
      } catch (fallbackError) {
        const providerError = seriesResult.reason?.message || '';
        historyError = /access to this resource/i.test(providerError)
          ? `Finnhub accepted the API key for quotes, but denied historical candles for this account. Yahoo Finance fallback also failed: ${fallbackError.message}`
          : fallbackError.message;
      }
    }
    if (!(number(quote?.c) > 0) && !values.length) {
      const error = quoteResult.reason || new Error(historyError || 'No price or historical data was returned for this symbol.');
      error.status ||= 404;
      throw error;
    }
    const chart = values.map((row) => ({
      date: row.datetime, open: number(row.open), high: number(row.high), low: number(row.low),
      close: number(row.close), volume: number(row.volume),
    })).filter((row) => row.close !== null);
    const closes = chart.map((row) => row.close);
    const selectedInterval = historySource === 'Finnhub' ? resolutions[range] : ({ '5m': '5', '30m': '30', '1d': 'D', '1mo': 'M' }[yahooMeta?.dataGranularity] || resolutions[range]);
    const analysis = calculate(closes, symbol, exchange, selectedInterval);
    const latest = chart.at(-1);
    const previous = chart.at(-2);
    const hasFinnhubQuote = number(quote?.c) > 0;
    const quotePrice = hasFinnhubQuote ? number(quote.c) : number(yahooMeta?.regularMarketPrice) ?? latest?.close ?? null;
    const quoteDate = hasFinnhubQuote && quote?.t ? new Date(quote.t * 1000).toISOString() : yahooMeta?.regularMarketTime ? new Date(yahooMeta.regularMarketTime * 1000).toISOString() : latest?.date || new Date().toISOString();
    const numeric = (field, fallback = null) => number(quote?.[field]) || fallback;
    return {
      symbol, exchange: profile?.exchange || exchange || null,
      name: name || profile?.name || yahooMeta?.shortName || yahooMeta?.longName || symbol,
      currency: profile?.currency || yahooMeta?.currency || yahooMeta?.currencyCode || null,
      datetime: hasFinnhubQuote && quote?.t ? new Date(quote.t * 1000).toISOString() : yahooMeta?.regularMarketTime ? new Date(yahooMeta.regularMarketTime * 1000).toISOString() : latest?.date || null,
      price: quotePrice, open: numeric('o', number(yahooMeta?.regularMarketOpen) ?? latest?.open), high: numeric('h', number(yahooMeta?.regularMarketDayHigh) ?? latest?.high), low: numeric('l', number(yahooMeta?.regularMarketDayLow) ?? latest?.low),
      previousClose: numeric('pc', number(yahooMeta?.chartPreviousClose) ?? previous?.close),
      change: numeric('d', number(yahooMeta?.regularMarketChange) ?? (latest && previous ? latest.close - previous.close : null)),
      percentChange: numeric('dp', number(yahooMeta?.regularMarketChangePercent) ?? (latest && previous?.close ? ((latest.close - previous.close) / previous.close) * 100 : null)),
      volume: numeric('v', latest?.volume), averageVolume: null, fiftyTwoWeek: null,
      range, interval: selectedInterval, chart, ...analysis, historyError: historyError || null,
      source: hasFinnhubQuote ? 'Finnhub' : 'Yahoo Finance', quoteSource: hasFinnhubQuote ? 'Finnhub' : 'Yahoo Finance', historySource,
      fetchedAt: new Date().toISOString(), stale: false,
    };
  })();
}
async function handle(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, provider: 'Finnhub', configured: Boolean(getApiKey()), marketCacheSeconds: 0, searchCacheSeconds: CACHE_MS / 1000 });
    if (req.method !== 'GET') return json(res, 405, { error: 'Only GET requests are supported.' });
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 1 || q.length > 64) return json(res, 200, { results: [] });
      const [finnhubResult, yahooResult] = await Promise.allSettled([
        cached(`search:finnhub:${q.toLowerCase()}`, () => provider('search', { q })),
        cached(`search:yahoo:${q.toLowerCase()}`, () => yahooSearch(q)),
      ]);
      const finnhubRows = finnhubResult.status === 'fulfilled' ? (finnhubResult.value.result || []).map((row) => ({ symbol: row.symbol, name: row.description, exchange: '', country: '', currency: '', type: row.type })) : [];
      const yahooRows = yahooResult.status === 'fulfilled' ? yahooResult.value : [];
      const merged = new Map();
      for (const row of finnhubRows) if (row.symbol) merged.set(row.symbol, row);
      for (const row of yahooRows) if (row.symbol) {
        const prior = merged.get(row.symbol);
        merged.set(row.symbol, prior ? { ...row, ...prior, exchange: prior.exchange || row.exchange, country: prior.country || row.country, currency: prior.currency || row.currency, type: prior.type || row.type } : row);
      }
      if (!merged.size && finnhubResult.status === 'rejected' && yahooResult.status === 'rejected') throw finnhubResult.reason;
      return json(res, 200, { results: [...merged.values()] });
    }
    if (url.pathname === '/api/forecast') {
      const { symbol } = paramsFrom(url);
      const price = number(url.searchParams.get('price'));
      const anchor = (url.searchParams.get('anchor') || '').slice(0, 40);
      if (!(price > 0)) { const error = new Error('A current provider price is required to build the forecast.'); error.status = 400; throw error; }
      const history = await yahooCandles(symbol, '1Y');
      const closes = history.values.map((row) => number(row.close)).filter((value) => value > 0);
      const forecast = buildForecast(closes, price, symbol, anchor || new Date().toISOString());
      if (!forecast) { const error = new Error('At least 20 daily price changes are required for a forecast.'); error.status = 422; throw error; }
      return json(res, 200, { symbol, forecast, forecastSource: 'Yahoo Finance daily history' });
    }
    if (url.pathname === '/api/market') return json(res, 200, await market(url));
    if (url.pathname === '/api/stocks') {
      const country = (url.searchParams.get('country') || '').trim();
      if (!country || country.length > 64) return json(res, 400, { error: 'Choose a country to list instruments.' });
      const data = await cached(`stocks:${country.toLowerCase()}`, () => provider('stocks', { country }));
      return json(res, 200, { country, results: data.data || [] });
    }
    if (url.pathname === '/api/news') {
      const { symbol, exchange } = paramsFrom(url);
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
      const news = await cached(`news:finnhub:${symbol}`, () => provider('company-news', { symbol, from, to }));
      return json(res, 200, { symbol, results: (Array.isArray(news) ? news : []).slice(0, 10).map((row) => ({ title: row.headline, source: row.source, url: row.url, date: row.datetime ? new Date(row.datetime * 1000).toISOString() : '' })) });
    }
    return json(res, 404, { error: 'API route not found.' });
  } catch (error) {
    const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
    return json(res, status, { error: error.message || 'Market data request failed.', provider: 'Finnhub' });
  }
}

const server = http.createServer(handle);
server.listen(port, '127.0.0.1', () => console.log(`MarketLens data server listening on http://127.0.0.1:${port}`));
