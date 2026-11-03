// Aggregate repeated runs into median/min/max tables (and summary.json):
//   node baseline/tools/aggregate.mjs baseline [--json baseline/summary.json]
// Reads <dir>/current-n<N>.run<k>.json (copy the files the collector wrote to those names, one per repeat) and
// <dir>/current-n<N>.zoom-dnf.json (marks zoom/pan as DNF for that size). Prints markdown to stdout.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const outIdx = process.argv.indexOf('--json');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const sizes = [1000, 5000, 10000, 20000, 50000];

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const get = (r, f) => { try { return num(f(r)); } catch { return null; } };
const sc = (r, n) => (r.scenarios && r.scenarios[n]) || null;
const fr = (name, sub, key) => (r) => { const s = sc(r, name); const x = sub ? s && s[sub] : s; return x && x.frames ? x.frames[key] : null; };

const metrics = {
  spans: (r) => r.dataset.spans,
  events: (r) => r.dataset.events.total,
  domElements: (r) => sc(r, 'first-render').dom.elements,
  firstRenderJsMs: (r) => sc(r, 'first-render').jsMs,
  firstRenderToFrameMs: (r) => sc(r, 'first-render').toFirstFrameMs,
  wheelZoomP50: fr('wheel-zoom', null, 'p50'), wheelZoomP95: fr('wheel-zoom', null, 'p95'), wheelZoomMax: fr('wheel-zoom', null, 'max'),
  wheelZoomFrames: (r) => sc(r, 'wheel-zoom').framesDone,
  wheelZoomOver33: fr('wheel-zoom', null, 'over33'),
  dragPanP50: fr('drag-pan', null, 'p50'), dragPanP95: fr('drag-pan', null, 'p95'), dragPanMax: fr('drag-pan', null, 'max'),
  dragPanFrames: (r) => sc(r, 'drag-pan').framesDone, dragPanZoom: (r) => sc(r, 'drag-pan').zoomAchieved,
  hoverP50: fr('hover', null, 'p50'), hoverP95: fr('hover', null, 'p95'), hoverMax: fr('hover', null, 'max'),
  selectP50: (r) => sc(r, 'select').toFrame.p50, selectP95: (r) => sc(r, 'select').toFrame.p95, selectMax: (r) => sc(r, 'select').toFrame.max,
  selectHeavyMs: (r) => sc(r, 'select').heavySpan.toFrameMs, selectHeavyNodes: (r) => sc(r, 'select').heavySpan.detailNodes,
  selectTypicalNodes: (r) => sc(r, 'select').detailNodesTypical,
  hoverAZP50: fr('hover-after-zoom', null, 'p50'), hoverAZP95: fr('hover-after-zoom', null, 'p95'), hoverAZMax: fr('hover-after-zoom', null, 'max'),
  selectAZP50: (r) => sc(r, 'select-after-zoom').toFrame.p50, selectAZP95: (r) => sc(r, 'select-after-zoom').toFrame.p95, selectAZMax: (r) => sc(r, 'select-after-zoom').toFrame.max,
  selectAZHeavyMs: (r) => sc(r, 'select-after-zoom').heavySpan.toFrameMs,
  selectCount: (r) => sc(r, 'select').selected,
  resizeP50: fr('resize', null, 'p50'), resizeP95: fr('resize', null, 'p95'), resizeMax: fr('resize', null, 'max'),
  collapseP50: (r) => sc(r, 'collapse').collapse.toFrame.p50, expandP50: (r) => sc(r, 'collapse').expand.toFrame.p50,
  collapseAllP50: (r) => sc(r, 'collapse').collapseAll.toFrame.p50, expandAllP50: (r) => sc(r, 'collapse').expandAll.toFrame.p50,
  collapseOps: (r) => sc(r, 'collapse').opsDone,
  filterSelectiveP50: (r) => sc(r, 'filter').selective.p50, filterBroadP50: (r) => sc(r, 'filter').broad.p50, filterClearP50: (r) => sc(r, 'filter').clear.p50,
  scrollSmoothP50: fr('scroll', 'smooth', 'p50'), scrollSmoothP95: fr('scroll', 'smooth', 'p95'), scrollSmoothMax: fr('scroll', 'smooth', 'max'),
  scrollJumpsP50: fr('scroll', 'jumps', 'p50'), scrollJumpsP95: fr('scroll', 'jumps', 'p95'), scrollJumpsMax: fr('scroll', 'jumps', 'max'),
  longTasks: (r) => Object.values(r.scenarios).reduce((a, s) => a + (s.longTasks ? s.longTasks.count : 0), 0),
  longTaskMs: (r) => Object.values(r.scenarios).reduce((a, s) => a + (s.longTasks ? s.longTasks.totalMs : 0), 0),
  jsHeapEndMB: (r) => r.checkpoints.find((c) => c.label === 'end').jsHeapUsed / 1048576,
  jsHeapDataMB: (r) => r.checkpoints.find((c) => c.label === 'dataReady').jsHeapUsed / 1048576,
  jsHeapRenderMB: (r) => r.checkpoints.find((c) => c.label === 'afterFirstRender').jsHeapUsed / 1048576,
  probeCpuStartMs: (r) => r.env.probe.cpu.p50Ms, probeCpuEndMs: (r) => r.probeEnd && r.probeEnd.cpu.p50Ms,
  probePipelineP95Ms: (r) => r.env.probe.pipeline.p95,
  wallSec: (r) => r.totalMs / 1000,
};

const out = { generatedAt: new Date().toISOString(), sizes: {} };
for (const n of sizes) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`current-n${n}.run`) && f.endsWith('.json')).sort() : [];
  if (!files.length) continue;
  const runs = files.map((f) => ({ file: f, r: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const ok = runs.filter((x) => x.r.status === 'complete' || x.r.status === 'partial');
  const entry = { runs: runs.length, usable: ok.length, files, statuses: runs.map((x) => x.r.status), zoomDnf: fs.existsSync(path.join(dir, `current-n${n}.zoom-dnf.json`)), metrics: {} };
  for (const [name, f] of Object.entries(metrics)) {
    const values = ok.map((x) => get(x.r, f));
    const vs = values.filter((v) => v !== null);
    entry.metrics[name] = vs.length ? { median: median(vs), min: Math.min(...vs), max: Math.max(...vs), values } : null;
  }
  out.sizes[n] = entry;
}

if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

const fmt = (x, d = 0) => (x === null || x === undefined ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));
const m = (e, k, d) => (e && e.metrics[k] ? fmt(e.metrics[k].median, d) : '–');
const spread = (e, k, d) => (e && e.metrics[k] ? `${fmt(e.metrics[k].min, d)}–${fmt(e.metrics[k].max, d)}` : '–');
const label = (n) => `${n / 1000}K`;
const have = sizes.filter((n) => out.sizes[n]);
const table = (title, rows) => {
  console.log(`\n### ${title}\n`);
  console.log(`| Metric | ${have.map(label).join(' | ')} |`);
  console.log(`|---|${have.map(() => '---:').join('|')}|`);
  for (const [name, f] of rows) console.log(`| ${name} | ${have.map((n) => f(out.sizes[n])).join(' | ')} |`);
};
const tri = (a, b, c, d = 0) => (e) => (e.metrics[a] ? `${m(e, a, d)} / ${m(e, b, d)} / ${m(e, c, d)}` : '–');

table('Medians over runs', [
  ['Runs (usable / total)', (e) => `${e.usable} / ${e.runs}`],
  ['Spans / events', (e) => `${m(e, 'spans')} / ${m(e, 'events')}`],
  ['DOM elements after first render', (e) => m(e, 'domElements')],
  ['First render: JS sync (ms)', (e) => m(e, 'firstRenderJsMs')],
  ['First render: to first frame (ms)', (e) => m(e, 'firstRenderToFrameMs')],
  ['Wheel zoom: frame p50 / p95 / max (ms)', (e) => (e.zoomDnf ? 'DNF' : tri('wheelZoomP50', 'wheelZoomP95', 'wheelZoomMax')(e))],
  ['Wheel zoom: frames done of 120 / % over 33 ms', (e) => (e.zoomDnf ? 'DNF' : `${m(e, 'wheelZoomFrames')} / ${m(e, 'wheelZoomOver33', 0)}%`)],
  ['Drag pan (zoom reached): frame p50 / p95 / max (ms)', (e) => (e.zoomDnf ? 'DNF' : `${tri('dragPanP50', 'dragPanP95', 'dragPanMax')(e)} (${m(e, 'dragPanZoom', 1)}×, ${m(e, 'dragPanFrames')} fr.)`)],
  ['Hover: frame p50 / p95 / max (ms)', tri('hoverP50', 'hoverP95', 'hoverMax')],
  ['Select 50 rows: action→frame p50 / p95 / max (ms)', tri('selectP50', 'selectP95', 'selectMax')],
  ['Select 2000-event span: ms / detail DOM nodes', (e) => `${m(e, 'selectHeavyMs')} / ${m(e, 'selectHeavyNodes')}`],
  ['Hover after zoom: frame p50 / p95 / max (ms)', tri('hoverAZP50', 'hoverAZP95', 'hoverAZMax')],
  ['Select after zoom (12 rows): action→frame p50 / p95 / max (ms)', tri('selectAZP50', 'selectAZP95', 'selectAZMax')],
  ['Select 2000-event span after zoom (ms)', (e) => m(e, 'selectAZHeavyMs')],
  ['Resize: frame p50 / p95 / max (ms)', tri('resizeP50', 'resizeP95', 'resizeMax')],
  ['Collapse subtree p50 / expand p50 (ms) [ops done]', (e) => `${m(e, 'collapseP50')} / ${m(e, 'expandP50')} [${m(e, 'collapseOps')}]`],
  ['collapseAll / expandAll p50 (ms)', (e) => `${m(e, 'collapseAllP50')} / ${m(e, 'expandAllP50')}`],
  ['Filter selective / broad / clear p50 (ms)', (e) => `${m(e, 'filterSelectiveP50')} / ${m(e, 'filterBroadP50')} / ${m(e, 'filterClearP50')}`],
  ['Scroll smooth: frame p50 / p95 / max (ms)', tri('scrollSmoothP50', 'scrollSmoothP95', 'scrollSmoothMax')],
  ['Scroll jumps: frame p50 / p95 / max (ms)', tri('scrollJumpsP50', 'scrollJumpsP95', 'scrollJumpsMax')],
  ['Long tasks, all scenarios: count / total ms', (e) => `${m(e, 'longTasks')} / ${m(e, 'longTaskMs')}`],
  ['JS heap (MB): data / after render / end', (e) => `${m(e, 'jsHeapDataMB')} / ${m(e, 'jsHeapRenderMB')} / ${m(e, 'jsHeapEndMB')}`],
  ['Wall time per run (s)', (e) => m(e, 'wallSec')],
]);

table('Run-to-run spread (min–max over runs)', [
  ['First render JS (ms)', (e) => spread(e, 'firstRenderJsMs')],
  ['Wheel zoom frame p50 (ms)', (e) => spread(e, 'wheelZoomP50')],
  ['Drag pan frame p50 (ms)', (e) => spread(e, 'dragPanP50')],
  ['Hover frame p50 (ms)', (e) => spread(e, 'hoverP50')],
  ['Select p50 (ms)', (e) => spread(e, 'selectP50')],
  ['Select 2000-event span (ms)', (e) => spread(e, 'selectHeavyMs')],
  ['Resize frame p50 (ms)', (e) => spread(e, 'resizeP50')],
  ['Collapse p50 (ms)', (e) => spread(e, 'collapseP50')],
  ['Expand p50 (ms)', (e) => spread(e, 'expandP50')],
  ['Filter clear p50 (ms)', (e) => spread(e, 'filterClearP50')],
  ['Scroll jumps p50 (ms)', (e) => spread(e, 'scrollJumpsP50')],
  ['CPU probe at start (ms, 2M-iteration loop)', (e) => spread(e, 'probeCpuStartMs', 1)],
  ['Pipeline probe p95 at start (ms)', (e) => spread(e, 'probePipelineP95Ms', 1)],
]);
