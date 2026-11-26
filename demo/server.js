// Local HTTP server for the interactive guide and API documentation
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = 3000;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const distPath = path.join(ROOT_DIR, 'dist', 'log2trace.js');

function resolveBuildDate() {
  try {
    const mtime = fs.statSync(distPath).mtime;
    return mtime.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return 'dev';
  }
}

function resolveRequestPath(rawPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  if (pathname === '/' || pathname === '' || pathname === '/guide.html') {
    return path.join(__dirname, 'index.html');
  }

  if (pathname === '/api/') {
    return path.join(ROOT_DIR, 'docs', 'index.html');
  }

  if (pathname.startsWith('/api/')) {
    const target = path.resolve(ROOT_DIR, 'docs', pathname.slice('/api/'.length));
    return target.startsWith(path.join(ROOT_DIR, 'docs') + path.sep) ? target : null;
  }

  if (pathname === '/docs/') {
    return path.join(ROOT_DIR, 'docs', 'index.html');
  }

  if (pathname.startsWith('/dist/') || pathname.startsWith('/docs/')) {
    const target = path.resolve(ROOT_DIR, pathname.slice(1));
    return target.startsWith(ROOT_DIR + path.sep) ? target : null;
  }

  const target = path.resolve(__dirname, pathname.slice(1));
  return target === __dirname || target.startsWith(__dirname + path.sep) ? target : null;
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '/';
  const sepIdx = rawUrl.search(/[?#]/);
  const pathname = sepIdx === -1 ? rawUrl : rawUrl.slice(0, sepIdx);
  const suffix = sepIdx === -1 ? '' : rawUrl.slice(sepIdx);

  if (pathname === '/api' || pathname === '/docs') {
    res.writeHead(301, { Location: `${pathname}/${suffix}` });
    res.end();
    return;
  }

  let actualPath = resolveRequestPath(pathname);

  if (!actualPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 - Forbidden');
    return;
  }

  try {
    if (fs.existsSync(actualPath) && fs.statSync(actualPath).isDirectory()) {
      actualPath = path.join(actualPath, 'index.html');
    }
  } catch {}

  const extname = path.extname(actualPath);
  const contentType = contentTypes[extname] || 'text/plain; charset=utf-8';

  fs.readFile(actualPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 - File not found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 - Internal server error');
      }
      return;
    }

    let body = content;
    if (extname === '.html') {
      body = content.toString().replace(/__BUILD_DATE__/g, resolveBuildDate());
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Guide server running at http://localhost:${PORT}`);
  console.log(`📖 Open your browser to explore the interactive guide & playground`);
});
