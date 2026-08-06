// test/server.test.js — runs the real server against a temp data file. No dependencies.
// Covers the store's data-safety behavior: atomic writes, the .bak fallback, refusing to
// serve a corrupt file as "empty", and the static path-traversal guard.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error('  FAIL', m, '=>', A, '!==', B); fails++; }
  else console.log('  ok  ', m);
};

let proc, dir, dataFile, base;

// Boots the server on its own port + temp DATA_FILE. `seed` writes state.json / state.json.bak first.
async function start({ state, bak } = {}) {
  dir = await mkdtemp(path.join(tmpdir(), 'choreboard-test-'));
  dataFile = path.join(dir, 'state.json');
  if (state !== undefined) await writeFile(dataFile, state);
  if (bak !== undefined) await writeFile(dataFile + '.bak', bak);
  const port = 41000 + Math.floor(Math.random() * 4000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile },
    stdio: ['ignore', 'ignore', 'ignore'], // the corrupt-file cases log to stderr on purpose
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server did not start');
}
async function stop() {
  proc.kill();
  await new Promise(r => proc.on('exit', r));
  await rm(dir, { recursive: true, force: true });
}
const put = body => fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

console.log('fresh install');
await start();
{
  const r = await fetch(base + '/api/state');
  eq(r.status, 200, 'GET with no state file is 200');
  eq(await r.json(), {}, 'and returns {} so the client seeds defaults');
}
console.log('round-trip + atomic write');
{
  const board = { rev: 1, people: [{ id: 'me' }], chores: [] };
  eq((await put(board)).status, 200, 'PUT returns 200');
  eq(await (await fetch(base + '/api/state')).json(), board, 'GET returns what was PUT');
  eq(existsSync(dataFile + '.tmp'), false, 'no .tmp file left behind');
  eq(existsSync(dataFile + '.bak'), false, 'no .bak yet after the first write');

  await put({ rev: 2, people: [{ id: 'me' }], chores: [] });
  eq(existsSync(dataFile + '.bak'), true, 'second write keeps a .bak');
  eq(JSON.parse(await readFile(dataFile + '.bak', 'utf8')).rev, 1, '.bak holds the previous revision');
  eq(JSON.parse(await readFile(dataFile, 'utf8')).rev, 2, 'primary holds the current revision');
}
console.log('concurrent PUTs do not interleave');
{
  await Promise.all([3, 4, 5, 6].map(rev => put({ rev, chores: [] })));
  const onDisk = await readFile(dataFile, 'utf8');
  eq(typeof JSON.parse(onDisk).rev, 'number', 'state.json is still valid JSON after 4 overlapping writes');
}
console.log('static files');
{
  eq((await fetch(base + '/')).status, 200, 'GET / serves the app');
  eq((await fetch(base + '/nope.js')).status, 404, 'missing file is 404');
  // The URL parser resolves dot segments before the handler runs, so these never reach the
  // startsWith(PUBLIC_DIR) guard — it's defense in depth. Assert the property, not the status:
  // nothing outside public/ is ever served.
  for (const attack of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%252e%252e/server.js']) {
    const r = await fetch(base + attack);
    const leaked = r.ok && (await r.text()).includes('DATA_FILE');
    eq(leaked, false, `does not serve source for ${attack}`);
  }
}
await stop();

console.log('corrupt state file, no backup');
await start({ state: '{"rev":1,"chores":' }); // truncated mid-write
{
  const r = await fetch(base + '/api/state');
  eq(r.status, 503, 'GET is 503, not an empty board');
  eq((await r.json()).corrupt, true, 'response flags corruption so the client refuses to seed over it');
}
await stop();

console.log('corrupt state file with a good backup');
await start({ state: '{"rev":9,"chores":', bak: '{"rev":8,"chores":[],"people":[]}' });
{
  const r = await fetch(base + '/api/state');
  eq(r.status, 200, 'GET falls back to the backup');
  eq((await r.json()).rev, 8, 'serves the last good revision');
}
await stop();

console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
