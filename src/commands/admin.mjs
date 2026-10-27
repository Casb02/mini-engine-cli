import { enc, request } from '../api.mjs';
import { updateConfig } from '../config.mjs';
import { CliError, usageError } from '../errors.mjs';
import { formatDate, gameStatus, maskToken, privateCell, table } from '../format.mjs';

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

function parseLimit(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw usageError('<aantal> moet een heel getal van 1 tot 100 zijn.');
  return Number(value);
}

const MAX_MEDIA_MB = 1048576;
const MiB = 1024 * 1024;

function parseMediaLimit(value) {
  if (/^standaard$/i.test(value)) return null;
  if (!/^\d+$/.test(value) || Number(value) > MAX_MEDIA_MB) throw usageError(`<MB> moet een heel aantal MB van 0 tot ${MAX_MEDIA_MB} zijn, of "standaard" voor wat de rol geeft.`);
  return Number(value);
}

function parseGrant(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_MEDIA_MB) throw usageError(`<MB> moet een heel aantal MB van 1 tot ${MAX_MEDIA_MB} zijn.`);
  return Number(value);
}

function parseRequestId(value) {
  if (!/^\d+$/.test(value)) throw usageError('<id> is het nummer van de aanvraag uit: me admin media requests');
  return value;
}

// Bytes in use as MB: one decimal below 100 MB (at least 0,1 when anything is used), whole numbers above.
function usedMb(bytes = 0) {
  const mb = bytes / MiB;
  if (mb >= 100) return String(Math.round(mb));
  return (mb > 0 ? Math.max(mb, 0.1) : 0).toFixed(1).replace(/\.0$/, '').replace('.', ',');
}

const mediaSpace = item => `${usedMb(item.media_used)} van ${item.media_limit_mb ?? '?'} MB`;

export const adminGroups = [
  { path: ['admin'], summary: 'Beheer voor de eigenaar van de server (admintoken nodig)', description: 'Het admintoken is MINI_ENGINE_ADMIN_TOKEN van de server. Bewaar het met: me admin login' },
  { path: ['admin', 'token'], summary: 'Dev keys van ontwikkelaars beheren' },
  { path: ['admin', 'game'], summary: 'Games van ontwikkelaars blokkeren of vrijgeven' },
  { path: ['admin', 'account'], summary: 'Accounts bevestigen, beheerder maken en de gamelimiet of ruimte voor afbeeldingen aanpassen' },
  { path: ['admin', 'media'], summary: 'Aanvragen voor ruimte voor afbeeldingen toekennen of afwijzen' },
];

async function setAdmin(ctx, admin) {
  const [username] = ctx.args;
  const account = await ctx.admin(`/accounts/${enc(username)}/admin`, { method: 'PUT', body: { admin } });
  return {
    data: account,
    text: admin
      ? `@${account.username} is nu beheerder. Op de site kan die alle games blokkeren of vrijgeven, games uitlichten en de gamelimiet per gebruiker aanpassen.`
      : `@${account.username} is geen beheerder meer.`,
  };
}

async function setBlocked(ctx, blocked) {
  const [id] = ctx.args;
  const game = await ctx.admin(`/games/${enc(id)}`, { method: 'PUT', body: { enabled: !blocked } });
  return {
    data: game,
    text: blocked ? `${game.id} is geblokkeerd. Er wordt niets meer van geserveerd, ook niet aan lopende rooms, en de eigenaar kan hem niet zelf weer aanzetten.` : `${game.id} is vrijgegeven en staat ${game.enabled ? 'aan' : 'uit'}.`,
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
    path: ['admin', 'account', 'verify'],
    usage: 'admin account verify <gebruikersnaam>',
    summary: 'E-mailadres van een account handmatig bevestigen',
    description: 'Voor wie de bevestigingsmail niet krijgt. Een dev key kan alleen worden gemaakt voor een account met een bevestigd e-mailadres.',
    args: [1, 1],
    async run(ctx) {
      const [username] = ctx.args;
      const result = await ctx.admin(`/accounts/${enc(username)}/verify-email`, { method: 'POST' });
      return { data: result, text: `E-mailadres van ${result.username} (${result.email}) is bevestigd.` };
    },
  },
  {
    path: ['admin', 'account', 'promote'],
    usage: 'admin account promote <gebruikersnaam>',
    summary: 'Account beheerder maken op de site',
    description: 'Een beheerder kan op de site alle games blokkeren of vrijgeven, games uitlichten en de gamelimiet per gebruiker aanpassen. Beheerders maken of weghalen kan alleen met het admintoken.',
    args: [1, 1],
    run: ctx => setAdmin(ctx, true),
  },
  {
    path: ['admin', 'account', 'demote'],
    usage: 'admin account demote <gebruikersnaam>',
    summary: 'Beheerder weer een gewoon account maken',
    args: [1, 1],
    run: ctx => setAdmin(ctx, false),
  },
  {
    path: ['admin', 'account', 'limit'],
    usage: 'admin account limit <gebruikersnaam> <aantal>',
    summary: 'Hoeveel games een account mag uploaden (1-100)',
    description: 'Games die er al staan blijven staan, ook als het account er dan meer heeft dan de nieuwe limiet.',
    args: [2, 2],
    examples: ['me admin account limit sander 25'],
    async run(ctx) {
      const [username, value] = ctx.args;
      const limit = parseLimit(value);
      const account = await ctx.admin(`/accounts/${enc(username)}/game-limit`, { method: 'PUT', body: { game_limit: limit } });
      return { data: account, text: `@${account.username} mag nu ${account.game_limit} games uploaden (heeft er ${account.games}).` };
    },
  },
  {
    path: ['admin', 'account', 'media'],
    usage: 'admin account media <gebruikersnaam> <MB|standaard>',
    summary: 'Hoeveel ruimte voor afbeeldingen een account heeft (0-1048576 MB)',
    description: [
      'Zonder eigen keuze geeft de rol de ruimte: een beheerder 1024 MB, een account met een werkende dev key 250 MB, ieder ander 0. Met "standaard" geldt dat weer.',
      'Minder geven dan het account gebruikt mag: wat er staat blijft staan en werkt in sets, alleen nieuwe uploads worden geweigerd. Meer dan 0 kent ook een open aanvraag van het account toe.',
    ].join('\n\n'),
    args: [2, 2],
    examples: ['me admin account media sander 500', 'me admin account media sander standaard'],
    async run(ctx) {
      const [username, value] = ctx.args;
      const mb = parseMediaLimit(value);
      const account = await ctx.admin(`/accounts/${enc(username)}/media-limit`, { method: 'PUT', body: { media_limit_mb: mb } });
      const space = `${account.media_limit_mb} MB voor afbeeldingen (gebruikt ${usedMb(account.media_used)} MB).`;
      const over = account.media_used > account.media_limit_mb * MiB ? ' Wat er staat blijft staan; nieuwe uploads worden geweigerd.' : '';
      return { data: account, text: `@${account.username} heeft ${mb === null ? 'weer de ruimte van de rol: ' : 'nu '}${space}${over}` };
    },
  },
  {
    path: ['admin', 'accounts'],
    usage: 'admin accounts [zoekterm]',
    summary: 'Accounts met beheerder, games, gamelimiet en ruimte voor afbeeldingen',
    description: 'Hoogstens 50, op gebruikersnaam. De zoekterm zoekt in gebruikersnaam en naam.',
    args: [0, 1],
    async run(ctx) {
      const [query] = ctx.args;
      const { accounts } = await ctx.admin(query ? `/accounts?q=${encodeURIComponent(query)}` : '/accounts');
      const text = accounts.length
        ? table(
            ['GEBRUIKER', 'NAAM', 'BEHEERDER', 'GAMES', 'AFBEELDINGEN', 'E-MAIL'],
            accounts.map(account => [account.username, account.display_name, account.admin ? 'ja' : '–', `${account.games} van ${account.game_limit}`, mediaSpace(account), account.email_verified ? 'bevestigd' : '–']),
          )
        : query ? `Geen accounts gevonden voor "${query}".` : 'Er zijn nog geen accounts.';
      return { data: { accounts }, text };
    },
  },
  {
    path: ['admin', 'media', 'requests'],
    usage: 'admin media requests',
    summary: 'Open aanvragen voor ruimte voor afbeeldingen, oudste eerst',
    description: 'Een speler vraagt ruimte aan op de set-pagina van de site. AFBEELDINGEN is wat het account nu gebruikt van de ruimte die het heeft.',
    async run(ctx) {
      const { requests } = await ctx.admin('/media-requests');
      const text = requests.length
        ? [
            table(
              ['ID', 'GEBRUIKER', 'NAAM', 'AANGEVRAAGD', 'AFBEELDINGEN', 'BERICHT'],
              requests.map(r => [String(r.id), r.username, r.display_name, formatDate(r.requested_at), mediaSpace(r), String(r.message ?? '').replace(/\s+/g, ' ').trim() || '-']),
            ),
            '',
            'Ken toe met: me admin media grant <id> <MB>',
            'Wijs af met: me admin media reject <id>',
          ].join('\n')
        : 'Er zijn geen open aanvragen voor ruimte voor afbeeldingen.';
      return { data: { requests }, text };
    },
  },
  {
    path: ['admin', 'media', 'grant'],
    usage: 'admin media grant <id> <MB>',
    summary: 'Aanvraag toekennen met zoveel ruimte (1-1048576 MB)',
    description: 'Het account krijgt precies deze ruimte, ook als dat minder is dan het al had.',
    args: [2, 2],
    examples: ['me admin media grant 4 500'],
    async run(ctx) {
      const id = parseRequestId(ctx.args[0]);
      const mb = parseGrant(ctx.args[1]);
      const result = await ctx.admin(`/media-requests/${enc(id)}`, { method: 'POST', body: { decision: 'grant', media_limit_mb: mb } });
      return { data: result, text: `Aanvraag ${id} toegekend: @${result.account.username} heeft nu ${result.account.media_limit_mb} MB voor afbeeldingen.` };
    },
  },
  {
    path: ['admin', 'media', 'reject'],
    usage: 'admin media reject <id>',
    summary: 'Aanvraag afwijzen; de ruimte blijft zoals ze was',
    args: [1, 1],
    async run(ctx) {
      const id = parseRequestId(ctx.args[0]);
      const result = await ctx.admin(`/media-requests/${enc(id)}`, { method: 'POST', body: { decision: 'reject' } });
      return { data: result, text: `Aanvraag ${id} afgewezen. @${result.account.username} houdt ${result.account.media_limit_mb} MB voor afbeeldingen.` };
    },
  },
  {
    path: ['admin', 'games'],
    usage: 'admin games',
    summary: 'Alle geüploade games met eigenaar',
    description: 'PRIVÉ is ja voor een game die alleen de eigenaar en wie die uitnodigt kunnen starten (vanaf Mini Engine 0.9). Ook een privégame kun je blokkeren.',
    async run(ctx) {
      const { games } = await ctx.admin('/games');
      const text = games.length
        ? table(
            ['ID', 'EIGENAAR', 'ACTIEF', 'STATUS', 'PRIVÉ', 'VERSIES'],
            games.map(game => [game.id, ownerName(game.owner), game.active_version ?? '-', gameStatus(game), privateCell(game), game.versions?.length ?? 0]),
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
