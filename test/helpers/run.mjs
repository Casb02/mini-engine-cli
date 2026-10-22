import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../../bin/me.mjs', import.meta.url));

export async function tempHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'me-test-')));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export function runMe(args, { home, cwd = home, env = {}, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => {
      const result = { code, stdout, stderr };
      result.json = () => JSON.parse(stdout);
      resolve(result);
    });
    child.stdin.end(input);
  });
}

export async function closedPort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
