import { cp, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.mjs';
import { SKILLS_DIR } from './vendor.mjs';

const source = fileURLToPath(SKILLS_DIR);

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  for (const line of match?.[1].split(/\r?\n/) ?? []) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].trim();
  }
  return fields;
}

export async function listSkills() {
  const skills = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = frontmatter(await readFile(join(source, entry.name, 'SKILL.md'), 'utf8'));
    skills.push({ name: entry.name, description: meta.description ?? '' });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function snapshot(dir, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [key, value] of await snapshot(path, `${prefix}${entry.name}/`)) files.set(key, value);
    else files.set(`${prefix}${entry.name}`, entry.isFile() ? await readFile(path) : null);
  }
  return files;
}

async function sameTree(a, b) {
  const [left, right] = await Promise.all([snapshot(a), snapshot(b)]);
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) {
    const other = right.get(path);
    if (!bytes || !other || !bytes.equals(other)) return false;
  }
  return true;
}

export async function installSkills(target, names, { force = false } = {}) {
  const available = await listSkills();
  const wanted = names.length ? names : available.map(skill => skill.name);
  const unknown = wanted.filter(name => !available.some(skill => skill.name === name));
  if (unknown.length) throw new CliError(`Onbekende skill: ${unknown.join(', ')}`, { hint: 'Zie: me skill list' });
  const plan = [];
  for (const name of wanted) {
    const destination = join(target, name);
    let exists = false;
    try {
      const stats = await lstat(destination);
      exists = true;
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        plan.push({ name, destination, status: force ? 'overschreven' : 'conflict' });
        continue;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!exists) plan.push({ name, destination, status: 'geïnstalleerd' });
    else if (await sameTree(join(source, name), destination)) plan.push({ name, destination, status: 'al actueel' });
    else plan.push({ name, destination, status: force ? 'overschreven' : 'conflict' });
  }
  const conflicts = plan.filter(item => item.status === 'conflict');
  if (conflicts.length) {
    throw new CliError(`Er staat al een andere versie van ${conflicts.map(item => item.name).join(', ')} in ${target}.`, {
      code: 'skill_exists',
      hint: 'Gebruik --force om te overschrijven.',
    });
  }
  await mkdir(target, { recursive: true });
  for (const item of plan) {
    if (item.status === 'al actueel') continue;
    await rm(item.destination, { recursive: true, force: true });
    await cp(join(source, item.name), item.destination, { recursive: true });
  }
  return plan;
}
