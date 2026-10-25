'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '');
const port = Number(process.argv[3] || 0);
if (!root || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node serve-held-canary.cjs <root> <port>');
}

http.createServer((request, response) => {
  const name = path.posix.basename(new URL(request.url, 'http://127.0.0.1').pathname);
  const target = path.join(root, name);
  if (!name || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  fs.createReadStream(target).pipe(response);
}).listen(port, '127.0.0.1');
