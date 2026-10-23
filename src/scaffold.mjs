import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CliError, usageError } from './errors.mjs';
import { templates } from './options.mjs';

export const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const DEFAULT_MEIGNORE = `# Bestanden die me game upload overslaat (naast dotfiles, node_modules en tests/).
# Alleen voor je editor nodig:
jsconfig.json
types/
`;

export function checkSlug(slug) {
  if (!slug || slug.length > 48 || !SLUG_PATTERN.test(slug)) {
    throw usageError('Slug moet 1 tot 48 kleine letters, cijfers en losse streepjes bevatten en met een letter beginnen.', 'Bijvoorbeeld: me game new ja-of-nee');
  }
}

/** "Quiz-avond bij Dani!" becomes "quiz-avond-bij-dani". */
export function slugify(text) {
  let slug = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return 'mijn-spel';
  if (!/^[a-z]/.test(slug)) slug = `spel-${slug}`;
  return slug.slice(0, 48).replace(/-+$/, '');
}

/** What is in the way in a folder: everything except hidden files such as .git. */
export async function blockers(directory) {
  let entries;
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory()) return [directory];
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(name => !name.startsWith('.') || name === '.meignore');
}

export async function scaffoldGame(slug, directory, options = {}, { intoEmpty = false } = {}) {
  checkSlug(slug);
  const { gameFiles } = await templates();
  let files;
  try {
    files = gameFiles(slug, options);
  } catch (error) {
    throw usageError(error.message);
  }
  files['.meignore'] ??= DEFAULT_MEIGNORE;
  const target = resolve(directory);
  await mkdir(dirname(target), { recursive: true });
  let created = true;
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!intoEmpty || (await blockers(target)).length) {
      throw new CliError(`Map bestaat al: ${directory}`, { hint: intoEmpty ? 'Kies een lege of nieuwe map.' : 'Kies een andere slug of gebruik --dir.' });
    }
    created = false;
  }
  const tops = [...new Set(Object.keys(files).map(name => name.split('/')[0]))];
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(target, name)), { recursive: true });
      await writeFile(join(target, name), content, { flag: 'wx' });
    }
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    else for (const name of tops) await rm(join(target, name), { recursive: true, force: true });
    throw error;
  }
  return { directory: target, files: Object.keys(files).sort() };
}
