#!/usr/bin/env node
// Usage: node scripts/sync-vendor.mjs [--sdk ../mini-engine-sdk] | --check
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const record = join(vendor, 'VENDOR.json');

// The templates read ../types/ and ../skills/ (the MiniEngineUI kit), so vendor/sdk/ keeps the SDK's layout.
const COPIES = [
  ['bin', 'sdk/bin'],
  ['types/mini-engine.d.ts', 'sdk/types/mini-engine.d.ts'],
  ['dist/mini-engine.js', 'sdk/dist/mini-engine.js'],
  ['skills', 'sdk/skills'],
];

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, base)));
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'));
  }
  return out.sort();
}

async function hashes() {
  const files = {};
  for (const path of await walk(vendor)) {
    if (path === 'VENDOR.json') continue;
    files[path] = createHash('sha256').update(await readFile(join(vendor, path))).digest('hex');
  }
  return files;
}

const { values } = parseArgs({ options: { sdk: { type: 'string' }, check: { type: 'boolean' } } });

if (values.check) {
  const recorded = JSON.parse(await readFile(record, 'utf8'));
  const actual = await hashes();
  const problems = [];
  for (const [path, hash] of Object.entries(recorded.files)) {
    if (!(path in actual)) problems.push(`ontbreekt: ${path}`);
    else if (actual[path] !== hash) problems.push(`gewijzigd: ${path}`);
  }
  for (const path of Object.keys(actual)) if (!(path in recorded.files)) problems.push(`onbekend: ${path}`);
  if (problems.length) {
    console.error(`vendor/ wijkt af van VENDOR.json:\n  ${problems.join('\n  ')}\nDraai: npm run sync-vendor`);
    process.exit(1);
  }
  console.log(`vendor/ klopt met VENDOR.json (${Object.keys(actual).length} bestanden, SDK ${recorded.sdk.version}).`);
} else {
  const sdk = resolve(values.sdk ?? process.env.MINI_ENGINE_SDK ?? join(root, '..', 'mini-engine-sdk'));
  const pkg = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
  if (pkg.name !== '@casb02/mini-engine-sdk') throw new Error(`${sdk} is geen Mini Engine SDK-checkout.`);
  try {
    await access(join(sdk, 'dist', 'mini-engine.js'));
  } catch {
    console.error(`${sdk}/dist/mini-engine.js ontbreekt. Draai eerst npm run build in de SDK.`);
    process.exit(1);
  }
  let commit = null;
  let dirty = false;
  try {
    commit = execFileSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['-C', sdk, 'status', '--porcelain', '--', 'bin', 'types', 'skills', 'src'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    commit = null;
  }
  await rm(vendor, { recursive: true, force: true });
  for (const [from, to] of COPIES) {
    await mkdir(dirname(join(vendor, to)), { recursive: true });
    await cp(join(sdk, from), join(vendor, to), { recursive: true });
  }
  const files = await hashes();
  const data = { sdk: { name: pkg.name, version: pkg.version, commit, dirty }, files };
  await writeFile(record, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`vendor/ bijgewerkt uit ${sdk} (SDK ${pkg.version}${commit ? `, ${commit.slice(0, 7)}` : ''}${dirty ? ', met lokale wijzigingen' : ''}): ${Object.keys(files).length} bestanden.`);
}
