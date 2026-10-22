import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CliError, usageError } from './errors.mjs';

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

export async function scaffoldGame(slug, directory) {
  checkSlug(slug);
  const { gameFiles } = await import('../vendor/sdk/bin/templates.mjs');
  const target = resolve(directory);
  const files = { ...gameFiles(slug), '.meignore': DEFAULT_MEIGNORE };
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new CliError(`Map bestaat al: ${directory}`, { hint: 'Kies een andere slug of gebruik --dir.' });
    throw error;
  }
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(target, name)), { recursive: true });
      await writeFile(join(target, name), content, { flag: 'wx' });
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return { directory: target, files: Object.keys(files).sort() };
}
