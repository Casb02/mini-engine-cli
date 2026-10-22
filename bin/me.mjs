#!/usr/bin/env node
import { main } from '../src/cli.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`Fout: Mini Engine CLI heeft Node.js 22 of nieuwer nodig (dit is ${process.versions.node}).\n`);
  process.exitCode = 1;
} else {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
