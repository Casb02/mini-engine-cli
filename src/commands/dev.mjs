import { spawn } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { usageError } from '../errors.mjs';
import { startDev } from '../dev/server.mjs';

export function parseNumber(value, name, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw usageError(`${name} moet een geheel getal van 0 tot ${max} zijn.`);
  return Number(value);
}

export function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    return false;
  }
  return true;
}

function waitForStop() {
  return new Promise(resolve => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/** Starts me dev on a game folder and keeps it running until Ctrl+C. */
export async function runDev(ctx, dir, { port = 3170, players = 2, setFile = null, open = true, lan = false } = {}) {
  const log = text => (ctx.json ? ctx.warn(text) : ctx.info(text));
  const dev = await startDev({ dir, port, players, setFile, lan, log, warn: text => ctx.warn(text) });
  const stopped = waitForStop();
  const state = dev.session.state();
  const { game } = state;
  if (ctx.json) {
    const seats = state.seats.map(seat => ({ role: seat.role, name: seat.label, port: seat.port }));
    ctx.stdout.write(`${JSON.stringify({ url: dev.url, lan_url: dev.lanUrl, game, room: state.room?.code ?? null, seats }, null, 2)}\n`);
  } else {
    const shown = relative(ctx.cwd, dir) || '.';
    const names = state.seats.filter(seat => seat.role === 'player').map(seat => seat.label);
    const who = ['spelleider', ...(game.has_display ? ['scherm'] : []), `${names.length} ${names.length === 1 ? 'speler' : 'spelers'}${names.length ? ` (${names.join(', ')})` : ''}`];
    const phones = lan
      ? dev.lanUrl
        ? [`Telefoons op hetzelfde wifi: ${dev.lanUrl}`, 'Iedereen op dit netwerk kan meedoen; gebruik --lan alleen op een netwerk dat je vertrouwt.']
        : ['Geen netwerkadres gevonden; telefoons kunnen niet meedoen.']
      : [];
    ctx.info(
      [
        `${game.title} ${game.version} draait lokaal.`,
        `Overzicht: ${dev.url}`,
        ...phones,
        `Kamer ${state.room?.code ?? '-'} met ${who.join(', ')}.`,
        ...(state.set ? [`Set: ${state.set.title} (${state.set.kind})`] : []),
        `Wijzigingen in ${shown} laden de stoelen opnieuw. Stoppen: Ctrl+C`,
      ].join('\n'),
    );
  }
  if (open) openBrowser(dev.url);
  await stopped;
  await dev.close();
  return { silent: ctx.json, data: {}, text: 'Gestopt.' };
}

export const devCommands = [
  {
    path: ['dev'],
    usage: 'dev [map] [--port 3170] [--players 2] [--set bestand.json] [--lan] [--no-open]',
    summary: 'Game lokaal testen met een nagebootste engine',
    description: [
      'Start een lokale server die de engine nabootst voor games met runtime "host": rooms, spelers, klaar zijn,',
      'state met versies, acties, realtime, achievements en game-data. Je krijgt een overzicht met de spelleider,',
      'het scherm en de spelers naast elkaar. Elke stoel draait op een eigen poort, net als een eigen apparaat.',
      '',
      'manifest.json wordt eerst gecontroleerd zoals bij me game upload. Wijzig je iets in de map, dan laden de',
      'stoelen opnieuw; de kamer blijft bestaan. Alles staat alleen in het geheugen. Stoppen: Ctrl+C.',
      '',
      'Iedere speler telt als speler met een account, zodat je achievements kunt testen. Gekregen achievements',
      'verschijnen in de terminal.',
      '',
      'Standaard luistert me dev alleen op deze computer (127.0.0.1). Met --lan doen telefoons op hetzelfde wifi mee:',
      'ze openen het adres dat me dev toont en kiezen een naam (hoogstens 8 telefoons). Alleen die aanmeldpagina en de',
      'stoelen van de telefoons staan op het netwerk; het overzicht en de andere stoelen blijven op deze computer.',
    ].join('\n'),
    options: { port: { type: 'string' }, players: { type: 'string' }, set: { type: 'string' }, lan: { type: 'boolean' }, 'no-open': { type: 'boolean' } },
    optionHelp: [
      ['--port POORT', 'Poort van het overzicht (standaard 3170); de stoelen krijgen de poorten erna. 0 kiest vrije poorten'],
      ['--players N', 'Aantal spelers bij de start (standaard 2)'],
      ['--set BESTAND', 'JSON-bestand dat de game krijgt in plaats van data.json, gecontroleerd als eigen set'],
      ['--lan', 'Ook luisteren op het netwerk, zodat telefoons op hetzelfde wifi meedoen'],
      ['--no-open', 'Geen browser openen'],
    ],
    args: [0, 1],
    examples: ['me dev', 'me dev ./ja-of-nee --players 4', 'me dev --set sets/filmavond.json --no-open', 'me dev --lan'],
    async run(ctx) {
      const dir = resolve(ctx.cwd, ctx.args[0] ?? '.');
      const port = parseNumber(ctx.flags.port, '--port', 3170, 65535);
      const players = parseNumber(ctx.flags.players, '--players', 2, 100);
      const setFile = ctx.flags.set ? resolve(ctx.cwd, ctx.flags.set) : null;
      return runDev(ctx, dir, { port, players, setFile, open: !ctx.flags['no-open'], lan: Boolean(ctx.flags.lan) });
    },
  },
];
