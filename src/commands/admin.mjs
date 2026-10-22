import { enc, request } from '../api.mjs';
import { updateConfig } from '../config.mjs';
import { CliError, usageError } from '../errors.mjs';
import { formatDate, gameStatus, maskToken, table } from '../format.mjs';

function tokenState(token) {
  if (token.revoked_at) return 'ingetrokken';
  if (token.expires_at && new Date(typeof token.expires_at === 'number' ? token.expires_at * 1000 : token.expires_at) < new Date()) return 'verlopen';
  return 'actief';
}

const ownerName = owner => (owner && typeof owner === 'object' ? owner.username : owner) ?? '-';

function parseDays(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 3650) throw usageError('--expires moet een aantal dagen van 1 tot 3650 zijn.');
  return Number(value);
}

export const adminGroups = [
  { path: ['admin'], summary: 'Beheer voor de eigenaar van de server (admintoken nodig)', description: 'Het admintoken is MINI_ENGINE_ADMIN_TOKEN van de server. Bewaar het met: me admin login' },
  { path: ['admin', 'token'], summary: 'Dev keys van ontwikkelaars beheren' },
  { path: ['admin', 'game'], summary: 'Games van ontwikkelaars blokkeren of vrijgeven' },
];

async function setBlocked(ctx, blocked) {
  const [id] = ctx.args;
  const game = await ctx.admin(`/games/${enc(id)}`, { method: 'PUT', body: { enabled: !blocked } });
  return {
    data: game,
    text: blocked ? `${game.id} is geblokkeerd. De eigenaar kan hem niet meer aanzetten; lopende rooms spelen door.` : `${game.id} is vrijgegeven en staat ${game.enabled ? 'aan' : 'uit'}.`,
  };
}

export const adminCommands = [
  {
    path: ['admin', 'login'],
    usage: 'admin login [--server URL] [--token TOKEN]',
    summary: 'Admintoken controleren en opslaan',
    description: 'Vraagt het admintoken (onzichtbare invoer), controleert het bij de server en slaat het op naast je dev key.',
    options: { token: { type: 'string' } },
    optionHelp: [
      ['--server URL', 'Server om op te slaan'],
      ['--token TOKEN', 'Admintoken als argument, voor scripts'],
    ],
    async run(ctx) {
      const { server } = await ctx.settings();
      let token = ctx.flags.token?.trim();
      if (!token) token = await ctx.prompter.askHidden('Plak het admintoken');
      if (!token) throw usageError('Geen admintoken ingevoerd.');
      if (token.length < 32) throw usageError('Een admintoken is minstens 32 tekens lang.');
      try {
        await request(server, '/api/v1/admin/dev-tokens', { token });
      } catch (error) {
        if (error.status === 401) throw new CliError(`${server} accepteert dit admintoken niet.`, { code: error.code, status: 401 });
        throw error;
      }
      const changes = { admin_token: token };
      if (ctx.flags.server) changes.server = server;
      const { path } = await updateConfig(ctx.env, changes);
      return {
        data: { server, admin_token: { masked: maskToken(token) }, config_path: path },
        text: `Admintoken ${maskToken(token)} voor ${server} opgeslagen in ${path}.`,
      };
    },
  },
  {
    path: ['admin', 'logout'],
    usage: 'admin logout',
    summary: 'Opgeslagen admintoken vergeten',
    async run(ctx) {
      const settings = await ctx.settings();
      const removed = Boolean(settings.config.admin_token);
      if (removed) await updateConfig(ctx.env, { admin_token: null });
      return { data: { removed, config_path: settings.path }, text: removed ? `Admintoken verwijderd uit ${settings.path}.` : 'Er was geen admintoken opgeslagen.' };
    },
  },
  {
    path: ['admin', 'token', 'create'],
    usage: 'admin token create <gebruikersnaam> [--label TEKST] [--expires DAGEN]',
    summary: 'Dev key maken voor een account',
    description: 'Het account moet al bestaan. De sleutel wordt één keer getoond; geef hem via een veilig kanaal door.',
    options: { label: { type: 'string' }, expires: { type: 'string' } },
    optionHelp: [
      ['--label TEKST', 'Waar de sleutel voor is (standaard "cli", maximaal 80 tekens)'],
      ['--expires DAGEN', 'Verloopt na zoveel dagen (1-3650; standaard nooit)'],
    ],
    args: [1, 1],
    examples: ['me admin token create sander --label laptop --expires 90'],
    async run(ctx) {
      const body = { username: ctx.args[0] };
      if (ctx.flags.label !== undefined) {
        if (ctx.flags.label.length > 80) throw usageError('--label mag maximaal 80 tekens zijn.');
        body.label = ctx.flags.label;
      }
      const days = parseDays(ctx.flags.expires);
      if (days !== undefined) body.expires_in_days = days;
      const created = await ctx.admin('/dev-tokens', { method: 'POST', body });
      return {
        data: created,
        text: [
          `Dev key gemaakt voor @${created.username} (label ${created.label}, ${created.expires_at ? `verloopt ${formatDate(created.expires_at)}` : 'verloopt nooit'}).`,
          '',
          `  ${created.token}`,
          '',
          'Deze sleutel wordt maar één keer getoond. Geef hem via een veilig kanaal door;',
          'de ontwikkelaar logt in met: me auth',
        ].join('\n'),
      };
    },
  },
  {
    path: ['admin', 'token', 'list'],
    usage: 'admin token list',
    summary: 'Alle dev keys',
    async run(ctx) {
      const { tokens } = await ctx.admin('/dev-tokens');
      const text = tokens.length
        ? table(
            ['ID', 'ACCOUNT', 'LABEL', 'GEMAAKT', 'VERLOOPT', 'LAATST GEBRUIKT', 'STATUS'],
            tokens.map(token => [token.id, token.username, token.label, formatDate(token.created_at), token.expires_at ? formatDate(token.expires_at) : 'nooit', formatDate(token.last_used_at), tokenState(token)]),
          )
        : 'Er zijn nog geen dev keys. Maak er een met: me admin token create <gebruikersnaam>';
      return { data: { tokens }, text };
    },
  },
  {
    path: ['admin', 'token', 'revoke'],
    usage: 'admin token revoke <id>',
    summary: 'Dev key intrekken; werkt direct',
    args: [1, 1],
    async run(ctx) {
      const [id] = ctx.args;
      await ctx.admin(`/dev-tokens/${enc(id)}`, { method: 'DELETE' });
      return { data: { id, revoked: true }, text: `Dev key ${id} ingetrokken. Hij werkt niet meer.` };
    },
  },
  {
    path: ['admin', 'games'],
    usage: 'admin games',
    summary: 'Alle geüploade games met eigenaar',
    async run(ctx) {
      const { games } = await ctx.admin('/games');
      const text = games.length
        ? table(
            ['ID', 'EIGENAAR', 'ACTIEF', 'STATUS', 'VERSIES'],
            games.map(game => [game.id, ownerName(game.owner), game.active_version ?? '-', gameStatus(game), game.versions?.length ?? 0]),
          )
        : 'Er zijn nog geen geüploade games.';
      return { data: { games }, text };
    },
  },
  {
    path: ['admin', 'game', 'block'],
    usage: 'admin game block <id>',
    summary: 'Noodstop: niets van de game wordt nog geserveerd, ook niet aan lopende rooms',
    args: [1, 1],
    run: ctx => setBlocked(ctx, true),
  },
  {
    path: ['admin', 'game', 'unblock'],
    usage: 'admin game unblock <id>',
    summary: 'Blokkade opheffen en de game weer aanzetten',
    args: [1, 1],
    run: ctx => setBlocked(ctx, false),
  },
];
