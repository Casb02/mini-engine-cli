import { request } from '../api.mjs';
import { normalizeServer, updateConfig } from '../config.mjs';
import { CliError, usageError } from '../errors.mjs';
import { formatDate, maskToken } from '../format.mjs';

export const DEV_KEY_PATTERN = /^med_[0-9a-f]{64}$/;

export function checkDevKey(token) {
  if (!DEV_KEY_PATTERN.test(token)) {
    throw usageError('Dit is geen geldige dev key.', 'Een dev key begint met med_ gevolgd door 64 tekens 0-9 en a-f.');
  }
}

export async function verifyDevKey(server, token) {
  try {
    return await request(server, '/api/v1/dev/me', { token });
  } catch (error) {
    if (error.status === 401) {
      throw new CliError(`${server} kent deze dev key niet, of hij is verlopen of ingetrokken.`, {
        code: error.code,
        status: 401,
        hint: 'Vraag de beheerder van de server om een nieuwe dev key.',
      });
    }
    throw error;
  }
}

export async function login(ctx, { server, token }) {
  checkDevKey(token);
  const me = await verifyDevKey(server, token);
  const { path } = await updateConfig(ctx.env, { server, token });
  if (ctx.env.MINIENGINE_TOKEN && ctx.env.MINIENGINE_TOKEN.trim() !== token) {
    ctx.warn('Let op: MINIENGINE_TOKEN is gezet en gaat voor op de opgeslagen dev key.');
  }
  if (ctx.env.MINIENGINE_SERVER && normalizeServer(ctx.env.MINIENGINE_SERVER) !== server) {
    ctx.warn('Let op: MINIENGINE_SERVER is gezet en gaat voor op de opgeslagen server.');
  }
  return { me, path };
}

const describeAccount = account => `${account.display_name} (@${account.username})`;

export const authGroups = [];

export const authCommands = [
  {
    path: ['auth'],
    usage: 'auth [--server URL] [--token KEY]',
    summary: 'Dev key opslaan na controle bij de server',
    description:
      'Vraagt je dev key (de invoer blijft onzichtbaar), controleert hem bij de server en slaat hem op.\nEen dev key krijg je van de eigenaar van de server. Zonder terminal wordt één regel van stdin gelezen.',
    options: { token: { type: 'string' } },
    optionHelp: [
      ['--server URL', 'Server om in te loggen en op te slaan (standaard http://localhost:3000)'],
      ['--token KEY', 'Dev key als argument, voor scripts (komt in je shellgeschiedenis)'],
    ],
    examples: ['me auth', 'me auth --server https://games.example.nl', 'printf %s "$KEY" | me auth'],
    async run(ctx) {
      const { server } = await ctx.settings();
      let token = ctx.flags.token?.trim();
      if (!token) {
        if (ctx.stdin.isTTY) ctx.warn(`Server: ${server}`);
        token = await ctx.prompter.askHidden('Plak je dev key');
        if (!token) throw usageError('Geen dev key ingevoerd.');
      }
      const { me, path } = await login(ctx, { server, token });
      return {
        data: { server, account: me.account, token: { ...me.token, masked: maskToken(token) }, config_path: path },
        text: [
          `Ingelogd als ${describeAccount(me.account)} op ${server}.`,
          `Dev key ${maskToken(token)} opgeslagen in ${path}.`,
          me.token?.expires_at ? `De sleutel verloopt op ${formatDate(me.token.expires_at)}.` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  },
  {
    path: ['auth', 'status'],
    usage: 'auth status',
    summary: 'Laat zien met welke account en server je werkt',
    async run(ctx) {
      const settings = await ctx.settings();
      if (!settings.token) throw new CliError(`Niet ingelogd op ${settings.server}.`, { code: 'not_logged_in', hint: 'Log in met: me auth' });
      const me = await ctx.dev('/me');
      const source = { config: settings.path, MINIENGINE_TOKEN: 'MINIENGINE_TOKEN' }[settings.tokenSource] ?? settings.tokenSource;
      const lines = [
        `Server     ${settings.server}${settings.serverSource === 'config' || settings.serverSource === 'standaard' ? '' : ` (${settings.serverSource})`}`,
        `Account    ${describeAccount(me.account)}`,
        `Dev key    ${maskToken(settings.token)}${me.token?.label ? ` · label ${me.token.label}` : ''} · uit ${source}`,
        `Verloopt   ${me.token?.expires_at ? formatDate(me.token.expires_at) : 'nooit'}`,
      ];
      if (settings.adminToken) lines.push(`Admin      token ${maskToken(settings.adminToken)} ingesteld`);
      return {
        data: {
          server: settings.server,
          server_source: settings.serverSource,
          account: me.account,
          token: { ...me.token, masked: maskToken(settings.token), source: settings.tokenSource },
          admin_token: settings.adminToken ? { masked: maskToken(settings.adminToken), source: settings.adminTokenSource } : null,
          config_path: settings.path,
        },
        text: lines.join('\n'),
      };
    },
  },
  {
    path: ['auth', 'logout'],
    usage: 'auth logout',
    summary: 'Opgeslagen dev key vergeten',
    description: 'Haalt de dev key uit het configuratiebestand. De sleutel zelf blijft geldig; vraag de beheerder hem in te trekken als hij gelekt is.',
    async run(ctx) {
      const settings = await ctx.settings();
      const removed = Boolean(settings.config.token);
      if (removed) await updateConfig(ctx.env, { token: null });
      if (ctx.env.MINIENGINE_TOKEN) ctx.warn('Let op: MINIENGINE_TOKEN is nog gezet in je omgeving.');
      return {
        data: { removed, config_path: settings.path },
        text: removed ? `Dev key verwijderd uit ${settings.path}.` : 'Er was geen dev key opgeslagen.',
      };
    },
  },
];
