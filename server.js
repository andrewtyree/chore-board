// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Estrella Tyree
//
// server.js — zero-dependency static file server + shared-state JSON API.
// Node 18+. Run: `node server.js`  (PORT and DATA_FILE configurable via env).
//
// Why a server at all: the app is a shared family board, so all devices must read and
// write the SAME state. A static-only host (or browser localStorage) would give every
// device its own private copy. This server keeps one JSON file as the source of truth.

import http from 'node:http';
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
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

const BAK_FILE = DATA_FILE + '.bak';
const TMP_FILE = DATA_FILE + '.tmp';

// Reads one candidate file. `{missing:true}` for absent/blank; throws if it exists but won't parse.
async function readOne(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { missing: true }; throw e; }
  if (!raw.trim()) return { missing: true };
  return { state: JSON.parse(raw) };
}

// -> { ok:true, state }   state === null means "no file yet", so the client should seed defaults.
// -> { ok:false }         a file exists but is unreadable. The client MUST NOT seed over it, or a
//                         truncated write would silently become a brand-new sample board.
async function readState() {
  let corrupt = false;
  for (const file of [DATA_FILE, BAK_FILE]) {
    try {
      const r = await readOne(file);
      if (r.missing) continue;
      if (file === BAK_FILE) console.error(`[state] recovered from ${BAK_FILE} — ${DATA_FILE} is missing or corrupt`);
      return { ok: true, state: r.state };
    } catch (e) {
      console.error(`[state] ${file} is unreadable: ${e.message}`);
      corrupt = true;
    }
  }
  return corrupt ? { ok: false } : { ok: true, state: null };
}

// Serialize writes: two overlapping PUTs must not interleave on the same file.
let writeQueue = Promise.resolve();
function writeState(state) {
  const next = writeQueue.then(() => writeNow(state), () => writeNow(state));
  writeQueue = next.catch(() => {}); // a failed write must not poison the chain
  return next;
}
async function writeNow(state) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(TMP_FILE, JSON.stringify(state, null, 2));
  if (existsSync(DATA_FILE)) await copyFile(DATA_FILE, BAK_FILE); // keep one generation back
  await rename(TMP_FILE, DATA_FILE); // atomic within a filesystem: readers see the old or new file, never a partial one
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
        const { ok, state } = await readState();
        if (!ok) return send(res, 503, JSON.stringify({ error: 'state file unreadable', corrupt: true }));
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
