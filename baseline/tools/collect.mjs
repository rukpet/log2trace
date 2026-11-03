// Local sink for demo/perf.html results.
//   node baseline/tools/collect.mjs <output dir> [port=3918]
// then open perf.html#impl=...&n=...&auto=1&sink=http://localhost:<port>/save
// Writes <output dir>/<impl>-n<N>[-flat].json for every finished run (the latest wins; every run is also kept in
// <output dir>/history/), and appends all progress/hang beacons to events.ndjson.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const PORT = Number(process.argv[3] || 3918);
fs.mkdirSync(OUT, { recursive: true });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200, cors); return res.end('collector ok'); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const msg = JSON.parse(body);
      const line = { recv: new Date().toISOString(), kind: msg.kind, impl: msg.impl, n: msg.n };
      if (msg.kind === 'result') {
        const file = path.join(OUT, `${msg.name}.json`);
        fs.writeFileSync(file, JSON.stringify(msg.result, null, 2));
        fs.mkdirSync(path.join(OUT, 'history'), { recursive: true });
        fs.writeFileSync(path.join(OUT, 'history', msg.name + '.' + Date.now() + '.json'), JSON.stringify(msg.result, null, 2));
        line.file = file; line.status = msg.result && msg.result.status;
      } else {
        line.msg = { ...msg }; delete line.msg.kind;
      }
      fs.appendFileSync(path.join(OUT, 'events.ndjson'), JSON.stringify(line) + '\n');
      res.writeHead(200, cors); res.end('ok');
    } catch (e) {
      fs.appendFileSync(path.join(OUT, 'errors.log'), `${new Date().toISOString()} ${e}\n`);
      res.writeHead(400, cors); res.end('bad');
    }
  });
}).listen(PORT, () => console.log(`collector on ${PORT} -> ${OUT}`));
