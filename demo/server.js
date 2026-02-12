// Simple HTTP server for the demo
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.ts': 'text/typescript'
};

const server = http.createServer((req, res) => {
  let filePath = req.url;
  
  // Default to demo.html
  if (filePath === '/' || filePath === '') {
    filePath = '/demo.html';
  }

  // Map paths to actual file locations
  let actualPath;
  if (filePath.startsWith('/dist/')) {
    // Serve dist files from parent directory
    actualPath = path.join(__dirname, '..', filePath);
  } else {
    // Serve demo files from current directory
    actualPath = path.join(__dirname, filePath);
  }

  const extname = path.extname(actualPath);
  const contentType = contentTypes[extname] || 'text/plain';

  fs.readFile(actualPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 - File not found');
      } else {
        res.writeHead(500);
        res.end('500 - Internal server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Demo server running at http://localhost:${PORT}`);
  console.log(`📊 Open your browser to view the trace visualization`);
});
