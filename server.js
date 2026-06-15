// server.js — zero-dependency static file server + shared-state JSON API.
// Node 18+. Run: `node server.js`  (PORT and DATA_FILE configurable via env).
//
// Why a server at all: the app is a shared family board, so all devices must read and
// write the SAME state. A static-only host (or browser localStorage) would give every
// device its own private copy. This server keeps one JSON file as the source of truth.

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function readState() {
  try { return JSON.parse(await readFile(DATA_FILE, 'utf8')); }
  catch { return null; } // missing/empty -> client seeds defaults and PUTs them back
}
async function writeState(state) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2));
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain'); // path traversal guard
  if (!existsSync(filePath)) return send(res, 404, 'Not found', 'text/plain');
  try {
    const buf = await readFile(filePath);
    send(res, 200, buf, MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch { send(res, 500, 'Server error', 'text/plain'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/state') {
      if (req.method === 'GET') {
        const state = await readState();
        return send(res, 200, JSON.stringify(state ?? {}));
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body); } catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }
        await writeState(parsed);
        return send(res, 200, JSON.stringify({ ok: true, rev: parsed.rev ?? null }));
      }
      return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    }
    if (pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true }));
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res);
  } catch (err) {
    send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`ChoreBoard running at http://0.0.0.0:${PORT}  (data: ${DATA_FILE})`);
});
