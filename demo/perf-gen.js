/**
 * perf-gen.js - seeded synthetic OTel TraceData generator for performance work.
 *
 * Builds `TraceData` directly and never goes through `transformLogs`: the
 * transform's parent lookup is O(n^2) and would pollute render numbers.
 * Plain ES module with no DOM access, so it also runs under Node.
 *
 * Shape of the default dataset (one trace, one root):
 *  - N spans, mean depth ~9, max depth 14, plus two chains reaching depth 30
 *  - heavy-tailed fan-out of the internal nodes: 70% 1-3 children, 25% 4-12,
 *    5% 20-60, a few nodes with 500 (capped at N/10 for small traces)
 *  - 25 services with Zipf popularity, 500 distinct span names (some very
 *    long, some non-Latin)
 *  - SpanKind mix Internal/Server/Client/Producer/Consumer = 50/20/20/5/5
 *  - 2% seeded error spans, propagated to every ancestor
 *  - log-normal leaf durations with nanosecond precision (about half of all
 *    spans last under 1 ms); a parent lasts as long as its children laid out
 *    sequentially or in parallel (50/50) plus a little self time
 *  - about 2 events per regular span, plus a few "log-heavy" spans with
 *    500-2000 events (see the note on `heavy` below)
 *
 * Query flags understood by demo/perf.html (parsed by optionsFromParams):
 *   n=<spans>   number of spans (default 10000)
 *   seed=<int>  RNG seed (default 1)
 *   ns=0        truncate every timestamp to a whole millisecond (default ns=1)
 *   flat=1      the flat dataset of demo/benchmark.html (see generateFlatLogs)
 *   heavy=<f>   fraction of log-heavy spans (default 0.001)
 *   ev=<mean>   mean events per regular span (default 2)
 *   impl=current|canvas|dom, auto=1   handled by perf.html itself
 *
 * About `heavy`: the brief asked for "~2 events per span" together with "1%
 * log-heavy spans of 500-2000 events". Those two cannot both hold: 1% of 50K
 * spans x ~1,080 events = ~540K events, i.e. ~11 per span on average, against
 * the ~100K events (~2 per span) the plan budgets for 50K spans. The default
 * is therefore heavy=0.001 (50 heavy spans at 50K, ~154K events in total);
 * pass heavy=0.01 for the literal profile.
 */

export const GEN_VERSION = 1;

export const DEFAULTS = Object.freeze({
  n: 10000,
  seed: 1,
  ns: 1,
  heavy: 0.001,
  heavyMin: 500,
  heavyMax: 2000,
  ev: 2,
  depthMean: 9,
  depthMax: 14,
  chainDepth: 30,
  errorRate: 0.02,
  leafMedianUs: 450,
});

/** 2026-03-23T10:00:00Z in epoch milliseconds (whole-ms boundary, so ms truncation is exact). */
const BASE_MS = Date.UTC(2026, 2, 23, 10, 0, 0);

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Standard normal via Box-Muller. */
function gauss(rng) {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** Zipf sampler over 0..n-1 (index 0 most popular). */
function makeZipf(rng, n, s) {
  const cum = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) { total += 1 / Math.pow(i + 1, s); cum[i] = total; }
  return function sample() {
    const u = rng() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] >= u) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
}

function poisson(rng, lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > limit);
  return k - 1;
}

const hex = (rng, bytes) => {
  let out = '';
  for (let i = 0; i < bytes / 4; i++) out += ((rng() * 4294967296) >>> 0).toString(16).padStart(8, '0');
  return out;
};

/** Decimal nanosecond string for `offsetNs` after BASE_MS (exact for offsets below 2^53, no BigInt needed). */
function nsString(offsetNs) {
  const ms = Math.floor(offsetNs / 1e6);
  const rem = offsetNs - ms * 1e6;
  return String(BASE_MS + ms) + String(rem).padStart(6, '0');
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const SERVICES = [
  'api-gateway', 'auth-service', 'user-service', 'order-service', 'payment-service',
  'inventory-service', 'catalog-service', 'cart-service', 'pricing-service', 'shipping-service',
  'notification-service', 'email-worker', 'search-service', 'recommendation-service', 'analytics-ingest',
  'billing-service', 'ledger-service', 'fraud-detector', 'session-store', 'cache-proxy',
  'config-service', 'audit-log', 'media-service', 'scheduler', 'report-generator',
];

const VERBS = [
  'get', 'list', 'create', 'update', 'delete', 'validate', 'authorize', 'authenticate', 'fetch', 'load',
  'save', 'publish', 'consume', 'process', 'resolve', 'render', 'compute', 'sync', 'reconcile', 'enrich',
  'transform', 'serialize', 'deserialize', 'compress', 'encrypt', 'decrypt', 'notify', 'schedule', 'retry', 'flush',
];

const NOUNS = [
  'Order', 'Customer', 'Invoice', 'Payment', 'Inventory', 'Catalog', 'Cart', 'Session', 'Token', 'Profile',
  'Shipment', 'Ledger', 'Quote', 'Account', 'Policy', 'Rule', 'Offer', 'Price', 'Tax', 'Address',
  'Receipt', 'Audit', 'Event', 'Message', 'Job', 'Report', 'Metric', 'Config', 'Feature', 'Wallet',
];

const TABLES = ['orders', 'customers', 'invoices', 'payments', 'inventory_items', 'sessions', 'shipments', 'ledger_entries', 'audit_events', 'price_rules'];
const COLUMNS = ['id', 'status', 'customer_id', 'created_at', 'updated_at', 'total_amount', 'currency', 'region', 'tenant_id', 'version', 'payload', 'checksum'];
const HTTP_METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

const NON_LATIN = [
  'Обробка замовлення', 'Перевірка платежу', 'Синхронізація каталогу', 'Розрахунок знижки', 'Відправка сповіщення', 'Оновлення профілю',
  '订单处理', '支付验证', '库存同步', '用户认证', '注文確認', '決済処理', '在庫更新', '주문 처리', '결제 검증',
  'معالجة الطلب', 'التحقق من الدفع', 'مزامنة المخزون', 'עיבוד הזמנה', 'אימות תשלום',
  'ประมวลผลคำสั่งซื้อ', 'ตรวจสอบการชำระเงิน', 'ऑर्डर प्रोसेसिंग', 'भुगतान सत्यापन',
  '🚀 deploy-hook', '💳 charge ✔', '📦 pack & ship', '🔒 token refresh', 'Café order lookup', 'Zoë profile merge',
];

const EVENT_NAMES = ['log', 'log', 'log', 'cache.miss', 'cache.hit', 'db.query', 'retry', 'http.response', 'queue.ack', 'validation', 'exception', 'checkpoint'];
const COMPONENTS = ['http', 'grpc', 'jdbc', 'redis', 'kafka', 'internal', 'cron', 'graphql'];
const LOGGERS = [];
const THREADS = 64;

const KIND_CUM = [0.50, 0.70, 0.90, 0.95, 1.0];   // Internal, Server, Client, Producer, Consumer
const KIND_VALUES = [1, 2, 3, 4, 5];
const KIND_LABELS = { 1: 'Internal', 2: 'Server', 3: 'Client', 4: 'Producer', 5: 'Consumer' };

for (const noun of NOUNS) LOGGERS.push(`com.example.${noun.toLowerCase()}.${noun}Handler`);

// ---------------------------------------------------------------------------
// Name pool (500 distinct names)
// ---------------------------------------------------------------------------

function longName(rng) {
  const target = randInt(rng, 150, 320);
  if (rng() < 0.5) {
    let s = `com.example.platform.${pick(rng, TABLES).replace('_', '.')}.${pick(rng, NOUNS).toLowerCase()}.generation.${pick(rng, NOUNS)}GenerationService.`;
    s += `${pick(rng, VERBS)}${pick(rng, NOUNS)}For${pick(rng, NOUNS)}`;
    while (s.length < target) s += `And${pick(rng, NOUNS)}With${pick(rng, NOUNS)}Adjustments`;
    return `${s}(java.lang.String,java.util.UUID,java.time.Instant)`.slice(0, target + 40);
  }
  let s = `SELECT ${COLUMNS.slice(0, 3).join(', ')}`;
  while (s.length < target - 60) s += `, ${pick(rng, TABLES)}.${pick(rng, COLUMNS)}`;
  return `${s} FROM ${pick(rng, TABLES)} JOIN ${pick(rng, TABLES)} ON ${pick(rng, COLUMNS)} = ? WHERE ${pick(rng, COLUMNS)} IN (?, ?, ?)`;
}

function buildNamePool(rng, count) {
  const names = new Set();
  const out = [];
  const add = (name) => { if (!names.has(name)) { names.add(name); out.push(name); } };
  const longTarget = Math.round(count * 0.05);
  const nonLatinTarget = Math.round(count * 0.05);
  let guard = 0;
  while (out.length < count && guard++ < count * 200) {
    const roll = rng();
    const have = out.length;
    if (have < longTarget) add(longName(rng));
    else if (have < longTarget + nonLatinTarget) add(`${pick(rng, NON_LATIN)} · ${pick(rng, NOUNS)}`);
    else if (roll < 0.62) add(`${pick(rng, NOUNS)}Service.${pick(rng, VERBS)}${pick(rng, NOUNS)}`);
    else if (roll < 0.80) add(`${pick(rng, HTTP_METHODS)} /api/v${randInt(rng, 1, 3)}/${pick(rng, NOUNS).toLowerCase()}s/{id}/${pick(rng, NOUNS).toLowerCase()}s`);
    else if (roll < 0.91) add(`SELECT ${pick(rng, COLUMNS)}, ${pick(rng, COLUMNS)} FROM ${pick(rng, TABLES)} WHERE ${pick(rng, COLUMNS)} = ?`);
    else if (roll < 0.95) add(`redis ${pick(rng, ['GET', 'SET', 'DEL', 'HGET'])} ${pick(rng, NOUNS).toLowerCase()}:${randInt(rng, 1, 99)}`);
    else if (roll < 0.98) add(`kafka.publish ${pick(rng, NOUNS).toLowerCase()}s.v${randInt(rng, 1, 4)}`);
    else add(`grpc.${pick(rng, NOUNS)}Service/${pick(rng, VERBS)}${pick(rng, NOUNS)}`);
  }
  return shuffle(rng, out);
}

function buildMessagePool(rng, count) {
  const templates = [
    (n, m) => `Request ${n} completed in ${m} ms`,
    (n) => `Cache miss for key session:${n}`,
    (n, m) => `Retrying after transient failure (attempt ${n % 5 + 1}, backoff ${m} ms)`,
    (n, m) => `Loaded ${n} rows from ${TABLES[m % TABLES.length]}`,
    (n, m) => `Connection pool: ${n % 40} active, ${m % 20} idle`,
    (n) => `Validated payload checksum ${n.toString(16)}`,
    (n, m) => `Published message ${n} to partition ${m % 12}`,
    (n) => `Token ${n.toString(36)} refreshed`,
    (n, m) => `Slow operation detected: ${m} ms (threshold 250 ms), correlation ${n}`,
    (n) => `Unexpected response code ${[400, 404, 409, 429, 500, 503][n % 6]} from upstream`,
  ];
  const out = [];
  for (let i = 0; i < count; i++) out.push(templates[i % templates.length](randInt(rng, 1, 99999), randInt(rng, 1, 2500)));
  return out;
}

// ---------------------------------------------------------------------------
// Tree structure
// ---------------------------------------------------------------------------

/** Share of the N nodes at each depth: binomial profile with the requested mean, every level non-empty. */
function levelSizes(m, depthMax, depthMean) {
  const levels = Math.min(depthMax, m - 1);
  const sizes = [1];
  if (levels <= 0) return sizes;
  const p = Math.min(0.95, Math.max(0.05, depthMean / depthMax));
  // binomial pmf over d = 0..depthMax; weights for d = 1..levels
  const weights = [];
  let pmf = Math.pow(1 - p, depthMax);
  let wsum = 0;
  for (let d = 0; d <= depthMax; d++) {
    if (d >= 1 && d <= levels) { weights.push(pmf); wsum += pmf; }
    pmf *= (depthMax - d) / (d + 1) * (p / (1 - p));
  }
  const spare = m - 1 - levels;               // every level gets 1, the rest is shared by weight
  const raw = weights.map((w) => (w / wsum) * spare);
  const floors = raw.map(Math.floor);
  let left = spare - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; left > 0; i++, left--) floors[order[i % order.length][1]]++;
  for (let i = 0; i < levels; i++) sizes.push(1 + floors[i]);
  return sizes;
}

function drawFanout(rng) {
  const u = rng();
  if (u < 0.70) return 1 + Math.floor(rng() * 3);     // 1-3
  if (u < 0.95) return 4 + Math.floor(rng() * 9);     // 4-12
  return 20 + Math.floor(rng() * 41);                 // 20-60
}

function sampleSorted(rng, total, k) {
  if (k >= total) return Int32Array.from({ length: total }, (_, i) => i);
  const idx = Int32Array.from({ length: total }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (total - i));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx.slice(0, k).sort();
}

/**
 * Parent array for a tree of n nodes. Nodes are numbered level by level, so a
 * parent always has a smaller index than its children (chain nodes are appended
 * at the end and obey the same rule).
 */
function buildTree(n, rng, o) {
  const chainAnchors = n >= 500 ? [8, 4] : [];
  const chainNodes = chainAnchors.reduce((s, d) => s + (o.chainDepth - d), 0);
  // depth sum of the chain nodes, so the whole tree (not just the main part) averages depthMean
  let chainDepthSum = 0;
  for (const a of chainAnchors) for (let d = a + 1; d <= o.chainDepth; d++) chainDepthSum += d;
  const m = n - chainNodes;
  const parent = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n);
  const mainMean = Math.max(1, (o.depthMean * n - chainDepthSum) / m);
  const sizes = levelSizes(m, o.depthMax, mainMean);
  const levelStart = [0];
  for (let d = 0; d < sizes.length; d++) levelStart.push(levelStart[d] + sizes[d]);

  // Mega fan-out nodes (500 children, capped for small traces)
  const megaFanout = Math.min(500, Math.floor(m / 10));
  const megaCount = megaFanout >= 20 ? (m >= 20000 ? 4 : m >= 5000 ? 3 : m >= 1000 ? 2 : 1) : 0;
  const megasAt = new Int32Array(sizes.length);
  const eligible = [];
  for (let d = 2; d <= 10 && d + 1 < sizes.length; d++) {
    if (sizes[d + 1] >= 1.5 * megaFanout && sizes[d] >= 1) eligible.push(d);
  }
  shuffle(rng, eligible);
  for (let placed = 0, i = 0; placed < megaCount && eligible.length > 0 && i < megaCount * 4; i++) {
    const d = eligible[i % eligible.length];
    if (megasAt[d] < Math.min(sizes[d], Math.floor(sizes[d + 1] / (2 * megaFanout)) || 0)) { megasAt[d]++; placed++; }
  }

  const megas = [];
  for (let d = 0; d + 1 < sizes.length; d++) {
    const P = sizes[d];
    const C = sizes[d + 1];
    const ks = [];
    let sum = 0;
    for (let j = 0; j < megasAt[d]; j++) { ks.push(megaFanout); sum += megaFanout; }
    const megaSlots = ks.length;
    while (sum < C && ks.length < P) {
      let k = drawFanout(rng);
      if (sum + k > C) k = C - sum;
      ks.push(k); sum += k;
    }
    for (let i = 0; sum < C; i++, sum++) ks[megaSlots + (i % Math.max(1, ks.length - megaSlots))]++;
    shuffle(rng, ks);
    const chosen = sampleSorted(rng, P, ks.length);
    let child = levelStart[d + 1];
    for (let j = 0; j < ks.length; j++) {
      const p = levelStart[d] + chosen[j];
      if (ks[j] >= megaFanout && megaFanout >= 20 && megas.length < megaCount) megas.push(p);
      for (let c = 0; c < ks[j]; c++) { parent[child] = p; depth[child] = d + 1; child++; }
    }
  }

  // Two chains reaching chainDepth
  const chains = [];
  let next = m;
  for (const anchorDepth of chainAnchors) {
    const lvl = Math.min(anchorDepth, sizes.length - 1);
    let prev = levelStart[lvl] + Math.floor(rng() * sizes[lvl]);
    const anchor = prev;
    while (depth[prev] < o.chainDepth) {
      parent[next] = prev; depth[next] = depth[prev] + 1; prev = next; next++;
    }
    chains.push({ anchor, anchorDepth: depth[anchor], tip: prev, length: depth[prev] - depth[anchor] });
  }

  // children in CSR form (sorted by index)
  const childCount = new Int32Array(n);
  for (let i = 1; i < n; i++) childCount[parent[i]]++;
  const childStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) childStart[i + 1] = childStart[i] + childCount[i];
  const childList = new Int32Array(Math.max(0, n - 1));
  const fill = childStart.slice(0, n);
  for (let i = 1; i < n; i++) childList[fill[parent[i]]++] = i;

  return { n, parent, depth, childCount, childStart, childList, chains, megaFanout, megas };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function makeTimingRandomness(n, rng) {
  const r = {
    seq: new Uint8Array(n), self: new Float64Array(n),
    off: new Float64Array(n), z: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    r.seq[i] = rng() < 0.5 ? 1 : 0;
    r.self[i] = 0.05 + 0.25 * rng();
    const u = rng();
    r.off[i] = u * u * 0.3;
    r.z[i] = gauss(rng);
  }
  return r;
}

/**
 * Durations bottom-up, offsets top-down, all in whole nanoseconds.
 * Leaves get log-normal durations. A sequential parent places its children one
 * after another with small gaps, a parallel parent starts them near its own
 * start so they overlap; either way the parent lasts as long as its children
 * plus some self time, so containment is exact by construction.
 * Children always have larger indices than their parent.
 */
function assignTimes(tree, r, o) {
  const { n, parent, childCount, childStart, childList } = tree;
  const dur = new Float64Array(n);
  const off = new Float64Array(n);   // child start relative to the parent's start
  const mu = Math.log(o.leafMedianUs * 1000);
  const sigma = 1.8;
  for (let p = n - 1; p >= 0; p--) {
    const k = childCount[p];
    if (k === 0) { dur[p] = Math.max(1, Math.round(Math.exp(mu + sigma * r.z[p]))); continue; }
    const base = childStart[p];
    if (r.seq[p] === 1) {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += dur[childList[base + j]];
      const own = Math.max(2, Math.floor(r.self[p] * sum));
      const gap = Math.floor(own * 0.7 / k);
      let cursor = Math.floor(own * 0.3);
      for (let j = 0; j < k; j++) {
        const c = childList[base + j];
        off[c] = cursor;
        cursor += dur[c] + gap;
      }
      dur[p] = sum + own;
    } else {
      let longest = 0;
      for (let j = 0; j < k; j++) longest = Math.max(longest, dur[childList[base + j]]);
      let end = 0;
      const rel = new Float64Array(k);
      for (let j = 0; j < k; j++) {
        const c = childList[base + j];
        rel[j] = Math.floor(r.off[c] * longest);
        end = Math.max(end, rel[j] + dur[c]);
      }
      const own = Math.max(2, Math.floor(r.self[p] * end));
      const lead = Math.floor(own * 0.3);
      for (let j = 0; j < k; j++) off[childList[base + j]] = lead + rel[j];
      dur[p] = end + own;
    }
  }
  const start = new Float64Array(n);
  for (let i = 1; i < n; i++) start[i] = start[parent[i]] + off[i];
  return { start, dur };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function makeEventFactory(rng, messages) {
  let seq = 0;
  return function makeEvent(timeNs, isErrorSpan) {
    const u = rng();
    const severity = isErrorSpan && u < 0.3 ? 'ERROR'
      : u < 0.80 ? 'INFO' : u < 0.90 ? 'DEBUG' : u < 0.97 ? 'WARN' : 'ERROR';
    seq++;
    return {
      timeUnixNano: nsString(timeNs),
      name: EVENT_NAMES[(rng() * EVENT_NAMES.length) | 0],
      attributes: [
        { key: 'severity', value: { stringValue: severity } },
        { key: 'message', value: { stringValue: messages[(rng() * messages.length) | 0] } },
        { key: 'logger', value: { stringValue: LOGGERS[(rng() * LOGGERS.length) | 0] } },
        { key: 'thread', value: { intValue: (rng() * THREADS) | 0 } },
        { key: 'seq', value: { intValue: seq } },
        { key: 'elapsedMs', value: { doubleValue: Math.round(rng() * 250000) / 100 } },
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a hierarchical trace.
 *
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ traceData: object, meta: object }} `meta` is computed from the
 *   TraceData itself by analyzeTrace(), plus the generator parameters.
 */
export function generateTrace(options = {}) {
  const t0 = now();
  const o = { ...DEFAULTS, ...options };
  const n = Math.max(1, Math.floor(o.n));
  const truncate = o.ns === 0 || o.ns === '0' || o.ns === false;
  const rng = mulberry32(o.seed);

  const tree = buildTree(n, rng, o);
  const timing = makeTimingRandomness(n, rng);

  const { start, dur } = assignTimes(tree, timing, o);
  const rootDuration = dur[0];

  const startNs = new Float64Array(n);
  const endNs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = start[i];
    const e = s + dur[i];
    startNs[i] = truncate ? Math.floor(s / 1e6) * 1e6 : s;
    endNs[i] = truncate ? Math.floor(e / 1e6) * 1e6 : e;
  }

  // names, services, kinds
  const namePool = buildNamePool(rng, 500);
  const nameZipf = makeZipf(rng, namePool.length, 0.9);
  const nameIdx = [];
  for (let i = 0; i < Math.min(n, namePool.length); i++) nameIdx.push(i);
  while (nameIdx.length < n) nameIdx.push(nameZipf());
  shuffle(rng, nameIdx);

  const svcZipf = makeZipf(rng, SERVICES.length, 1.1);
  const service = new Uint8Array(n);
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    service[i] = i === 0 ? 0 : (rng() < 0.55 ? service[tree.parent[i]] : svcZipf());
    const u = rng();
    let k = 0;
    while (u >= KIND_CUM[k]) k++;
    kind[i] = i === 0 ? 2 : KIND_VALUES[k];
  }

  // errors: seed then propagate to every ancestor (parents have smaller indices)
  const error = new Uint8Array(n);
  let seeded = 0;
  for (let i = 0; i < n; i++) if (rng() < o.errorRate) { error[i] = 1; seeded++; }
  for (let i = n - 1; i >= 1; i--) if (error[i]) error[tree.parent[i]] = 1;

  // events: ~ev per regular span, a few log-heavy spans
  const messages = buildMessagePool(rng, 600);
  const makeEvent = makeEventFactory(rng, messages);
  const eventCount = new Int32Array(n);
  for (let i = 0; i < n; i++) eventCount[i] = poisson(rng, o.ev);
  const heavyWanted = Math.max(1, Math.round(n * o.heavy));
  const candidates = [];
  for (let i = 0; i < n; i++) if (endNs[i] - startNs[i] >= 2e5 && tree.depth[i] >= 2) candidates.push(i);
  if (candidates.length < heavyWanted) for (let i = 0; i < n; i++) candidates.push(i);
  shuffle(rng, candidates);
  const heavy = [];
  for (let h = 0; h < heavyWanted && h < candidates.length; h++) {
    const i = candidates[h];
    eventCount[i] = h === 0
      ? o.heavyMax
      : Math.min(o.heavyMax, Math.floor(o.heavyMin * Math.pow(o.heavyMax / o.heavyMin, rng())));
    heavy.push(i);
  }

  // assemble spans
  const traceId = hex(rng, 16);
  const spanIds = new Array(n);
  const used = new Set();
  for (let i = 0; i < n; i++) {
    let id;
    do { id = hex(rng, 8); } while (used.has(id));
    used.add(id);
    spanIds[i] = id;
  }

  const bySvc = SERVICES.map(() => []);
  for (let i = 0; i < n; i++) {
    const s0 = startNs[i];
    const d0 = endNs[i] - s0;
    const ec = eventCount[i];
    const events = new Array(ec);
    if (ec > 0) {
      const offsets = new Float64Array(ec);
      for (let j = 0; j < ec; j++) offsets[j] = Math.floor(rng() * (d0 + 1));
      offsets.sort();
      for (let j = 0; j < ec; j++) {
        let t = s0 + offsets[j];
        if (truncate) t = Math.floor(t / 1e6) * 1e6;
        events[j] = makeEvent(t, error[i] === 1);
      }
    }
    const k = kind[i];
    const attributes = [
      { key: 'component', value: { stringValue: COMPONENTS[(rng() * COMPONENTS.length) | 0] } },
      { key: 'thread.id', value: { intValue: (rng() * THREADS) | 0 } },
      { key: 'log2trace.log_count', value: { intValue: ec } },
    ];
    if (k === 2 || k === 3) attributes.push({ key: 'http.status_code', value: { intValue: error[i] ? 500 : (rng() < 0.9 ? 200 : 404) } });
    if (k === 3) attributes.push({ key: 'peer.service', value: { stringValue: SERVICES[(rng() * SERVICES.length) | 0] } });
    bySvc[service[i]].push({
      traceId,
      spanId: spanIds[i],
      parentSpanId: i === 0 ? undefined : spanIds[tree.parent[i]],
      name: namePool[nameIdx[i]],
      kind: k,
      startTimeUnixNano: nsString(s0),
      endTimeUnixNano: nsString(endNs[i]),
      attributes,
      events,
      status: error[i] ? { code: 2, message: 'Internal Server Error' } : (rng() < 0.9 ? { code: 1 } : undefined),
    });
  }

  const resourceSpans = [];
  for (let s = 0; s < SERVICES.length; s++) {
    if (bySvc[s].length === 0) continue;
    resourceSpans.push({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: SERVICES[s] } }] },
      scopeSpans: [{ scope: { name: 'perf-gen', version: String(GEN_VERSION) }, spans: bySvc[s] }],
    });
  }
  const traceData = { resourceSpans };

  const meta = analyzeTrace(traceData);
  meta.generator = {
    kind: 'hierarchical',
    version: GEN_VERSION,
    params: { ...o, n, ns: truncate ? 0 : 1 },
    rootDurationMs: rootDuration / 1e6,
    errorsSeeded: seeded,
    megaFanout: tree.megaFanout,
    megaSpanIds: tree.megas.map((i) => spanIds[i]),
    chains: tree.chains.map((c) => ({ anchorSpanId: spanIds[c.anchor], tipSpanId: spanIds[c.tip], length: c.length, tipDepth: tree.depth[c.tip] })),
    heavySpanIds: heavy.slice(0, 5).map((i) => spanIds[i]),
    genMs: round(now() - t0, 1),
  };
  return { traceData, meta };
}

// ---------------------------------------------------------------------------
// Flat dataset of demo/benchmark.html (lines 167-210), seeded
// ---------------------------------------------------------------------------

const FLAT_SERVICES = ['api-gateway', 'user-service', 'order-service', 'payment-service', 'inventory-service'];
const FLAT_ACTIONS = [
  'handleRequest', 'authenticate', 'authorize', 'fetchData', 'processOrder',
  'validatePayment', 'checkInventory', 'sendNotification', 'logEvent', 'updateCache',
];

/** Same shape as benchmark.html's generateLogs(); `duration` uses the seeded RNG instead of Math.random(). */
export function generateFlatLogs(count, seed = 1) {
  const rng = mulberry32(seed);
  const logs = [];
  const traceCount = Math.max(1, Math.floor(count / 20));
  const baseTime = new Date('2026-03-23T10:00:00Z').getTime();
  for (let i = 0; i < count; i++) {
    const traceIdx = i % traceCount;
    const serviceIdx = i % FLAT_SERVICES.length;
    const actionIdx = Math.floor(i / traceCount) % FLAT_ACTIONS.length;
    const ts = baseTime + traceIdx * 5000 + (i / count) * 3000;
    logs.push({
      traceId: `trace-${traceIdx}`,
      service: FLAT_SERVICES[serviceIdx],
      action: FLAT_ACTIONS[actionIdx],
      timestamp: new Date(ts).toISOString(),
      level: i % 10 === 0 ? 'ERROR' : 'INFO',
      message: `Log entry ${i} for ${FLAT_ACTIONS[actionIdx]}`,
      requestId: `req-${traceIdx}-${serviceIdx}`,
      duration: rng() * 100,
      statusCode: i % 10 === 0 ? 500 : 200,
    });
  }
  return logs;
}

/** TransformConfig that benchmark.html feeds to transformLogs(). */
export const FLAT_TRANSFORM_CONFIG = Object.freeze({
  traceIdField: 'traceId',
  spanGroupFields: ['service', 'action'],
  spanNameField: 'action',
  serviceNameField: 'service',
  timestampField: 'timestamp',
  statusCodeField: 'statusCode',
});

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

/**
 * Dataset options from a URLSearchParams: n, seed, ns, flat, heavy, ev.
 * In flat mode `n` is still the number of spans: benchmark.html's flat data
 * yields one span per two logs, so 2n logs are generated (n=5000 is the
 * "10K logs" scale of benchmark.html).
 */
export function optionsFromParams(params) {
  const num = (key, fallback) => {
    const v = params.get(key);
    const x = v === null || v === '' ? NaN : Number(v.replace(/_/g, ''));
    return Number.isFinite(x) ? x : fallback;
  };
  const nRaw = params.get('n');
  let n = DEFAULTS.n;
  if (nRaw) {
    const m = /^([\d._]+)\s*([kKmM]?)$/.exec(nRaw);
    if (m) n = Math.round(Number(m[1].replace(/_/g, '')) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1));
  }
  return {
    n: Math.max(1, n),
    seed: num('seed', DEFAULTS.seed),
    ns: params.get('ns') === '0' ? 0 : 1,
    flat: params.get('flat') === '1',
    heavy: num('heavy', DEFAULTS.heavy),
    ev: num('ev', DEFAULTS.ev),
  };
}

// ---------------------------------------------------------------------------
// Analysis (works on any TraceData, generated or transformed)
// ---------------------------------------------------------------------------

const round = (x, digits = 2) => { const f = 10 ** digits; return Math.round(x * f) / f; };

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * Describe a TraceData: sizes, depth, fan-out, events, kinds, services, names,
 * errors, durations, plus "hot" spans the harness scenarios aim at.
 * Computed from the data itself, so the numbers describe exactly what a
 * renderer receives. O(n); not meant to run inside a timed region.
 */
export function analyzeTrace(traceData, { subtreeTarget } = {}) {
  const flat = [];
  const services = new Map();
  for (const rs of traceData.resourceSpans) {
    const svcAttr = rs.resource.attributes.find((a) => a.key === 'service.name');
    const svc = svcAttr?.value.stringValue ?? 'unknown-service';
    for (const ss of rs.scopeSpans) {
      for (const span of ss.spans) { flat.push(span); services.set(svc, (services.get(svc) ?? 0) + 1); }
    }
  }
  const n = flat.length;
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(flat[i].spanId, i);
  const parent = new Int32Array(n).fill(-1);
  const childCount = new Int32Array(n);
  let roots = 0;
  for (let i = 0; i < n; i++) {
    const pid = flat[i].parentSpanId;
    const p = pid ? index.get(pid) : undefined;
    if (p === undefined) roots++; else { parent[i] = p; childCount[p]++; }
  }
  // depth (parents are not guaranteed to precede children here)
  const depth = new Int32Array(n).fill(-1);
  const stack = [];
  for (let i = 0; i < n; i++) {
    let cur = i;
    while (cur !== -1 && depth[cur] === -1) { stack.push(cur); cur = parent[cur]; }
    let d = cur === -1 ? -1 : depth[cur];
    while (stack.length) depth[stack.pop()] = ++d;
  }
  let depthSum = 0, depthMax = 0;
  const depthHist = [];
  for (let i = 0; i < n; i++) {
    depthSum += depth[i];
    if (depth[i] > depthMax) depthMax = depth[i];
    depthHist[depth[i]] = (depthHist[depth[i]] ?? 0) + 1;
  }
  for (let d = 0; d <= depthMax; d++) depthHist[d] = depthHist[d] ?? 0;

  // subtree sizes: bucket by depth, then fold deepest first
  const byDepth = Array.from({ length: depthMax + 1 }, () => []);
  for (let i = 0; i < n; i++) byDepth[depth[i]].push(i);
  const subtree = new Int32Array(n).fill(1);
  for (let d = depthMax; d >= 1; d--) for (const i of byDepth[d]) subtree[parent[i]] += subtree[i];

  // fan-out classes over internal nodes
  const classes = { '1-3': 0, '4-12': 0, '13-19': 0, '20-60': 0, '61+': 0 };
  let internal = 0, fanMax = 0, fanSum = 0, widest = 0;
  for (let i = 0; i < n; i++) {
    const k = childCount[i];
    if (k === 0) continue;
    internal++; fanSum += k;
    if (k > fanMax) { fanMax = k; widest = i; }
    classes[k <= 3 ? '1-3' : k <= 12 ? '4-12' : k <= 19 ? '13-19' : k <= 60 ? '20-60' : '61+']++;
  }
  const fanoutPct = {};
  for (const [key, value] of Object.entries(classes)) fanoutPct[key] = internal ? round((100 * value) / internal, 1) : 0;

  // kinds, errors, names, events, durations
  const kinds = {};
  const names = new Set();
  let nameMax = 0, nonLatin = 0, errors = 0, events = 0, evMax = 0, heavyCount = 0, heavyIdx = -1, withEvents = 0;
  const durs = new Float64Array(n);
  const nonLatinRe = /[^\u0000-ɏ -⁯]/;
  let startMin = Infinity, endMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = flat[i];
    const label = KIND_LABELS[s.kind] ?? String(s.kind);
    kinds[label] = (kinds[label] ?? 0) + 1;
    if (!names.has(s.name)) { names.add(s.name); if (nonLatinRe.test(s.name)) nonLatin++; }
    if (s.name.length > nameMax) nameMax = s.name.length;
    if (s.status && s.status.code === 2) errors++;
    const ec = s.events ? s.events.length : 0;
    events += ec;
    if (ec > 0) withEvents++;
    if (ec >= 500) heavyCount++;
    if (ec > evMax) { evMax = ec; heavyIdx = i; }
    const sNs = BigInt(s.startTimeUnixNano);
    const eNs = BigInt(s.endTimeUnixNano);
    durs[i] = Number(eNs - sNs);
    const sMs = Number(sNs / 1000000n);
    const eMs = Number(eNs / 1000000n);
    if (sMs < startMin) startMin = sMs;
    if (eMs > endMax) endMax = eMs;
  }
  const sortedDur = Float64Array.from(durs).sort();
  let under1ms = 0, zero = 0;
  for (let i = 0; i < n; i++) { if (durs[i] < 1e6) under1ms++; if (durs[i] === 0) zero++; }

  // hot spans for the scenarios
  const target = subtreeTarget ?? Math.min(10000, Math.round(0.4 * n));
  let bigIdx = -1, bigGap = Infinity;
  for (let i = 0; i < n; i++) {
    if (parent[i] === -1 || childCount[i] === 0) continue;
    const gap = Math.abs(subtree[i] - 1 - target);
    if (gap < bigGap) { bigGap = gap; bigIdx = i; }
  }
  let deepest = 0;
  for (let i = 0; i < n; i++) if (depth[i] > depth[deepest]) deepest = i;
  let firstRoot = 0;
  for (let i = 0; i < n; i++) if (parent[i] === -1) { firstRoot = i; break; }
  const hotOf = (i, extra = {}) => (i < 0 ? null : { spanId: flat[i].spanId, name: flat[i].name.slice(0, 60), depth: depth[i], ...extra });

  return {
    spans: n,
    traceId: flat[firstRoot]?.traceId ?? '',
    roots,
    precision: durs.some((d, i) => d % 1e6 !== 0) ? 'ns' : 'ms',
    depth: { mean: round(depthSum / Math.max(1, n), 2), max: depthMax, histogram: depthHist },
    fanout: { internal, leaves: n - internal, mean: round(fanSum / Math.max(1, internal), 2), max: fanMax, classesPct: fanoutPct, classCounts: classes },
    kinds,
    services: { count: services.size, topShare: round(Math.max(0, ...services.values()) / Math.max(1, n), 3) },
    names: { distinct: names.size, maxLength: nameMax, nonLatin },
    errors: { total: errors, share: round(errors / Math.max(1, n), 4) },
    events: { total: events, perSpan: round(events / Math.max(1, n), 2), spansWithEvents: withEvents, max: evMax, heavySpans: heavyCount },
    durations: {
      traceMs: endMax - startMin,
      rootMs: round(durs[firstRoot] / 1e6, 3),
      p10Us: round(quantile(sortedDur, 0.10) / 1e3, 1),
      medianUs: round(quantile(sortedDur, 0.50) / 1e3, 1),
      p90Us: round(quantile(sortedDur, 0.90) / 1e3, 1),
      p99Us: round(quantile(sortedDur, 0.99) / 1e3, 1),
      maxMs: round(sortedDur[n - 1] / 1e6, 3),
      under1msShare: round(under1ms / Math.max(1, n), 3),
      zeroShare: round(zero / Math.max(1, n), 3),
    },
    hot: {
      root: hotOf(firstRoot, { descendants: subtree[firstRoot] - 1 }),
      bigSubtree: hotOf(bigIdx, { descendants: bigIdx < 0 ? 0 : subtree[bigIdx] - 1, target }),
      heavyEvents: hotOf(heavyIdx, { events: evMax }),
      widestFanout: hotOf(widest, { children: fanMax }),
      deepest: hotOf(deepest),
    },
  };
}
