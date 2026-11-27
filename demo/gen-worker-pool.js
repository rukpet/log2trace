/**
 * gen-worker-pool.js - deterministic, seeded generator for the "worker pool"
 * guide dataset (demo/data/worker-pool-trace.json), built to showcase the
 * per-service swimlane ("lanes") view.
 *
 * Run `node demo/gen-worker-pool.js` to (re)write the JSON file. Plain ES
 * module, no DOM, no Math.random: the same seed always yields byte-identical
 * output. `generateWorkerPoolTrace()` returns the OTLP/JSON object.
 *
 * Scenario (one trace, ~138 spans, ~0.77 s, 4 instrumented services + 4 uninstrumented peers):
 *  - `ingest-api` receives a synchronous "POST /batches?wait=true", runs a
 *    short validation and calls `job-scheduler`.
 *  - `job-scheduler` first calls the uninstrumented `feature-flags` service
 *    (server.address flags.internal, ~120 ms, no child spans). Dispatch is
 *    blocked meanwhile, so every worker lane is idle for that long: this is
 *    the visible idle gap. It then PRODUCER-publishes 40 tasks to the kafka
 *    topic `image-tasks` (leaf spans).
 *  - `image-worker` is a pool with exactly 8 slots. The 40 CONSUMER spans
 *    "process image" (40-160 ms each) are scheduled through a real queue, so
 *    at most 8 run at once and the pool stays pinned at 8 until the tail.
 *    Tasks have INTERNAL children (decode/resize/encode or transform) and
 *    CLIENT leaf calls to the uninstrumented `s3` and `postgresql` peers.
 *    Three tasks fail (deadlock on the jobs DB, S3 SlowDown, encoder error);
 *    the error propagates from the failing child to the consumer span.
 *  - After the last task, the scheduler publishes `batch-completed` and
 *    `notifier` consumes it, calling an external webhook (hooks.example.com).
 *
 * Shape matches the other guide datasets (resourceSpans > scopeSpans > spans,
 * numeric SpanKind, nanosecond timestamps as strings).
 */

export const GEN_VERSION = 1;

export const DEFAULTS = Object.freeze({
  seed: 20241127,
  tasks: 40,
  slots: 8,
  flagsMs: 120,
});

/** 2024-11-27T08:13:20Z in epoch nanoseconds. */
const EPOCH_NS = 1_732_700_000_000_000_000n;

const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };

/** Task indexes that fail, and where. */
const FAILURES = { 7: 'pg', 19: 's3', 31: 'encode' };

// ---------------------------------------------------------------------------
// Helpers
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

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

/** Convert fractional milliseconds since trace start to a nanosecond string. */
const nsAt = (ms) => (EPOCH_NS + BigInt(Math.round(ms * 1e6))).toString();

/** OTLP attribute value from a JS value. */
function attr(key, v) {
  let value;
  if (typeof v === 'boolean') value = { boolValue: v };
  else if (typeof v === 'number' && Number.isInteger(v)) value = { intValue: String(v) };
  else if (typeof v === 'number') value = { doubleValue: v };
  else value = { stringValue: String(v) };
  return { key, value };
}
const attrs = (obj) => Object.entries(obj).map(([k, v]) => attr(k, v));

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateWorkerPoolTrace(options = {}) {
  const { seed, tasks: nTasks, slots: nSlots, flagsMs } = { ...DEFAULTS, ...options };
  const rng = mulberry32(seed);
  const rand = (lo, hi) => lo + rng() * (hi - lo);
  const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  const traceId = hex8(rng() * 4294967296) + hex8(rng() * 4294967296) +
    hex8(rng() * 4294967296) + hex8(rng() * 4294967296);
  const usedIds = new Set();
  const newId = () => {
    for (;;) {
      const id = hex8(rng() * 4294967296) + hex8(rng() * 4294967296);
      if (!usedIds.has(id) && id !== '0000000000000000') { usedIds.add(id); return id; }
    }
  };

  /** service name -> spans[] (in creation order, sorted by start at the end) */
  const byService = new Map();

  /** Create a span; times are fractional ms since trace start. */
  function span(service, parent, name, kind, startMs, endMs, attributes, extra = {}) {
    const s = {
      traceId,
      spanId: newId(),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      kind,
      startTimeUnixNano: nsAt(startMs),
      endTimeUnixNano: nsAt(Math.max(endMs, startMs + 0.001)),
      attributes: attrs(attributes),
      status: { code: 1 },
    };
    if (extra.events) s.events = extra.events;
    if (extra.error) s.status = { code: 2, message: extra.error };
    if (!byService.has(service)) byService.set(service, []);
    byService.get(service).push(s);
    return s;
  }
  const event = (ms, name, attributes = {}) => ({ timeUnixNano: nsAt(ms), name, attributes: attrs(attributes) });
  const exception = (ms, type, message) =>
    event(ms, 'exception', { 'exception.type': type, 'exception.message': message });

  // ---- timeline of the front half ----------------------------------------
  const rootStart = 0;
  const validateStart = 0.6;
  const validateEnd = validateStart + 9.4;
  const callStart = validateEnd + 1.2;            // ingest-api -> job-scheduler
  const schedStart = callStart + 2.1;             // network + server accept
  const flagsStart = schedStart + 4.3;
  const flagsEnd = flagsStart + flagsMs + rand(-3, 3);

  // ---- publish 40 tasks -----------------------------------------------------
  // Spans are created later (parents first), so only compute times here.
  const pubs = [];
  let t = flagsEnd + 2.4;
  for (let i = 0; i < nTasks; i++) {
    const dur = rand(0.5, 1.1);
    pubs.push({ start: t, end: t + dur });
    t += dur + rand(0.3, 0.9);
  }
  const lastPubEnd = pubs[pubs.length - 1].end;

  // ---- simulate the worker pool queue (8 slots) -------------------------
  const slotFree = new Array(nSlots).fill(0);
  const jobs = [];
  for (let i = 0; i < nTasks; i++) {
    const arrive = pubs[i].end + rand(2.6, 4.2);   // broker + poll latency
    let k = 0;
    for (let s = 1; s < nSlots; s++) if (slotFree[s] < slotFree[k]) k = s;
    const start = Math.max(arrive, slotFree[k]) + rand(0.05, 0.35); // ack / handoff
    const dur = rand(40, 160);
    const end = start + dur;
    slotFree[k] = end;
    jobs.push({ i, slot: k, arrive, start, end, dur, wait: start - arrive });
  }
  const lastTaskEnd = Math.max(...jobs.map((j) => j.end));

  // ---- tail: completion event + webhook -----------------------------------
  const donePubStart = lastTaskEnd + 1.8;
  const donePubEnd = donePubStart + 0.8;
  const notifStart = donePubEnd + 3.1;
  const hookStart = notifStart + 2.0;
  const hookEnd = hookStart + rand(55, 70);
  const notifEnd = hookEnd + 1.4;
  const schedEnd = notifEnd + 1.5;
  const callEnd = schedEnd + 1.0;
  const rootEnd = callEnd + 1.2;

  // ---- ingest-api ---------------------------------------------------------
  const failed = Object.keys(FAILURES).length;
  const root = span('ingest-api', null, 'POST /batches', KIND.SERVER, rootStart, rootEnd, {
    'http.request.method': 'POST',
    'http.route': '/batches',
    'url.path': '/batches',
    'url.query': 'wait=true',
    'http.response.status_code': 207,
    'batch.id': 'bat_7f3a91c2',
    'batch.size': nTasks,
    'client.address': '10.20.4.17',
  }, {
    events: [
      event(rootStart + 0.2, 'request.accepted', { 'http.request.body.size': 18432 }),
      event(rootEnd - 0.4, 'response.sent', { 'batch.failed': failed, 'batch.succeeded': nTasks - failed }),
    ],
  });
  span('ingest-api', root, 'validate batch', KIND.INTERNAL, validateStart, validateEnd, {
    'batch.items': nTasks,
    'validation.schema': 'image-batch.v4',
  }, { events: [event(validateEnd - 0.5, 'validation.passed', { 'items.checked': nTasks })] });
  const call = span('ingest-api', root, 'POST job-scheduler /v1/schedule', KIND.CLIENT, callStart, callEnd, {
    'http.request.method': 'POST',
    'url.full': 'http://job-scheduler.svc.cluster.local:8080/v1/schedule',
    'server.address': 'job-scheduler.svc.cluster.local',
    'server.port': 8080,
    'http.response.status_code': 200,
  });

  // ---- job-scheduler ------------------------------------------------------
  const sched = span('job-scheduler', call, 'schedule batch', KIND.SERVER, schedStart, schedEnd, {
    'http.request.method': 'POST',
    'http.route': '/v1/schedule',
    'http.response.status_code': 200,
    'batch.id': 'bat_7f3a91c2',
    'batch.size': nTasks,
    'scheduler.partition_count': 8,
  }, {
    events: [
      event(flagsEnd, 'flags.resolved', { 'flag.key': 'image-pipeline.avif-output', 'flag.variant': 'on' }),
      event(lastPubEnd, 'dispatch.complete', { 'tasks.published': nTasks }),
      event(lastTaskEnd, 'tasks.drained', { 'tasks.failed': failed }),
    ],
  });
  span('job-scheduler', sched, 'GET /v1/flags/evaluate', KIND.CLIENT, flagsStart, flagsEnd, {
    'http.request.method': 'GET',
    'url.full': 'https://flags.internal/v1/flags/evaluate',
    'server.address': 'flags.internal',
    'server.port': 443,
    'http.response.status_code': 200,
    'peer.service': 'feature-flags',
  });

  const producers = pubs.map((p, i) => span('job-scheduler', sched, 'image-tasks publish', KIND.PRODUCER, p.start, p.end, {
    'messaging.system': 'kafka',
    'messaging.destination.name': 'image-tasks',
    'messaging.operation': 'publish',
    'messaging.kafka.destination.partition': i % nSlots,
    'messaging.message.id': `img-task-${String(i).padStart(3, '0')}`,
  }));

  // ---- image-worker: 40 tasks ---------------------------------------------
  // Template per task: 4 "full" (decode/resize/encode), 12 s3, 12 postgres,
  // 12 plain transform. Failing tasks are pinned to a matching template.
  const templates = [
    ...Array(4).fill('full'), ...Array(12).fill('s3'),
    ...Array(12).fill('pg'), ...Array(Math.max(nTasks - 28, 0)).fill('plain'),
  ];
  shuffle(rng, templates);
  for (const [idx, where] of Object.entries(FAILURES)) {
    templates[idx] = where === 'encode' ? 'full' : where;
  }

  const buckets = ['photos-raw', 'photos-raw', 'photos-raw', 'catalog-raw'];
  let s3Seq = 0;
  jobs.forEach((j) => {
    const i = j.i;
    const tpl = templates[i];
    const failWhere = FAILURES[i];
    const imageId = `img_${(0x4a1000 + i * 37).toString(16)}`;
    const ev = [event(j.start, 'task.dequeued', { 'queue.wait_ms': Math.round(j.wait * 10) / 10, 'worker.slot': j.slot })];

    // Child layout first, so the consumer can inherit the failure.
    const kids = [];
    let failMsg = null;
    let failType = null;
    let failAt = j.end;
    const d = j.dur;
    const at = (frac) => j.start + d * frac;

    if (tpl === 'full') {
      kids.push(['decode', KIND.INTERNAL, at(0.03), at(0.2), { 'image.codec': 'jpeg', 'image.megapixels': Math.round(rand(6, 24) * 10) / 10 }]);
      kids.push(['resize', KIND.INTERNAL, at(0.19), at(0.62), { 'image.target': '1600x1200', 'image.filter': 'lanczos3' }]);
      if (failWhere === 'encode') {
        failMsg = 'unsupported ICC profile: CMYK to sRGB conversion failed';
        failType = 'EncoderError';
        failAt = at(0.9);
        kids.push(['encode', KIND.INTERNAL, at(0.62), failAt, { 'image.codec': 'avif', 'image.quality': 80 },
          { error: failMsg, events: [exception(failAt - 0.2, failType, failMsg)] }]);
      } else {
        kids.push(['encode', KIND.INTERNAL, at(0.62), at(0.94), { 'image.codec': 'avif', 'image.quality': 80 }]);
      }
    } else if (tpl === 'plain') {
      kids.push(['transform', KIND.INTERNAL, at(0.04), at(0.95), { 'image.pipeline': 'thumbnail-256', 'image.codec': 'webp' },
        { events: [event(at(0.5), 'transform.progress', { 'progress.pct': 50 })] }]);
    } else if (tpl === 's3') {
      const put = i % 2 === 1;
      const key = `${buckets[i % buckets.length]}/${imageId}.jpg`;
      s3Seq++;
      const a = put ? at(0.62) : at(0.04);
      let b = put ? at(0.96) : at(0.04 + rand(0.25, 0.4));
      const base = {
        'http.request.method': put ? 'PUT' : 'GET',
        'url.full': `https://s3.eu-west-1.amazonaws.com/${key}`,
        'server.address': 's3.eu-west-1.amazonaws.com',
        'server.port': 443,
        'rpc.system': 'aws-api',
        'aws.s3.bucket': key.split('/')[0],
      };
      if (failWhere === 's3') {
        failMsg = '503 SlowDown: please reduce your request rate';
        failType = 'S3Exception';
        b = at(0.93);
        kids.push([put ? 'PUT s3 object' : 'GET s3 object', KIND.CLIENT, a, b,
          { ...base, 'http.response.status_code': 503 },
          { error: failMsg, events: [exception(b - 0.2, failType, failMsg)] }]);
        failAt = b;
      } else {
        kids.push([put ? 'PUT s3 object' : 'GET s3 object', KIND.CLIENT, a, b, {
          ...base,
          'http.response.status_code': 200,
          'http.response.body.size': put ? 188244 : 2412907,
        }]);
      }
    } else { // pg
      const dur = Math.min(rand(9, 24), d * 0.4);
      const b = failWhere === 'pg' ? at(0.92) : at(0.96);
      const base = {
        'db.system': 'postgresql',
        'db.name': 'jobs',
        'db.operation': 'UPDATE',
        'db.statement': 'UPDATE image_jobs SET status = $1, output_key = $2, finished_at = now() WHERE id = $3',
        'server.address': 'pg-primary.jobs.internal',
        'server.port': 5432,
      };
      if (failWhere === 'pg') {
        failMsg = 'deadlock detected: process 4182 waits for ShareLock on transaction 90211';
        failType = 'PSQLException';
        kids.push(['UPDATE jobs.image_jobs', KIND.CLIENT, b - dur, b, base,
          { error: failMsg, events: [exception(b - 0.3, failType, failMsg)] }]);
        failAt = b;
      } else {
        kids.push(['UPDATE jobs.image_jobs', KIND.CLIENT, b - dur, b, base]);
      }
    }

    // A failing task ends right after its failing child.
    const consumerEnd = failMsg ? failAt + rand(0.15, 0.4) : j.end;
    if (failMsg) {
      ev.push(exception(consumerEnd - 0.05, 'TaskExecutionError', `image task ${imageId} failed: ${failMsg}`));
      // Keep slot accounting honest: nothing else started on this slot yet if
      // the failure shortens the span, so shorten only within the original end.
      j.end = Math.min(j.end, consumerEnd);
    }

    const consumer = span('image-worker', producers[i], 'process image', KIND.CONSUMER, j.start, consumerEnd, {
      'messaging.system': 'kafka',
      'messaging.destination.name': 'image-tasks',
      'messaging.operation': 'process',
      'messaging.consumer.group.name': 'image-workers',
      'messaging.message.id': `img-task-${String(i).padStart(3, '0')}`,
      'worker.slot': j.slot,
      'image.id': imageId,
      'image.bytes': randInt(180_000, 3_200_000),
    }, {
      events: ev,
      ...(failMsg ? { error: `image task ${imageId} failed: ${failMsg}` } : {}),
    });

    for (const [name, kind, a, b, at_, extra] of kids) {
      span('image-worker', consumer, name, kind, a, Math.min(b, consumerEnd - 0.05), at_, extra || {});
    }
  });

  // ---- completion + notifier ----------------------------------------------
  const donePub = span('job-scheduler', sched, 'batch-completed publish', KIND.PRODUCER, donePubStart, donePubEnd, {
    'messaging.system': 'kafka',
    'messaging.destination.name': 'batch-completed',
    'messaging.operation': 'publish',
    'messaging.message.id': 'bat_7f3a91c2-done',
    'batch.failed': failed,
  });
  const notif = span('notifier', donePub, 'send completion webhook', KIND.CONSUMER, notifStart, notifEnd, {
    'messaging.system': 'kafka',
    'messaging.destination.name': 'batch-completed',
    'messaging.operation': 'process',
    'messaging.consumer.group.name': 'notifier',
    'batch.id': 'bat_7f3a91c2',
  }, { events: [event(notifStart + 0.1, 'message.received', { 'messaging.message.body.size': 212 })] });
  span('notifier', notif, 'POST hooks.example.com /batches/complete', KIND.CLIENT, hookStart, hookEnd, {
    'http.request.method': 'POST',
    'url.full': 'https://hooks.example.com/batches/complete',
    'server.address': 'hooks.example.com',
    'server.port': 443,
    'http.response.status_code': 204,
  });

  // ---- assemble resourceSpans ---------------------------------------------
  const resources = [
    ['ingest-api', '2.8.1', 'ingest-api-6d9f7c8b54-q2xk7', 'ingest-api.tracer'],
    ['job-scheduler', '1.14.0', 'job-scheduler-0', 'job-scheduler.tracer'],
    ['image-worker', '5.2.3', 'image-worker-pool-0', 'image-worker.tracer'],
    ['notifier', '0.9.4', 'notifier-5b7d9c6f88-m4tzr', 'notifier.tracer'],
  ];
  const resourceSpans = resources.map(([service, version, host, scope]) => ({
    resource: {
      attributes: attrs({
        'service.name': service,
        'service.version': version,
        'deployment.environment': 'production',
        'host.name': host,
        'cloud.region': 'eu-west-1',
      }),
    },
    scopeSpans: [{
      scope: { name: scope, version: '1.0.0' },
      spans: byService.get(service).slice().sort((a, b) =>
        a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0),
    }],
  }));

  return { resourceSpans };
}

// ---------------------------------------------------------------------------
// CLI: `node demo/gen-worker-pool.js` writes demo/data/worker-pool-trace.json
// ---------------------------------------------------------------------------

const isMain = typeof process !== 'undefined' && process.argv && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const { writeFileSync } = await import('node:fs');
  const out = new URL('./data/worker-pool-trace.json', import.meta.url);
  const trace = generateWorkerPoolTrace();
  writeFileSync(out, JSON.stringify(trace, null, 2) + '\n');
  const n = trace.resourceSpans.reduce((a, r) => a + r.scopeSpans.reduce((b, s) => b + s.spans.length, 0), 0);
  console.log(`wrote ${out.pathname} (${n} spans)`);
}
