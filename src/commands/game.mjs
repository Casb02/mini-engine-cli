import { relative, resolve } from 'node:path';
import { enc, request } from '../api.mjs';
import { CliError, usageError } from '../errors.mjs';
import { formatBytes, formatDate, gameState, gameStatus, privateCell, table } from '../format.mjs';
import { hasImageFields } from '../dev/schema.mjs';
import { declared, packGame } from '../pack.mjs';
import { newestFirst, selectPrune } from '../prune.mjs';
import { gameOptionFlags, gameOptionsFromFlags } from '../options.mjs';
import { scaffoldGame } from '../scaffold.mjs';

const shortHash = hash => (hash ? String(hash).replace(/^sha256:/, '').slice(0, 12) : '-');
const releaseUrl = (id, version) => `/games/${enc(id)}/versions/${enc(version)}`;

function declaredLines({ achievements, set_kinds }) {
  const lines = [];
  if (achievements.length) lines.push('', table(['ACHIEVEMENT', 'TITEL'], achievements.map(item => [item.id, item.title])));
  if (set_kinds.length) lines.push('', table(['SOORT SET', 'TITEL'], set_kinds.map(item => [item.id, item.title])));
  return lines;
}

async function serverVersion(server) {
  try {
    const health = await request(server, '/api/health', { timeoutMs: 10_000 });
    return typeof health?.version === 'string' ? health.version : null;
  } catch {
    return null;
  }
}

export function olderThan(version, major, minor) {
  const parts = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!parts) return false;
  const [have, sub] = [Number(parts[1]), Number(parts[2])];
  return have < major || (have === major && sub < minor);
}

const privateUnsupported = (server, version, after = '') =>
  new CliError(`${server} draait Mini Engine ${version}. Privégames en uitnodigingen werken vanaf Mini Engine 0.9.${after}`, { code: 'unsupported' });

// Private games and invites arrived in Mini Engine 0.9. An older server refuses these requests
// (422 or 404) and publishes nothing, but this says why before anything is sent. When the version
// is unknown the request goes ahead. Without a dev key, ctx.dev explains how to log in.
async function requirePrivateGames({ server, token }) {
  if (!token) return;
  const version = await serverVersion(server);
  if (olderThan(version, 0, 9)) throw privateUnsupported(server, version);
}

// A server of unknown version that does not know private games answers 404 not_found on the invite
// routes and 422 invalid_json on a private field.
async function privateRequest(ctx, path, options, after = '') {
  try {
    return await ctx.dev(path, options);
  } catch (error) {
    if (error.code === 'not_found' || error.code === 'invalid_json') {
      const { server } = await ctx.settings();
      error.hint ??= `Draait ${server} wel Mini Engine 0.9 of nieuwer? Privégames en uitnodigingen werken pas vanaf die versie.${after}`;
    }
    throw error;
  }
}

// As the engine reads a username (trimmed, ASCII lowercase), without the @ the CLI allows in front.
function username(value) {
  const name = value.trim().replace(/^@/, '').trim().replace(/[A-Z]/g, letter => letter.toLowerCase());
  if (!name) throw usageError('Een gebruikersnaam is leeg.', 'Geef een gebruikersnaam, met of zonder @: dani of @dani.');
  return name;
}

const atList = names => new Intl.ListFormat('nl', { type: 'conjunction' }).format(names.map(name => `@${name}`));
const invitedAccounts = count => (count === 1 ? '1 uitgenodigd account' : `${count} uitgenodigde accounts`);

// The ids the server's public list features; none when it cannot be read.
async function featuredGames(server) {
  try {
    const listing = await request(server, '/api/v1/games', { timeoutMs: 10_000 });
    return Array.isArray(listing?.featured) ? listing.featured : [];
  } catch {
    return [];
  }
}

async function setPrivate(ctx, value) {
  const settings = await ctx.settings();
  await requirePrivateGames(settings);
  const path = `/games/${enc(ctx.args[0])}`;
  // Nothing changes for a game that already is so. A featured game that turns private leaves the
  // featured list; the public list says whether it is on it.
  const before = await ctx.dev(path);
  const already = before.private === value;
  const unfeatured = value && !already && (await featuredGames(settings.server)).includes(before.id);
  const game = already ? before : await privateRequest(ctx, path, { method: 'PUT', body: { private: value } });
  const state = already ? 'was al' : 'is nu';
  const invites = game.invites ?? 0;
  const lines = [];
  if (value) {
    lines.push(
      invites
        ? `${game.id} ${state} privé. Alleen jij en ${invitedAccounts(invites)} kunnen er een room mee maken; meedoen kan iedereen met de code.`
        : `${game.id} ${state} privé. Alleen jij kunt er een room mee maken; meedoen kan iedereen met de code.`,
    );
    if (unfeatured) lines.push('Hij staat niet meer bij de uitgelichte games: een privégame kan niet uitgelicht worden.');
    if (!invites) lines.push(`Iemand uitnodigen: me game invite ${game.id} <gebruikersnaam>`);
  } else {
    lines.push(`${game.id} ${state} openbaar: iedereen op ${settings.server} kan hem zien en er een room mee maken.`);
    if (invites === 1) lines.push('Je uitnodiging blijft bewaard en telt weer als je hem privé maakt.');
    if (invites > 1) lines.push(`Je ${invites} uitnodigingen blijven bewaard en tellen weer als je hem privé maakt.`);
  }
  if (game.blocked || !game.enabled) lines.push(statusLine(game));
  return { data: game, text: lines.join('\n') };
}

function displayPath(cwd, target) {
  const rel = relative(cwd, target);
  if (!rel) return '.';
  return rel.startsWith('..') ? target : rel;
}

export function versionsTable(game) {
  return table(
    ['VERSIE', 'ACTIEF', 'IN GEBRUIK', 'BESTANDEN', 'GROOTTE', 'GEÜPLOAD', 'HASH'],
    newestFirst(game.versions ?? []).map(release => [
      release.version,
      release.active ? 'actief' : '',
      release.in_use ? 'ja' : '',
      release.file_count,
      formatBytes(release.size ?? 0),
      formatDate(release.created_at),
      shortHash(release.content_hash),
    ]),
  );
}

function statusLine(game) {
  if (game.blocked) return `${game.id} is geblokkeerd door de beheerder van de server.`;
  return game.enabled ? `${game.id} staat aan.` : `${game.id} staat uit. Aanzetten: me game enable ${game.id}`;
}

function parseKeep(value) {
  if (value === undefined) return 3;
  if (!/^\d+$/.test(value) || Number(value) > 1000) throw usageError('--keep moet een geheel getal van 0 tot 1000 zijn.');
  return Number(value);
}

export const gameGroups = [{ path: ['game'], summary: 'Je games maken, uploaden en beheren' }];

export const gameCommands = [
  {
    path: ['game', 'list'],
    usage: 'game list',
    summary: 'Je games met actieve versie, status en of ze privé zijn',
    async run(ctx) {
      const { server } = await ctx.settings();
      const { games } = await ctx.dev('/games');
      const text = games.length
        ? table(
            ['ID', 'TITEL', 'ACTIEF', 'STATUS', 'PRIVÉ', 'VERSIES'],
            games.map(game => [game.id, game.title, game.active_version ?? '-', gameStatus(game), privateCell(game), game.versions?.length ?? 0]),
          )
        : `Je hebt nog geen games op ${server}.\nMaak er een met: me init`;
      return { data: { server, games }, text };
    },
  },
  {
    path: ['game', 'new'],
    usage: 'game new <slug> [--dir MAP] [--template NAAM]',
    summary: 'Nieuwe game maken vanuit een SDK-sjabloon',
    description: [
      'Maakt een werkende game (runtime host; iedereen doet standaard mee, TV kan ook) in ./<slug>. De slug wordt het id van de game.',
      'Zonder opties is het de stemgame, in het Engels en eenvoudig opgemaakt. Met vragen en een keuze per stap: me init.',
      'De map bevat ook jsconfig.json en types/ voor je editor; .meignore houdt die buiten de upload.',
    ].join('\n'),
    options: { dir: { type: 'string' }, ...gameOptionFlags },
    optionHelp: [
      ['--dir MAP', 'Doelmap (standaard ./<slug>); moet nog niet bestaan'],
      ['--template NAAM', 'stemmen (standaard), quiz, buzzer, beurten of leeg'],
      ['--title TITEL', 'Naam van het spel (standaard gemaakt van de slug)'],
      ['--players MIN-MAX', 'Aantal spelers, bijvoorbeeld 2-8 (standaard per sjabloon)'],
      ['--modes LIJST', 'playing (Iedereen doet mee), tv of allebei; de eerste is de standaard'],
      ['--look NAAM', 'plain (standaard) of mini-engine-ui'],
      ['--theme NAAM', 'kalk, nacht, vilt of studio, bij mini-engine-ui'],
      ['--lang TAAL', 'Taal van het spel: en (standaard) of nl'],
    ],
    args: [1, 1],
    examples: ['me game new ja-of-nee', 'me game new kwis --template quiz --look mini-engine-ui --lang nl', 'me game new quiz --dir ~/games/quiz'],
    async run(ctx) {
      const [slug] = ctx.args;
      const target = resolve(ctx.cwd, ctx.flags.dir ?? slug);
      const { directory, files } = await scaffoldGame(slug, target, await gameOptionsFromFlags(ctx.flags));
      const shown = displayPath(ctx.cwd, directory);
      const { token } = await ctx.settings();
      const next = [`cd ${shown}`, 'me dev', ...(token ? [] : ['me auth']), 'me game upload'];
      return {
        data: { id: slug, directory, files },
        text: [`Game ${slug} gemaakt in ${shown} (${files.length} bestanden).`, '', 'Volgende stappen:', ...next.map(line => `  ${line}`)].join('\n'),
      };
    },
  },
  {
    path: ['game', 'upload'],
    usage: 'game upload [map] [--activate] [--private] [--dry-run]',
    summary: 'Gamemap inpakken en als nieuwe versie uploaden',
    description: [
      'Leest id en version uit manifest.json en uploadt alle bestanden als nieuwe versie.',
      'Overgeslagen: dotfiles en -mappen, node_modules, tests/ en patronen uit .meignore',
      '(één patroon per regel, * binnen een map, ** over mappen heen, eindig op / voor alleen mappen).',
      'Symlinks worden geweigerd. Limieten: 4096 bestanden, 2 MiB per bestand, 10 MiB totaal.',
      '',
      'De eerste versie van een game wordt meteen actief. Latere versies alleen met --activate;',
      'anders activeer je ze later met me game activate. Verhoog version in manifest.json voor elke upload.',
      '',
      'Met --private is de game privé voordat deze versie live kan gaan; ook een nieuwe game is dan nooit voor iedereen zichtbaar.',
      'Een upload zonder --private laat een privégame privé. Zet private niet in manifest.json: daarmee wordt een game niet privé, dus de CLI stopt dan.',
      '',
      'De velden achievements en set_kinds in manifest.json worden vooraf gecontroleerd en in het overzicht getoond.',
      'Ze werken vanaf Mini Engine 0.5; bij een oudere server krijg je eerst een waarschuwing.',
      'Afbeeldingen in sets ({"type": "string", "format": "image"}) werken vanaf Mini Engine 0.8; ook daarvoor waarschuwt de CLI.',
    ].join('\n'),
    options: { activate: { type: 'boolean' }, private: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    optionHelp: [
      ['--activate', 'Deze versie meteen actief maken'],
      ['--private', 'De game privé maken (vanaf Mini Engine 0.9): alleen jij en wie je uitnodigt, kunnen hem starten'],
      ['--dry-run', 'Alleen laten zien wat er geüpload zou worden'],
    ],
    args: [0, 1],
    examples: ['me game upload', 'me game upload ./ja-of-nee --activate', 'me game upload --private', 'me game upload --dry-run'],
    async run(ctx) {
      const dir = ctx.args[0] ?? '.';
      const pack = await packGame(resolve(ctx.cwd, dir));
      const declarations = declared(pack.manifest);
      const makePrivate = Boolean(ctx.flags.private);
      if (ctx.flags['dry-run']) {
        return {
          data: { dry_run: true, id: pack.id, version: pack.version, size: pack.totalBytes, files: pack.files, ...declarations, ...(makePrivate ? { private: true } : {}) },
          text: [
            `${pack.id} ${pack.version}: ${pack.files.length} bestanden, ${formatBytes(pack.totalBytes)}`,
            table(['BESTAND', 'GROOTTE'], pack.files.map(file => [file.path, formatBytes(file.size)])),
            ...declaredLines(declarations),
            '',
            ...(makePrivate ? [`Met --private wordt ${pack.id} privé.`] : []),
            'Niets geüpload (--dry-run).',
          ].join('\n'),
        };
      }
      const { server, token } = await ctx.settings();
      const engineVersion = token ? await serverVersion(server) : null;
      const nothingSent = ' Er is niets geüpload.';
      if (makePrivate && olderThan(engineVersion, 0, 9)) throw privateUnsupported(server, engineVersion, nothingSent);
      const beforeHome = olderThan(engineVersion, 0, 5);
      const used = ['achievements', 'set_kinds'].filter(field => declarations[field].length);
      const warnings = [];
      if (used.length && beforeHome) {
        warnings.push(`Let op: ${server} draait Mini Engine ${engineVersion}, die ${used.join(' en ')} in manifest.json negeert. Die werken pas vanaf Mini Engine 0.5.`);
      }
      if (olderThan(engineVersion, 0, 8) && (pack.manifest.set_kinds ?? []).some(kind => hasImageFields(kind.schema))) {
        warnings.push(`Let op: ${server} draait Mini Engine ${engineVersion}. Afbeeldingen in sets (format "image") werken pas vanaf Mini Engine 0.8; deze server weigert dit schema.`);
      }
      if (!ctx.json) warnings.forEach(warning => ctx.warn(warning));
      const body = { files: pack.encoded };
      if (ctx.flags.activate) body.activate = true;
      if (makePrivate) body.private = true;
      const path = `/games/${enc(pack.id)}/versions`;
      const options = { method: 'POST', body, timeoutMs: 120_000 };
      const { game, release } = makePrivate ? await privateRequest(ctx, path, options, nothingSent) : await ctx.dev(path, options);
      const lines = [
        `Geüpload: ${game.id} ${release.version} naar ${server}`,
        `  Bestanden  ${release.file_count}`,
        `  Grootte    ${formatBytes(release.size)}`,
        `  Hash       ${release.content_hash}`,
        `  Actief     ${release.active ? 'ja' : `nee (actief is ${game.active_version ?? 'geen'})`}`,
        ...(game.private ? ['  Privé      ja'] : []),
        ...declaredLines(declarations),
        '',
      ];
      const first = release.active && (game.versions ?? []).length === 1;
      const play = release.active && !game.blocked && game.enabled ? `${server}${beforeHome ? '/demo' : '/home'}/new/${game.id}` : null;
      if (!release.active) lines.push(`Activeren: me game activate ${game.id} ${release.version}`);
      else if (!play) lines.push(statusLine(game));
      else {
        if (first && game.private) {
          lines.push(
            `Dit is de eerste versie van ${game.id}. Die is meteen actief, maar privé: alleen jij ziet hem op de site als je bent ingelogd. Meedoen kan iedereen met de code.`,
            `Vrienden uitnodigen: me game invite ${game.id} <gebruikersnaam>`,
          );
        } else if (first) {
          lines.push(`Dit is de eerste versie van ${game.id}, dus die staat meteen live: iedereen op ${server} kan hem spelen.`);
          // Only a hint the server can follow.
          if (!olderThan(engineVersion, 0, 9)) lines.push(`Alleen voor jou en je vrienden? Maak hem privé: me game private ${game.id}`);
        }
        if (first) lines.push('Volgende versies gaan pas live met me game upload --activate.', '');
        lines.push(`Spelen: ${play}`);
      }
      return { data: { game, release, ...declarations, warnings, first_upload: first, play_url: play }, text: lines.join('\n') };
    },
  },
  {
    path: ['game', 'versions'],
    usage: 'game versions <id>',
    summary: 'Versies van een game',
    description: 'IN GEBRUIK betekent dat een lopende room die versie speelt; zo’n versie kan niet worden verwijderd.',
    args: [1, 1],
    async run(ctx) {
      const game = await ctx.dev(`/games/${enc(ctx.args[0])}`);
      const text = game.versions?.length ? `${game.title} (${game.id}) · ${gameState(game)}\n\n${versionsTable(game)}` : `${game.id} heeft geen versies.`;
      return { data: game, text };
    },
  },
  {
    path: ['game', 'activate'],
    usage: 'game activate <id> <versie>',
    summary: 'Actieve versie wisselen of terugzetten',
    description: 'Nieuwe rooms gebruiken de actieve versie. Lopende rooms houden de versie waarmee ze begonnen.',
    args: [2, 2],
    examples: ['me game activate ja-of-nee 0.1.0'],
    async run(ctx) {
      const [id, version] = ctx.args;
      const game = await ctx.dev(`${releaseUrl(id, version)}/activate`, { method: 'POST' });
      const lines = [`Actieve versie van ${game.id} is nu ${game.active_version}.`];
      if (game.blocked || !game.enabled) lines.push(statusLine(game));
      return { data: game, text: lines.join('\n') };
    },
  },
  {
    path: ['game', 'enable'],
    usage: 'game enable <id>',
    summary: 'Game tonen en nieuwe rooms toestaan',
    args: [1, 1],
    async run(ctx) {
      const game = await ctx.dev(`/games/${enc(ctx.args[0])}`, { method: 'PUT', body: { enabled: true } });
      return { data: game, text: statusLine(game) };
    },
  },
  {
    path: ['game', 'disable'],
    usage: 'game disable <id>',
    summary: 'Game verbergen; lopende rooms spelen door',
    args: [1, 1],
    async run(ctx) {
      const game = await ctx.dev(`/games/${enc(ctx.args[0])}`, { method: 'PUT', body: { enabled: false } });
      return { data: game, text: `${game.id} staat uit. Lopende rooms spelen door; nieuwe rooms kunnen niet meer.` };
    },
  },
  {
    path: ['game', 'private'],
    usage: 'game private <id>',
    summary: 'Game privé maken: alleen jij en wie je uitnodigt, kunnen hem starten',
    description: [
      'Alleen jij en de accounts die je uitnodigt (me game invite) zien de game op de site als ze zijn ingelogd, en alleen zij kunnen er een room mee maken.',
      'Meedoen kan iedereen met de code, ook zonder account. Lopende rooms spelen door. Een privégame kan niet uitgelicht worden.',
      'Werkt vanaf Mini Engine 0.9. Een nieuwe game meteen privé uploaden: me game upload --private',
    ].join('\n'),
    args: [1, 1],
    examples: ['me game private kwis', 'me game invite kwis dani sander'],
    run: ctx => setPrivate(ctx, true),
  },
  {
    path: ['game', 'public'],
    usage: 'game public <id>',
    summary: 'Game weer openbaar maken voor iedereen op de server',
    description: 'Je uitnodigingen blijven bewaard en tellen weer als je de game privé maakt. Werkt vanaf Mini Engine 0.9.',
    args: [1, 1],
    run: ctx => setPrivate(ctx, false),
  },
  {
    path: ['game', 'invite'],
    usage: 'game invite <id> <gebruikersnaam>...',
    summary: 'Accounts uitnodigen die je privégame mogen starten',
    description: [
      'Uitgenodigde accounts zien je privégame op de site als ze zijn ingelogd en kunnen er een room mee maken, ook zonder dev key. Hoogstens 50 per game. Een @ voor de naam mag.',
      'Een uitnodiging voor een openbare game telt zodra je hem privé maakt. Werkt vanaf Mini Engine 0.9.',
    ].join('\n'),
    args: [2, 51],
    examples: ['me game invite kwis dani', 'me game invite kwis @dani @sander'],
    async run(ctx) {
      const [id, ...given] = ctx.args;
      const usernames = [...new Set(given.map(username))];
      const settings = await ctx.settings();
      await requirePrivateGames(settings);
      const result = await privateRequest(ctx, `/games/${enc(id)}/invites`, { method: 'POST', body: { usernames } });
      const added = result.added ?? [];
      const already = usernames.filter(name => !added.includes(name));
      const lines = [];
      if (added.length) lines.push(`Uitgenodigd voor ${id}: ${atList(added)}.`);
      if (already.length) lines.push(`${atList(already)} ${already.length === 1 ? 'was' : 'waren'} al uitgenodigd.`);
      lines.push(
        result.private
          ? `Wie is uitgenodigd, ziet ${id} na het inloggen op ${settings.server}/home/new/${id}`
          : `${id} is openbaar, dus iedereen kan hem al starten. De uitnodiging telt zodra je hem privé maakt: me game private ${id}`,
      );
      return { data: result, text: lines.join('\n') };
    },
  },
  {
    path: ['game', 'uninvite'],
    usage: 'game uninvite <id> <gebruikersnaam>',
    summary: 'Uitnodiging intrekken',
    description: 'Het account kan dan geen rooms meer maken met je privégame. Rooms die al lopen, spelen door. Werkt vanaf Mini Engine 0.9.',
    args: [2, 2],
    examples: ['me game uninvite kwis dani'],
    async run(ctx) {
      const id = ctx.args[0];
      const name = username(ctx.args[1]);
      await requirePrivateGames(await ctx.settings());
      await privateRequest(ctx, `/games/${enc(id)}/invites/${enc(name)}`, { method: 'DELETE' });
      return { data: { id, username: name, uninvited: true }, text: `@${name} is niet meer uitgenodigd voor ${id}. Rooms die al lopen, spelen door.` };
    },
  },
  {
    path: ['game', 'invites'],
    usage: 'game invites <id>',
    summary: 'Wie je voor een game hebt uitgenodigd',
    description: 'Op gebruikersnaam, met de datum van de uitnodiging. Werkt vanaf Mini Engine 0.9.',
    args: [1, 1],
    async run(ctx) {
      const [id] = ctx.args;
      await requirePrivateGames(await ctx.settings());
      const result = await privateRequest(ctx, `/games/${enc(id)}/invites`);
      const invites = result.invites ?? [];
      const text = invites.length
        ? [
            result.private ? `${id} is privé. Deze accounts kunnen hem starten:` : `${id} is openbaar. Deze uitnodigingen tellen zodra je hem privé maakt:`,
            '',
            table(['GEBRUIKERSNAAM', 'NAAM', 'UITGENODIGD'], invites.map(invite => [invite.username, invite.display_name, formatDate(invite.invited_at)])),
          ].join('\n')
        : `Nog niemand uitgenodigd voor ${id}.\nUitnodigen: me game invite ${id} <gebruikersnaam>`;
      return { data: result, text };
    },
  },
  {
    path: ['game', 'delete-version'],
    usage: 'game delete-version <id> <versie>',
    summary: 'Eén oude versie verwijderen',
    description: 'De actieve versie en versies die een lopende room gebruikt, kun je niet verwijderen.',
    args: [2, 2],
    async run(ctx) {
      const [id, version] = ctx.args;
      await ctx.dev(releaseUrl(id, version), { method: 'DELETE' });
      return { data: { id, version, deleted: true }, text: `Versie ${version} van ${id} verwijderd.` };
    },
  },
  {
    path: ['game', 'prune'],
    usage: 'game prune <id> [--keep N] [--yes] [--dry-run]',
    summary: 'Oude versies opruimen',
    description:
      'Verwijdert alle versies behalve de actieve en de nieuwste N. Versies die een lopende room gebruikt, worden overgeslagen.\nEen game mag maximaal 10 versies bewaren.',
    options: { keep: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' } },
    optionHelp: [
      ['--keep N', 'Aantal nieuwste versies dat blijft (standaard 3)'],
      ['-y, --yes', 'Niet om bevestiging vragen'],
      ['--dry-run', 'Alleen laten zien wat er weg zou gaan'],
    ],
    args: [1, 1],
    examples: ['me game prune ja-of-nee', 'me game prune ja-of-nee --keep 1 --yes'],
    async run(ctx) {
      const [id] = ctx.args;
      const keep = parseKeep(ctx.flags.keep);
      const game = await ctx.dev(`/games/${enc(id)}`);
      const plan = selectPrune(game, keep);
      const versions = list => list.map(release => release.version);
      const data = {
        id: game.id,
        keep: versions(plan.keep),
        deleted: [],
        skipped: plan.in_use.map(release => ({ version: release.version, reason: 'in_use' })),
        failed: [],
        dry_run: Boolean(ctx.flags['dry-run']),
      };
      const lines = [`Blijft: ${versions(plan.keep).join(', ') || '-'}`];
      if (plan.in_use.length) lines.push(`Overgeslagen (in gebruik): ${versions(plan.in_use).join(', ')}`);
      if (!plan.delete.length) {
        lines.push('Niets op te ruimen.');
        return { data, text: lines.join('\n') };
      }
      if (ctx.flags['dry-run']) {
        data.deleted = versions(plan.delete);
        lines.push(`Zou verwijderen: ${data.deleted.join(', ')}`, 'Niets verwijderd (--dry-run).');
        return { data, text: lines.join('\n') };
      }
      if (!ctx.json) ctx.warn([...lines, `Verwijderen: ${versions(plan.delete).join(', ')}`].join('\n'));
      const confirmed = await ctx.confirm(`${plan.delete.length} ${plan.delete.length === 1 ? 'versie' : 'versies'} van ${game.id} verwijderen (${versions(plan.delete).join(', ')})?`);
      if (!confirmed) throw new CliError('Niets verwijderd.', { code: 'aborted' });
      for (const release of plan.delete) {
        try {
          await ctx.dev(releaseUrl(game.id, release.version), { method: 'DELETE' });
          data.deleted.push(release.version);
        } catch (error) {
          if (error.code === 'release_in_use' || error.code === 'release_active') {
            data.skipped.push({ version: release.version, reason: error.code === 'release_in_use' ? 'in_use' : 'active' });
          } else {
            data.failed.push({ version: release.version, code: error.code, message: error.message });
          }
        }
      }
      const out = [`Verwijderd: ${data.deleted.join(', ') || '-'}`];
      const lateSkips = data.skipped.filter(item => !plan.in_use.some(release => release.version === item.version));
      if (lateSkips.length) out.push(`Overgeslagen: ${lateSkips.map(item => item.version).join(', ')} (net in gebruik genomen)`);
      for (const item of data.failed) out.push(`Mislukt: ${item.version}: ${item.message}`);
      return { data, text: out.join('\n'), exitCode: data.failed.length ? 1 : 0 };
    },
  },
  {
    path: ['game', 'delete'],
    usage: 'game delete <id> [--yes]',
    summary: 'Hele game met alle versies verwijderen',
    description: 'Dit kan niet ongedaan worden gemaakt. Lukt niet zolang een lopende room de game gebruikt.',
    options: { yes: { type: 'boolean', short: 'y' } },
    optionHelp: [['-y, --yes', 'Niet om bevestiging vragen']],
    args: [1, 1],
    async run(ctx) {
      const [id] = ctx.args;
      const confirmed = await ctx.confirm(`Game ${id} en al zijn versies definitief verwijderen?`);
      if (!confirmed) throw new CliError('Niets verwijderd.', { code: 'aborted' });
      await ctx.dev(`/games/${enc(id)}`, { method: 'DELETE' });
      return { data: { id, deleted: true }, text: `Game ${id} verwijderd.` };
    },
  },
];
