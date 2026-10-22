import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../errors.mjs';
import { checkLimits, checkManifest, collectFiles } from '../pack.mjs';
import { isObject } from './json.mjs';
import { validateAchievements, validateSetKinds, validateSettings, validateSettingsSchema } from './schema.mjs';

const MODES = ['moderator', 'playing', 'hostless'];
const ROLES = ['host', 'player', 'display'];

const refused = message => new CliError(`De engine weigert deze game: ${message}`, { code: 'invalid_game' });

function readField(manifest, name, kind, fallback) {
  const present = Object.hasOwn(manifest, name);
  if (!present) {
    if (fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
    throw new Error(`missing field \`${name}\``);
  }
  const value = manifest[name];
  const ok =
    kind === 'string' ? typeof value === 'string'
    : kind === 'count' ? Number.isInteger(value) && value >= 0
    : kind === 'bool' ? typeof value === 'boolean'
    : kind === 'mode' ? MODES.includes(value)
    : kind === 'modes' ? Array.isArray(value) && value.every(mode => MODES.includes(mode))
    : true;
  if (!ok) throw new Error(`invalid type for \`${name}\``);
  return value;
}

function readList(manifest, name, fields) {
  const list = readField(manifest, name, 'value', () => []);
  if (!Array.isArray(list)) throw new Error(`invalid type for \`${name}\``);
  return list.map((item, index) => {
    if (!isObject(item)) throw new Error(`invalid type for \`${name}[${index}]\``);
    const out = {};
    for (const [field, kind] of Object.entries(fields)) out[field] = readField(item, field, kind);
    return out;
  });
}

export function engineMetadata(manifest) {
  let metadata;
  try {
    metadata = {
      id: readField(manifest, 'id', 'string'),
      title: readField(manifest, 'title', 'string'),
      description: readField(manifest, 'description', 'string'),
      version: readField(manifest, 'version', 'string'),
      min_players: readField(manifest, 'min_players', 'count'),
      max_players: readField(manifest, 'max_players', 'count'),
      has_display: readField(manifest, 'has_display', 'bool'),
      supports_late_join: readField(manifest, 'supports_late_join', 'bool', true),
      default_settings: readField(manifest, 'default_settings', 'value'),
      settings_schema: readField(manifest, 'settings_schema', 'value'),
      runtime: readField(manifest, 'runtime', 'string', 'host'),
      host_modes: readField(manifest, 'host_modes', 'modes', () => ['moderator']),
      default_host_mode: readField(manifest, 'default_host_mode', 'mode', 'moderator'),
      achievements: readList(manifest, 'achievements', { id: 'string', title: 'string', description: 'string' }),
      set_kinds: readList(manifest, 'set_kinds', { id: 'string', title: 'string', description: 'string', schema: 'value' }),
    };
    if (Object.hasOwn(manifest, 'icon') && manifest.icon !== null) metadata.icon = readField(manifest, 'icon', 'string');
  } catch (error) {
    throw refused(`Invalid manifest for ${manifest.id}: ${error.message}`);
  }
  const m = metadata;
  if (
    m.title.trim() === '' ||
    Buffer.byteLength(m.title) > 200 ||
    Buffer.byteLength(m.description) > 4000 ||
    m.version.trim() === '' ||
    Buffer.byteLength(m.version) > 100 ||
    m.min_players === 0 ||
    m.max_players > 100 ||
    m.min_players > m.max_players
  ) {
    throw refused('Invalid game metadata or player limits.');
  }
  try {
    validateSettingsSchema(m.settings_schema);
    validateAchievements(m.achievements);
    validateSetKinds(m.set_kinds);
    if (
      !['host', 'server'].includes(m.runtime) ||
      !m.host_modes.length ||
      !m.host_modes.includes(m.default_host_mode) ||
      (m.runtime === 'host' && m.host_modes.includes('hostless'))
    ) {
      throw new Error('Invalid runtime or unsupported host modes.');
    }
    validateSettings(m.settings_schema, m.default_settings);
  } catch (error) {
    throw refused(error.message);
  }
  return metadata;
}

export async function loadPackage(dir) {
  const files = await collectFiles(dir);
  const paths = files.map(file => file.path);
  if (!paths.includes('manifest.json')) {
    throw new CliError(`Geen manifest.json gevonden in ${dir}.`, { hint: 'Maak een game met: me game new <slug>' });
  }
  checkLimits(files);
  const contents = new Map();
  for (const file of files) contents.set(file.path, await readFile(file.absolute));
  const manifest = checkManifest(contents.get('manifest.json').toString('utf8'), paths, path => contents.get(path));
  const metadata = engineMetadata(manifest);
  const html = {};
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const role of ROLES) {
    const bytes = contents.get(`${role}.html`);
    if (bytes) {
      try {
        html[role] = decoder.decode(bytes);
      } catch {
        throw refused('Game HTML must be valid UTF-8.');
      }
    } else if (role !== 'display' || metadata.has_display) {
      throw refused('A required game role HTML file is missing.');
    }
  }
  let data = null;
  if (contents.has('data.json')) {
    try {
      data = JSON.parse(contents.get('data.json').toString('utf8'));
    } catch (error) {
      throw refused(`Invalid private game data: ${error.message}`);
    }
  }
  const assets = new Map([...contents].filter(([path]) => path.startsWith('assets/')));
  return { dir, manifest, metadata, html, data, assets, paths, manifestPath: join(dir, 'manifest.json') };
}
