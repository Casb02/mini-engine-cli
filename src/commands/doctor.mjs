import { access } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { enc, request } from '../api.mjs';
import { homeDir } from '../config.mjs';
import { CliError } from '../errors.mjs';
import { formatBytes, maskToken, tildePath } from '../format.mjs';
import { packGame } from '../pack.mjs';
import { skillStatus } from '../skills.mjs';
import { PACKAGE } from '../vendor.mjs';
import { skillTarget } from './skill.mjs';

const LATEST_URL = 'https://raw.githubusercontent.com/Casb02/mini-engine-cli/main/package.json';
const UPDATE = 'npm install -g github:Casb02/mini-engine-cli';

function newer(a, b) {
  const parse = version => String(version).split(/[.+-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) if ((x[index] || 0) !== (y[index] || 0)) return (x[index] || 0) > (y[index] || 0);
  return false;
}

const pass = (id, title) => ({ id, ok: true, title });
const fail = (id, title, fix) => ({ id, ok: false, title, fix });
const skip = (id, title) => ({ id, ok: null, title });

async function latestVersion(env) {
  try {
    const response = await fetch(env.MINIENGINE_VERSION_URL || LATEST_URL, { signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'mini-engine-cli' } });
    if (!response.ok) return null;
    const version = (await response.json())?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** The role pages must load their scripts and styles from /games/<id>/assets/ of this game, and those files must be there. */
function assetProblems(pack, contents) {
  const problems = [];
  for (const page of ['host.html', 'player.html', 'display.html']) {
    const html = contents.get(page);
    if (!html) continue;
    for (const [, url] of html.matchAll(/(?:src|href)="(\/games\/[^"?#]+)"/g)) {
      const [, , id, ...rest] = url.split('/');
      const path = rest.join('/');
      if (id !== pack.id) problems.push({ text: `${page} laadt ${url}, maar het id van het spel is ${pack.id}.`, fix: `Verander het pad in /games/${pack.id}/${path}.` });
      else if (!pack.files.some(file => file.path === path)) problems.push({ text: `${page} laadt ${url}, maar ${path} staat niet in het spel.`, fix: 'Zet het bestand op die plek, of haal de verwijzing weg (kijk ook in .meignore).' });
    }
  }
  return problems;
}

async function gameChecks(ctx, dir, reach) {
  const shown = relative(ctx.cwd, dir) || '.';
  let pack;
  try {
    pack = await packGame(dir);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return [fail('game', `Het spel in ${shown} kan zo niet worden geüpload: ${error.message}`, error.hint ?? 'Pas het aan en draai me doctor opnieuw.')];
  }
  const contents = new Map(Object.entries(pack.encoded).filter(([path]) => path.endsWith('.html')).map(([path, data]) => [path, Buffer.from(data, 'base64').toString('utf8')]));
  const problems = assetProblems(pack, contents);
  const checks = [
    problems.length
      ? fail('game', `Het spel ${pack.id} ${pack.version} in ${shown} mist bestanden. ${problems[0].text}${problems.length > 1 ? ` (en nog ${problems.length - 1})` : ''}`, problems[0].fix)
      : pass('game', `Spel ${pack.id} ${pack.version} in ${shown}: ${pack.files.length} bestanden, ${formatBytes(pack.totalBytes)}, klaar om te uploaden`),
  ];
  if (reach?.loggedIn) {
    try {
      const game = await ctx.dev(`/games/${enc(pack.id)}`);
      if ((game.versions ?? []).some(release => release.version === pack.version)) {
        checks.push(fail('version', `Versie ${pack.version} van ${pack.id} staat al op ${reach.server}.`, 'Verhoog version in manifest.json voor de volgende upload.'));
      } else {
        checks.push(pass('version', `Versie ${pack.version} is nieuw op ${reach.server}`));
      }
    } catch (error) {
      if (error.status === 404) checks.push(pass('version', `${pack.id} is nog niet geüpload; de eerste upload staat meteen live`));
      else if (error.status === 403) checks.push(fail('version', `Het id ${pack.id} hoort op ${reach.server} bij iemand anders.`, 'Kies een ander id in manifest.json.'));
      else checks.push(skip('version', `Versies op de server niet bekeken: ${error.message}`));
    }
  }
  return checks;
}

export const doctorCommands = [
  {
    path: ['doctor'],
    usage: 'doctor [map]',
    summary: 'Controleren of alles klaarstaat, met een oplossing per probleem',
    description: [
      'Loopt alles langs wat je nodig hebt, met per probleem één manier om het op te lossen:',
      'de versie van Node.js en van de CLI, de server en of die bereikbaar is, je dev key en de AI-skills.',
      'Staat er een manifest.json in deze map (of in [map]), dan controleert doctor ook het spel,',
      'zoals me game upload --dry-run dat doet, en of de pagina’s alleen bestanden laden die er zijn.',
      '',
      'Zonder internet slaat doctor de controle op een nieuwere CLI over. Exitcode 1 als er iets op te lossen is.',
    ].join('\n'),
    args: [0, 1],
    examples: ['me doctor', 'me doctor ./ja-of-nee', 'me doctor --json'],
    async run(ctx) {
      const checks = [];
      const node = process.versions.node;
      checks.push(Number(node.split('.')[0]) >= 22 ? pass('node', `Node.js ${node}`) : fail('node', `Node.js ${node} is te oud; de CLI heeft 22 of nieuwer nodig.`, 'Installeer Node.js 22 of nieuwer, bijvoorbeeld van nodejs.org.'));

      const latest = await latestVersion(ctx.env);
      if (!latest) checks.push(skip('cli', `CLI ${PACKAGE.version}; nieuwste versie niet bekeken (geen verbinding met GitHub)`));
      else if (newer(latest, PACKAGE.version)) checks.push(fail('cli', `CLI ${PACKAGE.version}; versie ${latest} is uit.`, `Bijwerken: ${UPDATE}`));
      else checks.push(pass('cli', `CLI ${PACKAGE.version} is de nieuwste versie`));

      const settings = await ctx.settings();
      const { server } = settings;
      const where = settings.serverSource === 'standaard' ? ' (standaard)' : settings.serverSource === 'config' ? '' : ` (uit ${settings.serverSource})`;
      let reach = null;
      try {
        const health = await request(server, '/api/health', { timeoutMs: 8000 });
        reach = { server, version: typeof health?.version === 'string' ? health.version : null, loggedIn: false };
        checks.push(pass('server', `Server ${server}${where} is bereikbaar${reach.version ? `, Mini Engine ${reach.version}` : ''}`));
      } catch (error) {
        checks.push(fail('server', `Server ${server}${where} is niet bereikbaar: ${error.message}`, 'Controleer je internet en het adres, of kies een andere server: me auth --server <adres>'));
      }

      if (!settings.token) {
        checks.push(fail('auth', `Geen dev key voor ${server}; uploaden kan nog niet. Spelen met me dev lukt wel.`, 'Vraag een dev key aan wie de server beheert en log in met: me auth'));
      } else if (!reach) {
        checks.push(skip('auth', `Dev key ${maskToken(settings.token)} niet gecontroleerd: de server is niet bereikbaar`));
      } else {
        try {
          const me = await ctx.dev('/me');
          reach.loggedIn = true;
          checks.push(pass('auth', `Ingelogd als ${me.account.display_name} (@${me.account.username}) met ${maskToken(settings.token)}`));
        } catch (error) {
          checks.push(fail('auth', `Je dev key ${maskToken(settings.token)} werkt niet op ${server}: ${error.message}`, error.status === 401 ? 'Log opnieuw in met: me auth' : 'Probeer het zo opnieuw, of log opnieuw in met: me auth'));
        }
      }

      const target = skillTarget(ctx, {});
      const skills = await skillStatus(target);
      const missing = skills.filter(skill => skill.status === 'missing').map(skill => skill.name);
      const different = skills.filter(skill => skill.status === 'different').map(skill => skill.name);
      const place = tildePath(target, homeDir(ctx.env));
      if (missing.length) checks.push(fail('skills', `AI-skills ontbreken in ${place}: ${missing.join(', ')}`, 'Installeren: me skill install'));
      else if (different.length) checks.push(fail('skills', `Een andere versie van ${different.join(', ')} staat in ${place}`, 'Bijwerken (overschrijft eigen wijzigingen): me skill install --force'));
      else checks.push(pass('skills', `AI-skills staan in ${place}`));

      const dir = resolve(ctx.cwd, ctx.args[0] ?? '.');
      const inGame = await access(join(dir, 'manifest.json')).then(() => true, () => false);
      if (inGame) checks.push(...(await gameChecks(ctx, dir, reach)));
      else if (ctx.args[0] !== undefined) checks.push(fail('game', `Geen manifest.json in ${relative(ctx.cwd, dir) || '.'}.`, 'Maak een spel met: me init'));

      const problems = checks.filter(check => check.ok === false);
      const text = [
        ...checks.map(check => {
          const mark = check.ok === true ? '✓' : check.ok === false ? '✗' : '–';
          return check.fix ? `${mark} ${check.title}\n    ${check.fix}` : `${mark} ${check.title}`;
        }),
        '',
        problems.length ? `${problems.length} ${problems.length === 1 ? 'ding' : 'dingen'} om op te lossen.` : 'Alles in orde.',
      ].join('\n');
      return { data: { ok: !problems.length, checks }, text, exitCode: problems.length ? 1 : 0 };
    },
  },
];
