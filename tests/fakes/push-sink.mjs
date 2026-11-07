#!/usr/bin/env node
// Fake push sink (HOK-3424).
//
// Stands in for the ntfy / webhook endpoint `observer.alerts.push.url` points
// at. Listens on an ephemeral loopback port and appends one JSON line per
// request to the capture file, so a journey can assert exactly how many pushes
// fired and what they carried. The bound port is written to the port file once
// listening; journeys read it to build the URL.
//
// Registered through fakes_spawn (tests/fakes/lib.sh) so the world teardown
// reaches it like any other long-lived child (HOK-3329).
//
// Usage: node push-sink.mjs <capture-file> <port-file>

import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const captureFile = process.argv[2];
const portFile = process.argv[3];
if (!captureFile || !portFile) {
  process.stderr.write('usage: push-sink.mjs <capture-file> <port-file>\n');
  process.exit(2);
}

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    appendFileSync(captureFile, `${JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    })}\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"fake-push","ok":true}\n');
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(portFile, String(server.address().port));
});
