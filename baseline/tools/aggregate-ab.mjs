// Turn the files of ab-run.mjs into a table of canvas against dom, with the plan's rule applied:
//   node baseline/tools/aggregate-ab.mjs <dir> [--json out.json]
// Each cell is the median of the repeats. A renderer "loses" a metric when it is more than 30 % slower than the
// other; the default is the DOM painter unless the canvas wins by more than that on a metric that matters
// (the plan's rule: within 30 % means DOM).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const jsonAt = process.argv.indexOf('--json');
const jsonOut = jsonAt > 0 ? process.argv[jsonAt + 1] : null;

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  return n === 0 ? null : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};
const pick = (get) => (result) => { try { const v = get(result); return typeof v === 'number' ? v : null; } catch { return null; } };
const scenario = (result, name) => (result.scenarios && result.scenarios[name]) || null;

// Frame intervals are lower-is-better; `budget` is the plan's p95 limit for gestures (18 ms), when it has one.
const METRICS = [
  { id: 'firstFrame', label: 'first render to frame, ms', get: pick((r) => scenario(r, 'first-render').toFirstFrameMs) },
  { id: 'zoomP95', label: 'wheel-zoom frame p95, ms', get: pick((r) => scenario(r, 'wheel-zoom').frames.p95), budget: 18 },
  { id: 'panP95', label: 'drag-pan frame p95, ms', get: pick((r) => scenario(r, 'drag-pan').frames.p95), budget: 18 },
  { id: 'scrollP95', label: 'scroll frame p95, ms', get: pick((r) => scenario(r, 'scroll').smooth.frames.p95), budget: 18 },
  { id: 'hoverP95', label: 'hover frame p95, ms', get: pick((r) => scenario(r, 'hover').frames.p95), budget: 18 },
  { id: 'selectP95', label: 'select to frame p95, ms', get: pick((r) => scenario(r, 'select').toFrame.p95), budget: 50 },
  { id: 'collapseAll', label: 'collapse all to frame, ms', get: pick((r) => scenario(r, 'collapse').collapseAll.toFrame.p50), budget: 50 },
  { id: 'longTasks', label: 'long tasks, count', get: pick((r) => Object.values(r.scenarios).reduce((sum, s) => sum + (s.longTasks ? s.longTasks.count : 0), 0)) },
  { id: 'domElements', label: 'DOM elements after first render', get: pick((r) => scenario(r, 'first-render').dom.elements) },
  { id: 'cpuProbe', label: 'CPU probe at start, ms', get: pick((r) => r.env.probe.cpu.p50Ms) },
];

// ---- read the files -------------------------------------------------------

const groups = new Map(); // "browser|config|size" -> { dom: [results], canvas: [results] }
const problems = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const match = /^(\w+)-([\w-]+?)-n(\d+)-(dom|canvas)\.run(\d+)\.json$/.exec(file);
  if (!match) continue;
  const [, browser, config, size, impl] = match;
  const result = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (result.status !== 'complete') { problems.push(`${file}: ${result.status}`); continue; }
  const key = `${browser}|${config}|${size}`;
  if (!groups.has(key)) groups.set(key, { dom: [], canvas: [] });
  groups.get(key)[impl].push(result);
}

// ---- tabulate -------------------------------------------------------------

const fmt = (v) => (v === null ? 'n/a' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const lines = [];
const summary = [];
for (const [key, { dom, canvas }] of [...groups].sort()) {
  const [browser, config, size] = key.split('|');
  lines.push(`### ${browser}, ${config}, ${Number(size).toLocaleString('en-US')} spans (repeats: dom ${dom.length}, canvas ${canvas.length})`, '', '| metric | dom | canvas | dom / canvas | verdict |', '|---|---:|---:|---:|---|');
  const row = { browser, config, size: Number(size), metrics: {} };
  for (const metric of METRICS) {
    const d = median(dom.map(metric.get));
    const c = median(canvas.map(metric.get));
    const ratio = d !== null && c !== null && c > 0 ? d / c : null;
    let verdict = '';
    if (metric.budget !== undefined) {
      const over = [];
      if (d !== null && d > metric.budget) over.push('dom over budget');
      if (c !== null && c > metric.budget) over.push('canvas over budget');
      verdict = over.join(', ');
    }
    if (ratio !== null && metric.id !== 'cpuProbe') {
      // at the 60 Hz floor both sit at 16.7 ms and a ratio says nothing; call it a tie below the budget
      const floor = metric.budget !== undefined && d !== null && c !== null && d <= metric.budget && c <= metric.budget;
      if (!floor && ratio > 1.3) verdict = `${verdict ? verdict + '; ' : ''}dom slower by ${((ratio - 1) * 100).toFixed(0)} %`;
      else if (!floor && ratio < 1 / 1.3) verdict = `${verdict ? verdict + '; ' : ''}canvas slower by ${((1 / ratio - 1) * 100).toFixed(0)} %`;
    }
    lines.push(`| ${metric.label} | ${fmt(d)} | ${fmt(c)} | ${ratio === null ? 'n/a' : ratio.toFixed(2)} | ${verdict} |`);
    row.metrics[metric.id] = { dom: d, canvas: c, ratio, verdict };
  }
  lines.push('');
  summary.push(row);
}
if (problems.length > 0) lines.push('Runs without a result:', ...problems.map((p) => `- ${p}`), '');
console.log(lines.join('\n'));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
