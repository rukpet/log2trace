// A/B runner for demo/perf.html: canvas against dom across browsers, pixel ratios, CPU throttling and sizes.
//
//   node demo/server.js &                      # serves perf.html and dist/ on :3000
//   node baseline/tools/ab-run.mjs <out dir> [--browsers chrome,firefox] [--reps 2] [--sizes 5000,50000]
//                                  [--only dpr1,dpr2,dpr2-cpu4] [--scenarios first-render,wheel-zoom,...]
//
// For every browser, configuration, size, renderer and repeat it starts a fresh headless browser on
// perf.html with `auto=1` and a `sink` pointing at this process, waits for the result and writes
// <out dir>/<browser>-<config>-n<size>-<impl>.run<k>.json. Chrome gets its pixel ratio from a launch flag and
// its CPU throttling from the DevTools protocol; Firefox gets the pixel ratio from a profile preference and
// cannot be throttled. The order alternates between renderers on every repeat so that drift (thermal state,
// background load) does not favour one of them. aggregate-ab.mjs turns the files into a table.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const OUT = args[0];
if (!OUT) throw new Error('usage: ab-run.mjs <out dir> [options]');
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at > 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const BROWSERS = opt('browsers', 'chrome,firefox').split(',');
const REPS = Number(opt('reps', '2'));
const SIZES = opt('sizes', '5000,50000').split(',').map(Number);
const ONLY_CONFIGS = opt('only', '').split(',').filter(Boolean);
const SCENARIOS = opt('scenarios', '');
const PORT = 3921;
const PAGE = 'http://localhost:3000/perf.html';
const WIDTH = 1400;
const HEIGHT = 800;
const TIMEOUT_MS = Number(opt('timeout', String(12 * 60 * 1000)));

const PATHS = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe'],
  firefox: ['C:/Program Files/Mozilla Firefox/firefox.exe'],
};

const CONFIGS = {
  chrome: [
    { id: 'dpr1', dpr: 1, cpu: 1 },
    { id: 'dpr2', dpr: 2, cpu: 1 },
    { id: 'dpr2-cpu4', dpr: 2, cpu: 4 },
  ],
  firefox: [
    { id: 'dpr1', dpr: 1, cpu: 1 },
    { id: 'dpr2', dpr: 2, cpu: 1 },
  ],
};

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The sink: perf.html POSTs its beacons and its result here.
// ---------------------------------------------------------------------------

let waiting = null;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200, cors); return res.end('ab sink ok'); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, cors);
    res.end('ok');
    try {
      const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (msg.kind === 'result' && waiting) waiting.resolve(msg.result);
      else if (msg.kind === 'hang' && waiting) waiting.note = `hang: ${JSON.stringify(msg.info)}`;
    } catch { /* a malformed beacon is not worth stopping for */ }
  });
}).listen(PORT);

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

function executable(browser) {
  const found = PATHS[browser].find((p) => fs.existsSync(p));
  if (!found) throw new Error(`${browser} not found`);
  return found;
}

function killTree(child) {
  if (!child || child.pid === undefined) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function cdpThrottle(port, rate) {
  let target = null;
  for (let i = 0; i < 100 && target === null; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page') ?? null;
    } catch { /* the browser is still starting */ }
    if (target === null) await new Promise((r) => setTimeout(r, 100));
  }
  if (target === null) throw new Error('no page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await new Promise((resolve) => {
    socket.onmessage = (event) => { if (JSON.parse(event.data).id === 1) resolve(); };
    socket.send(JSON.stringify({ id: 1, method: 'Emulation.setCPUThrottlingRate', params: { rate } }));
  });
  return socket; // keep it open: the throttling ends with the session
}

function launch(browser, config, url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `l2t-ab-${browser}-`));
  if (browser === 'chrome') {
    const port = 9340 + Math.floor(Math.random() * 500);
    const child = spawn(executable('chrome'), [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${config.dpr}`, `--window-size=${WIDTH},${HEIGHT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--enable-precise-memory-info', '--enable-benchmarking', 'about:blank',
    ], { stdio: 'ignore' });
    return { child, profile, port, url };
  }
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("layout.css.devPixelsPerPx", "${config.dpr}.0");`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  ].join('\n'));
  const child = spawn(executable('firefox'), ['--headless', '--no-remote', '--profile', profile, '--width', String(WIDTH), '--height', String(HEIGHT), url], { stdio: 'ignore' });
  return { child, profile, port: 0, url };
}

async function runOnce(browser, config, size, impl) {
  const params = new URLSearchParams({ impl, n: String(size), auto: '1', sink: `http://localhost:${PORT}/save`, wd: '120', budget: '900', mem: '0' });
  if (SCENARIOS) params.set('only', SCENARIOS);
  const url = `${PAGE}#${params}`;

  const result = new Promise((resolve) => { waiting = { resolve, note: '' }; });
  const session = launch(browser, config, browser === 'chrome' ? 'about:blank' : url);
  let socket = null;
  try {
    if (browser === 'chrome') {
      socket = await cdpThrottle(session.port, config.cpu);
      // navigate after the throttling is set, so that the whole run is throttled
      await new Promise((resolve) => {
        socket.onmessage = (event) => { if (JSON.parse(event.data).id === 2) resolve(); };
        socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url } }));
      });
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ status: 'runner-timeout' }), TIMEOUT_MS));
    return await Promise.race([result, timeout]);
  } finally {
    try { socket?.close(); } catch { /* already closed */ }
    killTree(session.child);
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(session.profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
    waiting = null;
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const plan = [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const browser of BROWSERS) {
    for (const config of CONFIGS[browser]) {
      if (ONLY_CONFIGS.length > 0 && !ONLY_CONFIGS.includes(config.id)) continue;
      for (const size of SIZES) {
        const impls = rep % 2 === 1 ? ['dom', 'canvas'] : ['canvas', 'dom'];
        for (const impl of impls) plan.push({ browser, config, size, impl, rep });
      }
    }
  }
}

console.log(`${plan.length} runs -> ${OUT}`);
let done = 0;
for (const item of plan) {
  const name = `${item.browser}-${item.config.id}-n${item.size}-${item.impl}.run${item.rep}`;
  const file = path.join(OUT, `${name}.json`);
  if (fs.existsSync(file)) { done++; continue; }
  const started = Date.now();
  let result;
  try {
    result = await runOnce(item.browser, item.config, item.size, item.impl);
  } catch (error) {
    result = { status: 'runner-error', error: String(error) };
  }
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  done++;
  console.log(`[${done}/${plan.length}] ${name}: ${result.status} in ${Math.round((Date.now() - started) / 1000)} s`);
}
console.log('done');
process.exit(0);
