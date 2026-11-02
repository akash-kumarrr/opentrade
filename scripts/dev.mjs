import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webPort = Number(process.env.WEB_PORT || 5163);
const apiPort = Number(process.env.API_PORT || 3001);

async function isMarketLens(url, check) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return false;
    return check(await response.text());
  } catch { return false; }
}

const apiUrl = `http://127.0.0.1:${apiPort}/api/health`;
const webUrl = `http://127.0.0.1:${webPort}/`;
let apiReady = await isMarketLens(apiUrl, (body) => {
  try { return JSON.parse(body).provider === 'Finnhub'; } catch { return false; }
});
let webReady = await isMarketLens(webUrl, (body) => body.includes('MarketLens'));

if (apiReady && webReady) {
  console.log(`MarketLens is already running at ${webUrl} (data API on ${apiPort}).`);
  process.exit(0);
}

const children = [];
let shuttingDown = false;
function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
}
process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));

function run(name, script, args) {
  console.log(`[${name}] starting`);
  const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env: process.env });
  children.push(child);
  child.once('error', (error) => {
    console.error(`[${name}] ${error.message}`);
    stopAll();
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[${name}] exited (${signal || code}).`);
      stopAll();
      process.exitCode = code || 1;
    }
  });
}

if (!apiReady) run('data', path.join(root, 'server/index.mjs'), []);
if (!webReady) run('web', path.join(root, 'node_modules/vite/bin/vite.js'), ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort']);

if (children.length) {
  console.log(`Open ${webUrl}`);
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve))));
}
