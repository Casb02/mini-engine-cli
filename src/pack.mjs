import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError } from './errors.mjs';
import { formatBytes } from './format.mjs';

const MiB = 1024 * 1024;
export const LIMITS = { files: 4096, fileBytes: 2 * MiB, totalBytes: 10 * MiB, pathBytes: 255, depth: 32, bodyBytes: 16 * MiB };
export const ID_PATTERN = /^[a-z0-9-]{1,48}$/;
export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const MAX_ACHIEVEMENTS = 50;
export const MAX_SET_KINDS = 4;
export const HOST_MODES = ['moderator', 'playing'];
export const ICON_BYTES = 64 * 1024;

export function compileIgnore(line) {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  if (pattern.startsWith('!')) throw new CliError(`.meignore: uitzonderingen met ! worden niet ondersteund (${pattern}).`);
  const dirOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { pattern: line.trim(), dirOnly, regex: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`) };
}

export function parseIgnore(text) {
  return text.split(/\r?\n/).map(compileIgnore).filter(Boolean);
}

export function isIgnored(rules, path, isDir) {
  return rules.some(rule => (!rule.dirOnly || isDir) && rule.regex.test(path));
}

function builtinSkip(name, path, isDir) {
  if (name.startsWith('.')) return true;
  if (name === 'node_modules') return true;
  return isDir && path === 'tests';
}

export async function collectFiles(dir) {
  const root = resolve(dir);
  let rules = [];
  try {
    rules = parseIgnore(await readFile(join(root, '.meignore'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error instanceof CliError ? error : new CliError(`Kan .meignore niet lezen: ${error.message}`);
  }
  const files = [];
  const walk = async (absolute, prefix) => {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = prefix + entry.name;
      const full = join(absolute, entry.name);
      const stats = await lstat(full);
      const isDir = stats.isDirectory();
      if (builtinSkip(entry.name, path, isDir) || isIgnored(rules, path, isDir)) continue;
      if (stats.isSymbolicLink()) {
        throw new CliError(`Symlinks worden niet geüpload: ${path}`, { hint: 'Vervang de link door een gewoon bestand of zet hem in .meignore.' });
      }
      if (entry.name.includes('\\')) throw new CliError(`Bestandsnamen mogen geen backslash bevatten: ${path}`);
      if (isDir) await walk(full, `${path}/`);
      else if (stats.isFile()) files.push({ path, size: stats.size, absolute: full });
      else throw new CliError(`Alleen gewone bestanden en mappen kunnen worden geüpload: ${path}`);
    }
  };
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory()) throw new CliError(`${dir} is geen map.`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new CliError(`Map niet gevonden: ${dir}`);
    throw error;
  }
  await walk(root, '');
  return files;
}

export function checkLimits(files) {
  const problems = [];
  for (const file of files) {
    if (Buffer.byteLength(file.path) > LIMITS.pathBytes) problems.push(`Pad langer dan ${LIMITS.pathBytes} bytes: ${file.path}`);
    if (file.path.split('/').length > LIMITS.depth) problems.push(`Pad dieper dan ${LIMITS.depth} niveaus: ${file.path}`);
    if (file.size > LIMITS.fileBytes) problems.push(`Bestand groter dan ${formatBytes(LIMITS.fileBytes)}: ${file.path} (${formatBytes(file.size)})`);
  }
  if (files.length > LIMITS.files) problems.push(`Te veel bestanden: ${files.length} (maximaal ${LIMITS.files}).`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > LIMITS.totalBytes) problems.push(`Game is te groot: ${formatBytes(total)} (maximaal ${formatBytes(LIMITS.totalBytes)}).`);
  if (problems.length) {
    const shown = problems.slice(0, 8);
    if (problems.length > shown.length) shown.push(`… en nog ${problems.length - shown.length}`);
    throw new CliError(`De game past niet binnen de uploadlimieten:\n  ${shown.join('\n  ')}`, {
      code: 'limits',
      hint: 'Zet bestanden die niet nodig zijn in .meignore.',
    });
  }
  return total;
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const manifestText = (value, max) => value.trim() !== '' && [...value].length <= max && !/\p{Cc}/u.test(value);

function checkEntries(manifest, field, { max, tooMany, shape, label, extra }) {
  const entries = manifest[field];
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw new CliError(`manifest.json: ${field} moet een lijst zijn.`);
  if (entries.length > max) throw new CliError(`manifest.json: ${tooMany} (nu ${entries.length}).`);
  const seen = new Set();
  entries.forEach((entry, index) => {
    const at = `${field}[${index}]`;
    if (!isObject(entry) || !['id', 'title', 'description'].every(name => typeof entry[name] === 'string')) {
      throw new CliError(`manifest.json: ${at} moet een object zijn met ${shape}.`);
    }
    if (!ENTRY_ID_PATTERN.test(entry.id)) {
      throw new CliError(`manifest.json: ${at}.id moet 1 tot 48 kleine letters, cijfers, _ of - zijn en met een letter of cijfer beginnen.`);
    }
    if (seen.has(entry.id)) throw new CliError(`manifest.json: het id ${entry.id} komt twee keer voor in ${field}.`);
    seen.add(entry.id);
    if (!manifestText(entry.title, 60) || !manifestText(entry.description, 160)) {
      throw new CliError(`manifest.json: ${label} ${entry.id}: gebruik een titel van 1 tot 60 tekens en een beschrijving van 1 tot 160 tekens, zonder regeleinden.`);
    }
    extra?.(entry);
  });
}

function checkDeclarations(manifest) {
  checkEntries(manifest, 'achievements', {
    max: MAX_ACHIEVEMENTS,
    tooMany: `een game declareert maximaal ${MAX_ACHIEVEMENTS} achievements`,
    shape: 'id, title en description (tekst)',
    label: 'achievement',
  });
  checkEntries(manifest, 'set_kinds', {
    max: MAX_SET_KINDS,
    tooMany: `een game declareert maximaal ${MAX_SET_KINDS} soorten sets`,
    shape: 'id, title, description (tekst) en schema',
    label: 'set-soort',
    extra(kind) {
      if (!isObject(kind.schema)) throw new CliError(`manifest.json: set-soort ${kind.id}: schema moet een object zijn.`);
    },
  });
}

function checkHostModes(manifest) {
  const modes = manifest.host_modes;
  if (!Array.isArray(modes) || !modes.length || !modes.every(mode => HOST_MODES.includes(mode))) {
    throw new CliError('manifest.json: host_modes moet een lijst zijn met "moderator", "playing" of allebei. "hostless" is alleen voor ingebouwde games.');
  }
  const fallback = manifest.default_host_mode ?? 'moderator';
  if (!modes.includes(fallback)) {
    throw new CliError(`manifest.json: default_host_mode moet een van de host_modes zijn (${modes.map(mode => `"${mode}"`).join(', ')}).`);
  }
}

const ICON_FORBIDDEN = [
  [/<script/i, '<script'],
  [/<foreignobject/i, '<foreignObject'],
  [/javascript:/i, 'javascript:'],
  [/[ \t\n\r/"']on[a-z]+[ \t\n\r\f]*=/i, 'een on…=-attribuut'],
];

function checkIcon(manifest, paths, contentOf) {
  const icon = manifest.icon;
  if (icon === undefined || icon === null) return;
  if (typeof icon !== 'string' || !icon.startsWith('assets/') || !icon.endsWith('.svg')) {
    throw new CliError('manifest.json: icon moet een SVG in assets/ zijn, bijvoorbeeld "assets/icoon.svg".');
  }
  const bytes = paths.includes(icon) ? contentOf(icon) : undefined;
  if (!bytes) throw new CliError(`manifest.json: icon ${icon} staat niet in de game.`, { hint: 'Controleer het pad en of .meignore het bestand overslaat.' });
  if (bytes.length > ICON_BYTES) throw new CliError(`manifest.json: icon ${icon} is ${bytes.length} bytes; een icoon mag maximaal ${ICON_BYTES} bytes (64 KiB) zijn.`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError(`manifest.json: icon ${icon} is geen geldige UTF-8.`);
  }
  if (!/<svg/i.test(text)) throw new CliError(`manifest.json: icon ${icon} is geen SVG: er staat geen <svg in.`);
  const found = ICON_FORBIDDEN.find(([pattern]) => pattern.test(text));
  if (found) throw new CliError(`manifest.json: icon ${icon} bevat ${found[1]}. Een icoon mag geen scripts bevatten.`);
}

export function declared(manifest) {
  const pick = entries => (Array.isArray(entries) ? entries.map(({ id, title, description }) => ({ id, title, description })) : []);
  return { achievements: pick(manifest.achievements), set_kinds: pick(manifest.set_kinds) };
}

export function checkManifest(text, paths, contentOf = () => undefined) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new CliError(`manifest.json is geen geldige JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new CliError('manifest.json moet een object zijn.');
  const { id, version } = manifest;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CliError('manifest.json: id moet 1 tot 48 kleine letters, cijfers of streepjes zijn.');
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new CliError('manifest.json: version moet met een letter of cijfer beginnen en mag daarna letters, cijfers en . + _ - bevatten (maximaal 64 tekens).');
  }
  if (manifest.runtime !== 'host') throw new CliError('manifest.json: alleen games met runtime "host" kunnen worden geüpload.');
  checkHostModes(manifest);
  checkDeclarations(manifest);
  const required = ['host.html', 'player.html', ...(manifest.has_display ? ['display.html'] : [])];
  const missing = required.filter(name => !paths.includes(name));
  if (missing.length) throw new CliError(`Ontbrekende bestanden: ${missing.join(', ')}`);
  checkIcon(manifest, paths, contentOf);
  return manifest;
}

export async function packGame(dir) {
  const files = await collectFiles(dir);
  const paths = files.map(file => file.path);
  if (!paths.includes('manifest.json')) {
    throw new CliError(`Geen manifest.json gevonden in ${dir}.`, { hint: 'Maak een game met: me game new <slug>' });
  }
  const totalBytes = checkLimits(files);
  const encoded = {};
  const contents = new Map();
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    if (bytes.length !== file.size) throw new CliError(`Bestand veranderde tijdens het inpakken: ${file.path}`);
    contents.set(file.path, bytes);
    encoded[file.path] = bytes.toString('base64');
  }
  const manifest = checkManifest(contents.get('manifest.json').toString('utf8'), paths, path => contents.get(path));
  const bodyBytes = Buffer.byteLength(JSON.stringify({ files: encoded, activate: true }));
  if (bodyBytes > LIMITS.bodyBytes) {
    throw new CliError(`Upload wordt ${formatBytes(bodyBytes)} en de server accepteert maximaal ${formatBytes(LIMITS.bodyBytes)}.`, { code: 'limits' });
  }
  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    files: files.map(({ path, size }) => ({ path, size })),
    totalBytes,
    encoded,
  };
}
