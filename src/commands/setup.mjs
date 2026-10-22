import { relative, resolve } from 'node:path';
import { request } from '../api.mjs';
import { homeDir, normalizeServer, updateConfig } from '../config.mjs';
import { CliError, usageError } from '../errors.mjs';
import { maskToken, terminalSafe, tildePath } from '../format.mjs';
import { checkSlug, scaffoldGame } from '../scaffold.mjs';
import { installSkills } from '../skills.mjs';
import { login, verifyDevKey } from './auth.mjs';
import { skillTarget } from './skill.mjs';

function shownPath(cwd, target) {
  const rel = relative(cwd, target);
  return rel && !rel.startsWith('..') ? rel : target;
}

export const setupCommands = [
  {
    path: ['setup'],
    usage: 'setup [opties]',
    summary: 'Eerste keer instellen: server, dev key, skills en een eerste game',
    description:
      'Loopt de stappen één voor één langs; elke stap kun je overslaan.\nMet opties of --yes gaat het zonder vragen, bijvoorbeeld in een script.',
    options: {
      token: { type: 'string' },
      skills: { type: 'boolean' },
      'no-skills': { type: 'boolean' },
      game: { type: 'string' },
      'no-game': { type: 'boolean' },
      dir: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
    },
    optionHelp: [
      ['--server URL', 'Server (standaard de huidige, anders https://miniengine.nl)'],
      ['--token KEY', 'Dev key; zonder deze optie vraagt setup erom'],
      ['--skills, --no-skills', 'AI-skills wel of niet installeren in ~/.claude/skills'],
      ['--game SLUG, --no-game', 'Wel of geen eerste game maken'],
      ['--dir MAP', 'Map voor de eerste game (standaard ./<slug>)'],
      ['-y, --yes', 'Niets vragen: huidige server, skills installeren, geen game'],
    ],
    examples: ['me setup', 'me setup --server https://games.example.nl --token "$KEY" --no-skills --game ja-of-nee'],
    async run(ctx) {
      const { flags } = ctx;
      if (flags.skills && flags['no-skills']) throw usageError('Gebruik --skills of --no-skills, niet allebei.');
      if (flags.game && flags['no-game']) throw usageError('Gebruik --game of --no-game, niet allebei.');
      if (flags.game) checkSlug(flags.game);
      const ask = !flags.yes;
      const say = text => ctx.stderr.write(`${terminalSafe(text)}\n`);
      const prompter = () => ctx.prompter;
      const settings = await ctx.settings();
      const result = { server: null, server_version: null, account: null, skills: null, game: null, next: [] };

      say('Mini Engine instellen. Laat een vraag leeg om de standaard te kiezen of de stap over te slaan.\n');

      let server = settings.server;
      if (!flags.server && ask) server = normalizeServer(await prompter().ask('1/4 Server-URL', { defaultValue: settings.server }));
      result.server = server;
      try {
        const health = await request(server, '/api/health', { timeoutMs: 10_000 });
        result.server_version = health?.version ?? null;
        say(`    Bereikbaar: Mini Engine ${result.server_version ?? '(onbekende versie)'}`);
      } catch (error) {
        say(`    Let op: ${error.message}`);
      }
      await updateConfig(ctx.env, { server });

      let current = null;
      if (settings.token && !flags.token) {
        current = await verifyDevKey(server, settings.token).catch(() => null);
      }
      let token = flags.token?.trim();
      for (let attempt = 0; ; attempt += 1) {
        if (!token && ask) {
          const keep = current ? `leeg = blijf ${current.account.username}` : 'leeg = overslaan';
          token = await prompter().askHidden(`2/4 Plak je dev key (${keep})`);
        }
        if (!token) {
          if (current) {
            result.account = current.account;
            say(`    Ingelogd als ${current.account.display_name} (@${current.account.username}).`);
          } else {
            say('    Overgeslagen. Later inloggen: me auth');
          }
          break;
        }
        try {
          const { me } = await login(ctx, { server, token });
          result.account = me.account;
          say(`    Ingelogd als ${me.account.display_name} (@${me.account.username}), sleutel ${maskToken(token)} opgeslagen.`);
          break;
        } catch (error) {
          if (!ask || flags.token || attempt >= 2 || !(error instanceof CliError)) throw error;
          say(`    ${error.message}`);
          token = undefined;
        }
      }

      let installSkillsNow = flags.skills ? true : flags['no-skills'] ? false : undefined;
      const target = skillTarget(ctx, {});
      if (installSkillsNow === undefined) installSkillsNow = ask ? await prompter().confirm(`3/4 AI-skills voor Claude Code installeren in ${tildePath(target, homeDir(ctx.env))}?`, true) : true;
      if (installSkillsNow) {
        try {
          const plan = await installSkills(target, []);
          result.skills = { target, installed: plan.map(item => ({ name: item.name, status: item.status })) };
          say(`    Skills: ${plan.map(item => `${item.name} (${item.status})`).join(', ')}`);
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          result.skills = { target, error: error.message };
          say(`    ${error.message} Overschrijven: me skill install --force`);
        }
      } else {
        say('    Overgeslagen. Later: me skill install');
      }

      let slug = flags.game;
      if (!slug && !flags['no-game'] && ask && (await prompter().confirm('4/4 Een eerste game maken?', false))) {
        for (;;) {
          slug = await prompter().ask('    Slug (kleine letters, cijfers, streepjes)', { defaultValue: 'mijn-game' });
          try {
            checkSlug(slug);
            break;
          } catch (error) {
            say(`    ${error.message}`);
          }
        }
      }
      let shown = null;
      if (slug) {
        const created = await scaffoldGame(slug, resolve(ctx.cwd, flags.dir ?? slug));
        shown = shownPath(ctx.cwd, created.directory);
        result.game = { id: slug, directory: created.directory };
        say(`    Game ${slug} gemaakt in ${shown}.`);
      } else if (!flags['no-game'] && ask) {
        say('    Overgeslagen. Later: me game new <slug>');
      }

      if (!result.account) result.next = ['me auth', `me game new ${slug ?? 'mijn-game'}`, `me dev ${shown ?? 'mijn-game'}`, `me game upload ${shown ?? 'mijn-game'}`];
      else if (shown) result.next = [`cd ${shown}`, 'me dev', 'me game upload', 'me game list'];
      else result.next = ['me game new mijn-game', 'cd mijn-game', 'me dev', 'me game upload'];
      return { data: result, text: ['', 'Klaar. Volgende stappen:', ...result.next.map(line => `  ${line}`)].join('\n') };
    },
  },
];
