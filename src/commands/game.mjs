import { relative, resolve } from 'node:path';
import { enc, request } from '../api.mjs';
import { CliError, usageError } from '../errors.mjs';
import { formatBytes, formatDate, gameStatus, table } from '../format.mjs';
import { declared, packGame } from '../pack.mjs';
import { newestFirst, selectPrune } from '../prune.mjs';
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

function olderThan(version, major, minor) {
  const parts = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!parts) return false;
  const [have, sub] = [Number(parts[1]), Number(parts[2])];
  return have < major || (have === major && sub < minor);
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
    summary: 'Je games met actieve versie en status',
    async run(ctx) {
      const { server } = await ctx.settings();
      const { games } = await ctx.dev('/games');
      const text = games.length
        ? table(
            ['ID', 'TITEL', 'ACTIEF', 'STATUS', 'VERSIES'],
            games.map(game => [game.id, game.title, game.active_version ?? '-', gameStatus(game), game.versions?.length ?? 0]),
          )
        : `Je hebt nog geen games op ${server}.\nMaak er een met: me game new <slug>`;
      return { data: { server, games }, text };
    },
  },
  {
    path: ['game', 'new'],
    usage: 'game new <slug> [--dir MAP]',
    summary: 'Nieuwe game maken vanuit het SDK-sjabloon',
    description:
      'Maakt een werkende stemgame (runtime host, moderator) in ./<slug>. De slug wordt het id van de game.\nDe map bevat ook jsconfig.json en types/ voor je editor; .meignore houdt die buiten de upload.',
    options: { dir: { type: 'string' } },
    optionHelp: [['--dir MAP', 'Doelmap (standaard ./<slug>); moet nog niet bestaan']],
    args: [1, 1],
    examples: ['me game new ja-of-nee', 'me game new quiz --dir ~/games/quiz'],
    async run(ctx) {
      const [slug] = ctx.args;
      const target = resolve(ctx.cwd, ctx.flags.dir ?? slug);
      const { directory, files } = await scaffoldGame(slug, target);
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
    usage: 'game upload [map] [--activate] [--dry-run]',
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
      'De velden achievements en set_kinds in manifest.json worden vooraf gecontroleerd en in het overzicht getoond.',
      'Ze werken vanaf Mini Engine 0.5; bij een oudere server krijg je eerst een waarschuwing.',
    ].join('\n'),
    options: { activate: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    optionHelp: [
      ['--activate', 'Deze versie meteen actief maken'],
      ['--dry-run', 'Alleen laten zien wat er geüpload zou worden'],
    ],
    args: [0, 1],
    examples: ['me game upload', 'me game upload ./ja-of-nee --activate', 'me game upload --dry-run'],
    async run(ctx) {
      const dir = ctx.args[0] ?? '.';
      const pack = await packGame(resolve(ctx.cwd, dir));
      const declarations = declared(pack.manifest);
      if (ctx.flags['dry-run']) {
        return {
          data: { dry_run: true, id: pack.id, version: pack.version, size: pack.totalBytes, files: pack.files, ...declarations },
          text: [
            `${pack.id} ${pack.version}: ${pack.files.length} bestanden, ${formatBytes(pack.totalBytes)}`,
            table(['BESTAND', 'GROOTTE'], pack.files.map(file => [file.path, formatBytes(file.size)])),
            ...declaredLines(declarations),
            '',
            'Niets geüpload (--dry-run).',
          ].join('\n'),
        };
      }
      const { server, token } = await ctx.settings();
      const engineVersion = token ? await serverVersion(server) : null;
      const beforeHome = olderThan(engineVersion, 0, 5);
      const used = ['achievements', 'set_kinds'].filter(field => declarations[field].length);
      const warnings = [];
      if (used.length && beforeHome) {
        warnings.push(`Let op: ${server} draait Mini Engine ${engineVersion}, die ${used.join(' en ')} in manifest.json negeert. Die werken pas vanaf Mini Engine 0.5.`);
      }
      if (!ctx.json) warnings.forEach(warning => ctx.warn(warning));
      const body = { files: pack.encoded };
      if (ctx.flags.activate) body.activate = true;
      const { game, release } = await ctx.dev(`/games/${enc(pack.id)}/versions`, { method: 'POST', body, timeoutMs: 120_000 });
      const lines = [
        `Geüpload: ${game.id} ${release.version} naar ${server}`,
        `  Bestanden  ${release.file_count}`,
        `  Grootte    ${formatBytes(release.size)}`,
        `  Hash       ${release.content_hash}`,
        `  Actief     ${release.active ? 'ja' : `nee (actief is ${game.active_version ?? 'geen'})`}`,
        ...declaredLines(declarations),
        '',
      ];
      if (!release.active) lines.push(`Activeren: me game activate ${game.id} ${release.version}`);
      else if (game.blocked || !game.enabled) lines.push(statusLine(game));
      else lines.push(`Spelen: ${server}${beforeHome ? '/demo' : '/home'}/new/${game.id}`);
      return { data: { game, release, ...declarations, warnings }, text: lines.join('\n') };
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
      const text = game.versions?.length ? `${game.title} (${game.id}) · ${gameStatus(game)}\n\n${versionsTable(game)}` : `${game.id} heeft geen versies.`;
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
