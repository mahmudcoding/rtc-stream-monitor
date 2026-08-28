#!/usr/bin/env node
// Dev-only loopback server. Lets an https page pull the monitor source via fetch()
// without pasting the whole bundle into the page. Loopback origins are
// "potentially trustworthy", so this is not blocked as mixed content; the
// Private Network Access preflight is answered below.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8899);
const ROOT = path.resolve(__dirname, '..');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-store'
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel || 'src/rtc-stream-monitor.js');
  if (!file.startsWith(ROOT)) { res.writeHead(403, CORS); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, CORS); return res.end('not found'); }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, CORS));
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT));
