/**
 * Balance pill host half: the daily price feed.
 *
 * The pill estimates the current session's cost in dollars, and the official
 * per-million-token prices live in an HTML table on `api-docs.deepseek.com`.
 * That origin sends no CORS headers, so the browser half cannot read it: this
 * half fetches the table once a day, keeps it in memory, and serves it to the
 * loopback-only route `/balance-pill/prices`.
 *
 * Nothing here touches the account, the platform session, or any private
 * endpoint; when the fetch or the parse fails the last good table is served,
 * and before the first success the bundled fallback table is served instead.
 */

export const name = 'balance-pill';
export const inject = ['webServer'];

const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';
const ROUTE_PATH = '/balance-pill/prices';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const ERR = {
  TIMEOUT: 'timeout',
  FETCH: 'fetch_failed',
  PARSE: 'parse_failed',
};

/**
 * Bundled fallback table, taken from the same page. It only serves the window
 * before the first successful fetch, or a deployment with no network at all.
 */
const FALLBACK_MODELS = {
  'deepseek-flash': {
    cacheHit: { offPeak: 0.003, peak: 0.006 },
    cacheMiss: { offPeak: 0.15, peak: 0.3 },
    output: { offPeak: 0.6, peak: 1.2 },
  },
  'deepseek-v4-pro': {
    cacheHit: { offPeak: 0.022, peak: 0.044 },
    cacheMiss: { offPeak: 0.66, peak: 1.32 },
    output: { offPeak: 1.98, peak: 3.96 },
  },
};

const PRICE_ROWS = [
  ['cacheHit', 'CACHE HIT'],
  ['cacheMiss', 'CACHE MISS'],
  ['output', 'OUTPUT'],
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = req.headers && req.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

async function readLimited(res) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (reader === null) {
    const text = await res.text();
    return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw codedError(ERR.PARSE, 'pricing page too large');
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Flatten the page to one text line so a table row becomes a regex target. */
function plainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Model columns in table order; the header row reads "MODEL a (1) b". */
function modelColumns(text) {
  const start = text.indexOf('MODEL ');
  const end = text.indexOf('BASE URL');
  const header = start === -1 ? '' : text.slice(start + 6, end === -1 ? start + 400 : end);
  const names = [];
  for (const match of header.matchAll(/[a-z][a-z0-9.\-_]{3,}/g)) {
    const name = match[0];
    if (!name.startsWith('deepseek')) continue;
    if (names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

function pricesOf(rowLabel, prices) {
  const pattern = new RegExp(
    '1M INPUT TOKENS \\(' + rowLabel + '\\)\\s*OFF-PEAK\\s*\\$([\\d.]+)\\s*\\$([\\d.]+)\\s*PEAK\\s*\\$([\\d.]+)\\s*\\$([\\d.]+)',
  );
  const match = pattern.exec(prices);
  return match === null ? null : [match[1], match[2], match[3], match[4]].map(Number);
}

function outputPrices(prices) {
  const pattern = /1M OUTPUT TOKENS\s*OFF-PEAK\s*\$([\d.]+)\s*\$([\d.]+)\s*PEAK\s*\$([\d.]+)\s*\$([\d.]+)/;
  const match = pattern.exec(prices);
  return match === null ? null : [match[1], match[2], match[3], match[4]].map(Number);
}

/**
 * Parse the pricing table into `{ model: { cacheHit, cacheMiss, output } }`
 * with off-peak and peak prices per million tokens. Returns null when the page
 * no longer carries the rows we read, so the caller keeps its last good table.
 */
export function parsePricingTable(html) {
  if (typeof html !== 'string' || html === '') return null;
  const text = plainText(html);
  const models = modelColumns(text);
  if (models.length === 0) return null;
  const start = text.indexOf('PRICING');
  if (start === -1) return null;
  const fallbackEnd = text.indexOf('Concurrency Limit', start);
  const table = text.slice(start, fallbackEnd === -1 ? start + 4_000 : fallbackEnd);

  const parsed = {};
  for (const [key, label] of PRICE_ROWS) {
    const row = key === 'output' ? outputPrices(table) : pricesOf(label, table);
    if (row === null) return null;
    for (let index = 0; index < models.length && index < 2; index += 1) {
      const model = models[index];
      parsed[model] ??= {};
      parsed[model][key] = {
        offPeak: row[index] ?? row[0],
        peak: row[index + 2] ?? row[2],
      };
    }
  }
  for (const model of Object.keys(parsed)) {
    const entry = parsed[model];
    if (entry.cacheHit === undefined || entry.cacheMiss === undefined || entry.output === undefined) delete parsed[model];
  }
  return Object.keys(parsed).length === 0 ? null : parsed;
}

async function fetchPricing() {
  let res;
  try {
    res = await fetch(PRICING_URL, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw codedError(ERR.TIMEOUT, 'pricing request timed out');
    }
    throw codedError(ERR.FETCH, 'pricing request failed');
  }
  if (!res.ok) throw codedError(ERR.FETCH, 'pricing request answered ' + res.status);
  const models = parsePricingTable(await readLimited(res));
  if (models === null) throw codedError(ERR.PARSE, 'pricing table no longer parseable');
  return models;
}

export function apply(ctx) {
  let cache = null;
  let inflight = null;

  const payload = (models, source, at, stale) => ({
    source,
    fetchedAt: at,
    stale,
    currency: 'USD',
    unit: 'per 1M tokens',
    peakWindow: [
      { from: 1, to: 4 },
      { from: 6, to: 10 },
    ],
    models,
  });

  const load = () => {
    if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(payload(cache.models, cache.source, cache.at, false));
    if (inflight !== null) return inflight;
    inflight = (async () => {
      try {
        const models = await fetchPricing();
        cache = { at: Date.now(), models, source: PRICING_URL };
        return payload(models, PRICING_URL, cache.at, false);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : ERR.FETCH;
        ctx.logger?.('balance-pill')?.warn?.('pricing failed: ' + code + ' ' + String(error?.message ?? ''));
        if (cache !== null) return payload(cache.models, cache.source, cache.at, true);
        return payload(FALLBACK_MODELS, 'bundled', 0, true);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const handler = async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!isLoopbackRequest(req)) return send(403, { ok: false, code: 'forbidden' });
    if (req.method !== 'GET') return send(405, { ok: false, code: 'method_not_allowed' });
    try {
      send(200, { ok: true, data: await load() });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ERR.FETCH;
      send(502, { ok: false, code });
    }
  };

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler });
    return () => {
      dispose();
      cache = null;
      inflight = null;
    };
  }, 'balance-pill: price feed route');
}
