import { basename, relative, resolve } from 'node:path';
import { homeDir } from '../config.mjs';
import { CliError, usageError } from '../errors.mjs';
import { tildePath } from '../format.mjs';
import { THEMES, checkTitle, gameOptionFlags, gameOptionsFromFlags, parsePlayers, templates } from '../options.mjs';
import { blockers, checkSlug, scaffoldGame, slugify } from '../scaffold.mjs';
import { installSkills, skillStatus } from '../skills.mjs';
import { parseNumber, runDev } from './dev.mjs';
import { skillTarget } from './skill.mjs';

const MODE_CHOICES = [
  { value: ['playing', 'tv'], label: 'Allebei, standaard Iedereen doet mee' },
  { value: ['playing'], label: 'Alleen Iedereen doet mee: de maker speelt zelf mee' },
  { value: ['tv'], label: 'Alleen TV: het scherm dat de kamer maakt, toont het spel' },
  { value: ['tv', 'playing'], label: 'Allebei, standaard TV' },
];
const LOOK_CHOICES = [
  { value: 'mini-engine-ui', label: 'MiniEngineUI: rustig en kant-en-klaar, met een thema' },
  { value: 'plain', label: 'Eenvoudig: een kaal stijlblad om zelf op te bouwen' },
];
const THEME_LABELS = { kalk: 'licht en rustig', nacht: 'donker, voor op een tv', vilt: 'groen vilt, voor tafelspellen', studio: 'blauw met goud, voor quizzen' };
const LANGUAGE_CHOICES = [
  { value: 'nl', label: 'Nederlands' },
  { value: 'en', label: 'English' },
];
const MODE_NAMES = { playing: 'Iedereen doet mee', tv: 'TV' };

const shownPath = (cwd, target) => {
  const rel = relative(cwd, target);
  return !rel ? '.' : rel.startsWith('..') ? target : rel;
};
const placeName = (cwd, target) => (shownPath(cwd, target) === '.' ? 'deze map' : shownPath(cwd, target));

function titleFromFolder(name) {
  const words = name.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Mijn spel';
}

const describeModes = modes =>
  modes.length === 1 ? `alleen ${MODE_NAMES[modes[0]]}` : `${MODE_NAMES[modes[0]]} (standaard) of ${MODE_NAMES[modes[1]]}`;

/** Asks again after a wrong answer, three times at most. */
async function askUntil(ctx, read, check) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return check(await read());
    } catch (error) {
      if (!(error instanceof CliError) || attempt >= 3) throw error;
      ctx.stderr.write(`    ${error.message}\n`);
    }
  }
}

async function choose(ctx, question, options, current) {
  const key = value => (Array.isArray(value) ? value.join(',') : String(value));
  const fallback = Math.max(0, options.findIndex(option => key(option.value) === key(current))) + 1;
  ctx.stderr.write(`${question}\n${options.map((option, index) => `    ${index + 1}  ${option.label}`).join('\n')}\n`);
  return askUntil(
    ctx,
    async () => (await ctx.prompter.ask('    Kies', { defaultValue: String(fallback) })).trim().toLowerCase(),
    answer => {
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : options.findIndex(option => key(option.value) === answer);
      if (!options[index]) throw usageError(`Kies een nummer van 1 tot ${options.length}.`);
      return options[index].value;
    },
  );
}

export const initCommands = [
  {
    path: ['init'],
    usage: 'init [map] [opties]',
    summary: 'Nieuw spel maken met een paar vragen, en meteen proberen',
    description: [
      'Maakt een nieuw spel in deze map, of in [map]. Elke vraag heeft een standaard; Enter kiest die.',
      'Staat er al iets in deze map, dan komt het spel in een nieuwe map met het id als naam.',
      'Aan het eind kun je het spel meteen proberen met me dev.',
      '',
      'Zonder terminal, of met --yes of --json, vraagt init niets: het gebruikt de opties en verder de standaard.',
      'Opties die je meegeeft, worden niet meer gevraagd.',
    ].join('\n'),
    options: {
      ...gameOptionFlags,
      slug: { type: 'string' },
      skills: { type: 'boolean' },
      'no-skills': { type: 'boolean' },
      dev: { type: 'boolean' },
      'no-dev': { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      interactive: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
    },
    optionHelp: [
      ['--template NAAM', 'stemmen (standaard), quiz, buzzer, beurten of leeg'],
      ['--title TITEL', 'Naam van het spel'],
      ['--slug ID', 'Id op de server (standaard gemaakt van de titel)'],
      ['--players MIN-MAX', 'Aantal spelers, bijvoorbeeld 2-8 (standaard per sjabloon)'],
      ['--modes LIJST', 'playing (Iedereen doet mee), tv of allebei; de eerste is de standaard (standaard playing,tv)'],
      ['--look NAAM', 'mini-engine-ui (standaard) of plain'],
      ['--theme NAAM', 'kalk, nacht, vilt of studio (standaard per sjabloon)'],
      ['--lang TAAL', 'Taal van het spel: nl (standaard) of en'],
      ['--skills, --no-skills', 'Ontbrekende AI-skills wel (standaard) of niet installeren in ~/.claude/skills'],
      ['--dev, --no-dev', 'Daarna wel of niet meteen me dev starten, zonder het te vragen'],
      ['--port POORT, --no-open', 'Voor die me dev: een andere poort, of geen browser openen'],
      ['--interactive', 'Ook zonder terminal vragen stellen, met de antwoorden op stdin'],
      ['-y, --yes', 'Niets vragen'],
    ],
    args: [0, 1],
    examples: [
      'me init',
      'me init kwisavond',
      'me init --yes --template quiz --title "Kwis bij Dani" --players 2-8',
      'me init feest --template buzzer --modes tv --look plain --lang en --no-dev --json',
    ],
    async run(ctx) {
      const { flags } = ctx;
      if (flags.skills && flags['no-skills']) throw usageError('Gebruik --skills of --no-skills, niet allebei.');
      if (flags.dev && flags['no-dev']) throw usageError('Gebruik --dev of --no-dev, niet allebei.');
      if (flags.dev && ctx.json) throw usageError('--dev en --json gaan niet samen.', 'Start me dev daarna apart.');
      const port = parseNumber(flags.port, '--port', 3170, 65535);
      const given = await gameOptionsFromFlags(flags);
      if (flags.slug !== undefined) checkSlug(flags.slug);
      const { templateList } = await templates();
      const list = templateList('nl');
      const ask = Boolean(flags.interactive) || (!flags.yes && !ctx.json && Boolean(ctx.stdin.isTTY));
      const say = text => ctx.stderr.write(`${text}\n`);

      const explicit = ctx.args[0] !== undefined;
      const here = resolve(ctx.cwd, ctx.args[0] ?? '.');
      const free = !(await blockers(here)).length;
      if (explicit && !free) {
        throw new CliError(`Map is niet leeg: ${shownPath(ctx.cwd, here)}`, { code: 'directory_not_empty', hint: 'Kies een nieuwe of lege map, bijvoorbeeld: me init mijn-spel' });
      }
      if (ask) say(`Een nieuw spel${free ? ` in ${placeName(ctx.cwd, here)}` : ''}. Enter kiest wat tussen [haken] staat.\n`);

      let title = given.title ?? (free ? titleFromFolder(basename(here)) : 'Mijn spel');
      if (ask && given.title === undefined) title = await askUntil(ctx, () => ctx.prompter.ask('Titel', { defaultValue: title }), checkTitle);

      let slug = flags.slug ?? slugify(title);
      if (ask && flags.slug === undefined) {
        slug = await askUntil(ctx, async () => (await ctx.prompter.ask('Id op de server', { defaultValue: slug })).trim(), value => {
          checkSlug(value);
          return value;
        });
      }
      const directory = free ? here : resolve(ctx.cwd, slug);
      if (!free && (await blockers(directory)).length) {
        throw new CliError(`Map bestaat al: ${shownPath(ctx.cwd, directory)}`, { code: 'directory_not_empty', hint: 'Kies een ander id met --slug, of een lege map: me init <map>' });
      }

      let template = given.template ?? 'stemmen';
      if (ask && given.template === undefined) {
        const width = Math.max(...list.map(item => item.name.length));
        template = await choose(ctx, 'Startsjabloon', list.map(item => ({ value: item.name, label: `${item.name.padEnd(width)}  ${item.summary}` })), template);
      }
      const chosen = list.find(item => item.name === template);

      let players = { minPlayers: given.minPlayers ?? chosen.min_players, maxPlayers: given.maxPlayers ?? chosen.max_players };
      if (ask && given.minPlayers === undefined) {
        players = await askUntil(ctx, () => ctx.prompter.ask('Spelers (min-max)', { defaultValue: `${players.minPlayers}-${players.maxPlayers}` }), parsePlayers);
      }

      let hostModes = given.hostModes ?? ['playing', 'tv'];
      if (ask && given.hostModes === undefined) hostModes = await choose(ctx, 'Wie maakt de kamer?', MODE_CHOICES, hostModes);

      let look = given.look ?? 'mini-engine-ui';
      if (ask && given.look === undefined) look = await choose(ctx, 'Uiterlijk', LOOK_CHOICES, look);
      let theme = given.theme ?? chosen.theme;
      if (ask && look === 'mini-engine-ui' && given.theme === undefined) {
        theme = await choose(ctx, 'Thema', THEMES.map(name => ({ value: name, label: `${name.padEnd(6)}  ${THEME_LABELS[name]}` })), theme);
      }

      let language = given.language ?? 'nl';
      if (ask && given.language === undefined) language = await choose(ctx, 'Taal van het spel', LANGUAGE_CHOICES, language);

      const target = skillTarget(ctx, {});
      const missing = (await skillStatus(target)).filter(skill => skill.status === 'missing').map(skill => skill.name);
      let installNow = flags.skills ? true : flags['no-skills'] ? false : missing.length > 0;
      if (ask && missing.length && flags.skills === undefined && flags['no-skills'] === undefined) {
        installNow = await ctx.prompter.confirm(`AI-skills voor Claude Code installeren in ${tildePath(target, homeDir(ctx.env))}?`, true);
      }

      const created = await scaffoldGame(slug, directory, { template, title, ...players, hostModes, look, theme, language }, { intoEmpty: true });
      let skills = null;
      if (installNow && missing.length) {
        try {
          const plan = await installSkills(target, missing);
          skills = { target, installed: plan.map(item => item.name) };
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          skills = { target, installed: [], error: error.message };
        }
      }

      const shown = shownPath(ctx.cwd, created.directory);
      const { token } = await ctx.settings().catch(() => ({ token: undefined }));
      const next = [...(shown === '.' ? [] : [`cd ${shown}`]), 'me dev', ...(token ? [] : ['me auth']), 'me game upload'];
      const data = {
        id: slug,
        title,
        directory: created.directory,
        template,
        min_players: players.minPlayers,
        max_players: players.maxPlayers,
        host_modes: hostModes,
        default_host_mode: hostModes[0],
        look,
        theme: look === 'mini-engine-ui' ? theme : null,
        language,
        files: created.files,
        skills,
        next,
      };
      if (ctx.json) return { data };

      const home = homeDir(ctx.env);
      ctx.info(
        [
          ...(ask ? [''] : []),
          `${title} staat klaar in ${placeName(ctx.cwd, created.directory)}.`,
          `  Sjabloon   ${template}`,
          `  Id         ${slug}`,
          `  Spelers    ${players.minPlayers === players.maxPlayers ? players.minPlayers : `${players.minPlayers} tot ${players.maxPlayers}`}`,
          `  Kamer      ${describeModes(hostModes)}`,
          `  Uiterlijk  ${look === 'mini-engine-ui' ? `MiniEngineUI, thema ${theme}` : 'eenvoudig'}`,
          `  Taal       ${LANGUAGE_CHOICES.find(choice => choice.value === language).label}`,
          ...(skills?.error ? [`  AI-skills  ${skills.error}`] : skills ? [`  AI-skills  geïnstalleerd in ${tildePath(target, home)}`] : missing.length ? ['  AI-skills  niet geïnstalleerd; later: me skill install'] : []),
        ].join('\n'),
      );

      const tryNow = flags.dev ? true : flags['no-dev'] || !ask ? false : await ctx.prompter.confirm('\nNu proberen met me dev?', true);
      if (tryNow) {
        ctx.closePrompter();
        ctx.info('');
        return runDev(ctx, created.directory, { port, open: !flags['no-open'] });
      }
      return { data, text: ['', 'Volgende stappen:', ...next.map(line => `  ${line}`)].join('\n') };
    },
  },
];
