import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, usageError } from './errors.mjs';

export const DEFAULT_SERVER = 'https://miniengine.nl';
const KEYS = ['server', 'token', 'admin_token'];

export function homeDir(env) {
  return env.HOME || homedir();
}

export function configPath(env) {
  const base = env.XDG_CONFIG_HOME || join(homeDir(env), '.config');
  return join(base, 'miniengine', 'config.json');
}

export async function loadConfig(env) {
  const path = configPath(env);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new CliError(`Kan ${path} niet lezen: ${error.message}`);
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('geen object');
    return Object.fromEntries(KEYS.filter(key => typeof data[key] === 'string' && data[key]).map(key => [key, data[key]]));
  } catch (error) {
    throw new CliError(`${path} is geen geldige configuratie (${error.message}). Verwijder het bestand en log opnieuw in.`);
  }
}

export async function saveConfig(env, config) {
  const path = configPath(env);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const data = Object.fromEntries(KEYS.filter(key => config[key]).map(key => [key, config[key]]));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return path;
}

export async function updateConfig(env, changes) {
  const config = { ...(await loadConfig(env)), ...changes };
  for (const key of KEYS) if (config[key] === null) delete config[key];
  const path = await saveConfig(env, config);
  return { path, config };
}

export function normalizeServer(value) {
  const text = String(value).trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw usageError(`Ongeldige server-URL: ${text}`, 'Gebruik bijvoorbeeld https://miniengine.nl of http://localhost:3000');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw usageError(`Server-URL moet met http:// of https:// beginnen: ${text}`);
  if (url.search || url.hash) throw usageError(`Server-URL mag geen ? of # bevatten: ${text}`);
  return url.href.replace(/\/+$/, '');
}

export async function resolveSettings(env, flags = {}) {
  const config = await loadConfig(env);
  const pick = (flag, envName, key) => {
    if (flag) return { value: flag, source: 'optie' };
    if (env[envName]) return { value: env[envName], source: envName };
    if (config[key]) return { value: config[key], source: 'config' };
    return { value: undefined, source: null };
  };
  const server = pick(flags.server, 'MINIENGINE_SERVER', 'server');
  const token = pick(undefined, 'MINIENGINE_TOKEN', 'token');
  const adminToken = pick(undefined, 'MINIENGINE_ADMIN_TOKEN', 'admin_token');
  return {
    config,
    path: configPath(env),
    server: server.value ? normalizeServer(server.value) : DEFAULT_SERVER,
    serverSource: server.source ?? 'standaard',
    token: token.value?.trim(),
    tokenSource: token.source,
    adminToken: adminToken.value?.trim(),
    adminTokenSource: adminToken.source,
  };
}
