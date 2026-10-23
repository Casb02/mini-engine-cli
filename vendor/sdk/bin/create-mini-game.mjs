#!/usr/bin/env node
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gameFiles, resolveOptions, templateList } from './templates.mjs';

const usage = `Usage: create-mini-game <slug> [options]

Creates a trusted host-runtime game for Mini Engine from a starter template.

Options:
  --template NAME     stemmen (default), quiz, buzzer, beurten or leeg
  --title TEXT        Title (default: made from the slug)
  --players MIN-MAX   Number of players, such as 2-8 (default: the template's)
  --modes LIST        playing, tv or both; the first one is the default (default: playing,tv)
  --look NAME         plain (default) or mini-engine-ui
  --theme NAME        MiniEngineUI theme: kalk, nacht, vilt or studio (default: the template's)
  --lang CODE         Language of the game: en (default) or nl
  --directory PATH    Where to create it; the last part must be the slug
  --list              List the templates
  -h, --help          Show this help`;

/** @param {string | undefined} value */
function players(value) {
  if (value === undefined) return {};
  const match = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error('--players needs MIN-MAX, such as 2-8.');
  return { minPlayers: Number(match[1]), maxPlayers: Number(match[2] ?? match[1]) };
}

try {
  const { values, positionals } = parseArgs({
    options: {
      template: { type: 'string' },
      title: { type: 'string' },
      players: { type: 'string' },
      modes: { type: 'string' },
      look: { type: 'string' },
      theme: { type: 'string' },
      lang: { type: 'string' },
      directory: { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage);
  } else if (values.list) {
    for (const template of templateList('en')) console.log(`${template.name.padEnd(8)}  ${template.summary} (${template.min_players}–${template.max_players} players)`);
  } else {
    if (positionals.length !== 1) throw new Error(usage);
    const [slug] = positionals;
    const options = resolveOptions(slug, {
      template: values.template,
      title: values.title,
      language: values.lang,
      look: values.look,
      theme: values.theme,
      hostModes: values.modes?.split(',').map(mode => mode.trim()),
      ...players(values.players),
    });
    const directory = resolve(values.directory ?? slug);
    if (basename(directory) !== slug) {
      throw new Error(`The destination directory must be named ${slug} so Mini Engine can load its manifest.`);
    }
    await mkdir(dirname(directory), { recursive: true });
    // An exclusive directory creation preserves every existing destination, even an empty one.
    await mkdir(directory);
    try {
      for (const [name, content] of Object.entries(gameFiles(slug, options))) {
        await mkdir(dirname(join(directory, name)), { recursive: true });
        await writeFile(join(directory, name), content, { flag: 'wx' });
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    console.log(`Created ${slug} (${options.template}) in ${directory}\n\nPlay it on your own computer with me dev from the Mini Engine CLI, and publish it with me game upload.\nRead ${join(directory, 'README.md')} to make it yours.`);
  }
} catch (error) {
  console.error(`create-mini-game: ${error.message}`);
  process.exitCode = 1;
}
