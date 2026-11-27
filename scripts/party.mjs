// One-command watch party host: build, start server (serving the web app on the same origin) + Next.js,
// then open a Cloudflare quick tunnel if `cloudflared` is installed and print the link to share.
// Usage (repo root): pnpm party            -> build + run + tunnel
//                    pnpm party --local    -> no tunnel (http://localhost:4000 only)
//                    pnpm party --no-build -> skip `pnpm build`
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const SERVER_PORT = 4000;
const WEB_PORT = 3000;
const children = [];

const say = (msg) => console.log(`\x1b[36m[party]\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\x1b[31m[party]\x1b[0m ${msg}`);
  shutdown(1);
};

function run(name, cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, { cwd: root, ...opts });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) die(`${name} exited (code ${code}). Scroll up for its error.`);
  });
  return child;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    // Kill the whole tree on Windows (next start spawns its own worker).
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch (err) {
    return !(err instanceof Error && err.name === 'TimeoutError');
  }
}

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {
      // not up yet
    }
    await wait(500);
  }
  die(`${label} did not come up at ${url}.`);
}

for (const port of [SERVER_PORT, WEB_PORT]) {
  if (!(await portFree(port))) die(`Port ${port} is already in use. Close the other WatchParty window first.`);
}

if (!args.has('--no-build')) {
  say('Building (first run takes ~1 min, later runs are cached)…');
  // One command string: pnpm is a .cmd shim on Windows, which needs a shell.
  const b = spawnSync('pnpm build', { cwd: root, stdio: 'inherit', shell: true });
  if (b.status !== 0) die('Build failed — see the errors above.');
}

// Friends who sync Netflix/MovieBox etc. need the extension: hand them this zip (unzip → chrome://extensions → Load unpacked).
// Windows' own bsdtar writes real zips with -a; Git Bash's GNU tar would write a tar named .zip.
// Entries are named, not '.': a './' prefix makes Windows Explorer show the zip as empty.
const zip =
  process.platform === 'win32'
    ? spawnSync(
        `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe`,
        ['-a', '-c', '-f', 'watchparty-extension.zip', '-C', 'apps/extension/dist', ...readdirSync(`${root}/apps/extension/dist`)],
        { cwd: root },
      )
    : spawnSync('zip', ['-qr', '../../../watchparty-extension.zip', '.'], { cwd: `${root}/apps/extension/dist` });
say(zip.status === 0 ? 'Extension for friends: watchparty-extension.zip (in the project folder)' : 'Could not zip the extension (send them apps/extension/dist instead).');

say('Starting web app and server…');
run('web app', process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], {
  cwd: `${root}/apps/web`,
  stdio: ['ignore', 'ignore', 'inherit'],
});
run('server', 'node', ['apps/server/dist/index.js'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PORT: String(SERVER_PORT), LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn', WEB_UPSTREAM: `http://127.0.0.1:${WEB_PORT}` },
});
await waitFor(`http://127.0.0.1:${SERVER_PORT}/healthz`, 'Server');
await waitFor(`http://127.0.0.1:${SERVER_PORT}/`, 'Web app (through the server)');
say(`Running locally: http://localhost:${SERVER_PORT}`);

// winget's install dir too: terminals opened before the install (e.g. VS Code's) still have the old PATH.
const cloudflared = ['cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'].find(
  (bin) => spawnSync(bin, ['--version']).status === 0,
);

if (args.has('--local')) {
  say('Local only (--local). Press Ctrl+C to stop.');
} else if (!cloudflared) {
  say('`cloudflared` is not installed, so friends cannot reach this yet.');
  say('Install it once:  winget install --id Cloudflare.cloudflared   then open a new terminal and run  pnpm party  again.');
} else {
  say('Opening a public tunnel…');
  const tunnel = run('cloudflared', cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${SERVER_PORT}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let shown = false;
  tunnel.stderr.setEncoding('utf8').on('data', (chunk) => {
    const url = !shown && chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (!url) return;
    shown = true;
    console.log(`\n  \x1b[1m\x1b[32mShare this link with your friends:\x1b[0m  \x1b[1m${url}\x1b[0m`);
    console.log('  (It changes every time you run `pnpm party`. Keep this window open during the party.)\n');
  });
}
