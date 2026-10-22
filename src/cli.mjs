import { parseArgs } from 'node:util';
import { request } from './api.mjs';
import { resolveSettings } from './config.mjs';
import { CliError, usageError } from './errors.mjs';
import { terminalSafe } from './format.mjs';
import { createPrompter } from './prompt.mjs';
import { PACKAGE, vendorInfo } from './vendor.mjs';
import { adminCommands, adminGroups } from './commands/admin.mjs';
import { authCommands, authGroups } from './commands/auth.mjs';
import { devCommands } from './commands/dev.mjs';
import { gameCommands, gameGroups } from './commands/game.mjs';
import { setupCommands } from './commands/setup.mjs';
import { skillCommands, skillGroups } from './commands/skill.mjs';

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  server: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const GLOBAL_HELP = [
  ['--json', 'Uitvoer als JSON (voor scripts)'],
  ['--server URL', 'Andere server voor dit commando'],
  ['-h, --help', 'Help bij een commando'],
];

export const COMMANDS = [...setupCommands, ...authCommands, ...gameCommands, ...devCommands, ...skillCommands, ...adminCommands];
const GROUPS = [...authGroups, ...gameGroups, ...skillGroups, ...adminGroups];

const SECTIONS = [
  ['Begin hier', ['setup']],
  ['Inloggen', ['auth']],
  ['Games', ['game']],
  ['Lokaal testen', ['dev']],
  ['AI-skills', ['skill']],
  ['Beheer (alleen de eigenaar van de server)', ['admin']],
];

const ALL_OPTIONS = Object.assign({}, GLOBAL_OPTIONS, ...COMMANDS.map(command => command.options ?? {}));
const key = path => path.join(' ');

function optionLines(rows) {
  const width = Math.max(...rows.map(([flag]) => flag.length));
  return rows.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`);
}

const brief = command => command.usage.replace(/\s*\[(?:-|opties)[^\]]*\]/g, '');

function commandLines(commands, width = Math.max(...commands.map(command => brief(command).length))) {
  return commands.map(command => `  ${brief(command).padEnd(width)}  ${command.summary}`);
}

function topHelp() {
  const lines = [`Mini Engine CLI ${PACKAGE.version}`, '', 'Upload en beheer je eigen games op een Mini Engine-server.', '', 'Gebruik: me <commando> [opties]'];
  const width = Math.max(...COMMANDS.map(command => brief(command).length));
  for (const [title, roots] of SECTIONS) {
    const commands = COMMANDS.filter(command => roots.includes(command.path[0]));
    lines.push('', title, ...commandLines(commands, width));
  }
  lines.push('', 'Algemene opties', ...optionLines([...GLOBAL_HELP, ['-v, --version', 'Versie tonen']]));
  lines.push('', 'Meer uitleg per commando: me <commando> --help', 'Instellingen: ~/.config/miniengine/config.json, of MINIENGINE_SERVER, MINIENGINE_TOKEN en MINIENGINE_ADMIN_TOKEN.');
  return lines.join('\n');
}

function groupHelp(group) {
  const commands = COMMANDS.filter(command => key(command.path).startsWith(`${key(group.path)} `) || key(command.path) === key(group.path));
  const lines = [group.summary, '', `Gebruik: me ${key(group.path)} <commando> [opties]`, '', 'Commando’s', ...commandLines(commands)];
  if (group.description) lines.push('', group.description);
  lines.push('', `Meer uitleg: me ${key(group.path)} <commando> --help`);
  return lines.join('\n');
}

function commandHelp(command) {
  const lines = [command.summary, '', `Gebruik: me ${command.usage}`];
  if (command.description) lines.push('', command.description);
  if (command.optionHelp?.length) lines.push('', 'Opties', ...optionLines(command.optionHelp));
  const own = new Set((command.optionHelp ?? []).map(([flag]) => flag.split(' ')[0]));
  lines.push('', 'Algemene opties', ...optionLines(GLOBAL_HELP.filter(([flag]) => !own.has(flag.split(' ')[0]))));
  if (command.examples?.length) lines.push('', 'Voorbeelden', ...command.examples.map(example => `  ${example}`));
  const children = COMMANDS.filter(other => other !== command && key(other.path).startsWith(`${key(command.path)} `));
  if (children.length) lines.push('', 'Zie ook', ...commandLines(children));
  return lines.join('\n');
}

function match(positionals) {
  let best;
  for (const command of COMMANDS) {
    if (command.path.length <= positionals.length && command.path.every((part, index) => positionals[index] === part)) {
      if (!best || command.path.length > best.path.length) best = command;
    }
  }
  return best;
}

function matchGroup(positionals) {
  let best;
  for (const group of GROUPS) {
    if (group.path.length <= positionals.length && group.path.every((part, index) => positionals[index] === part)) {
      if (!best || group.path.length > best.path.length) best = group;
    }
  }
  return best;
}

function translateParseError(error, helpCommand) {
  const option = /'(-[^' ]+)/.exec(error.message)?.[1];
  const hint = `Zie: me ${helpCommand} --help`;
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return usageError(`Onbekende optie: ${option ?? error.message}`, hint);
  if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return usageError(`Optie ${option ?? ''} verwacht een waarde.`.replace('  ', ' '), hint);
  if (error.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return usageError('Te veel argumenten.', hint);
  return usageError(error.message, hint);
}

function makeContext(io, values, args) {
  const { env, stdout, stderr } = io;
  let settings;
  let prompter;
  const ctx = {
    ...io,
    flags: values,
    args,
    json: Boolean(values.json),
    async settings() {
      settings ??= await resolveSettings(env, { server: values.server });
      return settings;
    },
    get prompter() {
      prompter ??= createPrompter(io);
      return prompter;
    },
    closePrompter() {
      prompter?.close();
    },
    info(text) {
      if (!ctx.json) stdout.write(`${terminalSafe(text)}\n`);
    },
    warn(text) {
      stderr.write(`${terminalSafe(text)}\n`);
    },
    async dev(path, options = {}) {
      const { server, token } = await ctx.settings();
      if (!token) throw new CliError(`Niet ingelogd op ${server}.`, { code: 'not_logged_in', hint: 'Log in met: me auth' });
      try {
        return await request(server, `/api/v1/dev${path}`, { ...options, token });
      } catch (error) {
        if (error.status === 401) error.hint ??= 'Je dev key is ongeldig, verlopen of ingetrokken. Log opnieuw in met: me auth';
        throw error;
      }
    },
    async admin(path, options = {}) {
      const { server, adminToken } = await ctx.settings();
      if (!adminToken) throw new CliError('Geen admintoken ingesteld.', { code: 'not_logged_in', hint: 'Log in met: me admin login' });
      try {
        return await request(server, `/api/v1/admin${path}`, { ...options, token: adminToken });
      } catch (error) {
        if (error.status === 401) error.hint ??= 'Het admintoken klopt niet. Log opnieuw in met: me admin login';
        throw error;
      }
    },
    async confirm(question) {
      if (values.yes) return true;
      if (!io.stdin.isTTY) throw usageError('Bevestiging nodig, maar er is geen terminal.', 'Voeg --yes toe om zonder vragen door te gaan.');
      return ctx.prompter.confirm(question, false);
    },
  };
  return ctx;
}

export async function main(argv, io) {
  const { stdout, stderr } = io;
  const wantsJson = argv.includes('--json');
  let ctx;
  try {
    let loose;
    try {
      loose = parseArgs({ args: argv, options: ALL_OPTIONS, strict: false, allowPositionals: true });
    } catch (error) {
      throw translateParseError(error, '');
    }
    let positionals = loose.positionals;
    let forceHelp = false;
    if (positionals[0] === 'help') {
      positionals = positionals.slice(1);
      forceHelp = true;
    }
    if (loose.values.version && !positionals.length) {
      const sdk = vendorInfo();
      if (wantsJson) stdout.write(`${JSON.stringify({ version: PACKAGE.version, sdk: sdk?.version ?? null })}\n`);
      else stdout.write(`${PACKAGE.version}\n`);
      return 0;
    }
    if (!positionals.length) {
      stdout.write(`${topHelp()}\n`);
      return 0;
    }
    const command = match(positionals);
    const group = matchGroup(positionals);
    const helpWanted = forceHelp || loose.values.help === true;
    if (group && (!command || group.path.length > command.path.length)) {
      if (positionals.length > group.path.length) {
        throw usageError(`Onbekend commando: me ${positionals.join(' ')}`, `Zie: me ${key(group.path)} --help`);
      }
      stdout.write(`${groupHelp(group)}\n`);
      return 0;
    }
    if (!command) throw usageError(`Onbekend commando: me ${positionals.join(' ')}`, 'Zie: me --help');
    if (helpWanted) {
      stdout.write(`${commandHelp(command)}\n`);
      return 0;
    }
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) }, strict: true, allowPositionals: true });
    } catch (error) {
      throw translateParseError(error, key(command.path));
    }
    const args = parsed.positionals.slice(command.path.length);
    const [min, max] = command.args ?? [0, 0];
    if (args.length < min || args.length > max) {
      throw usageError(args.length < min ? 'Er ontbreekt een argument.' : 'Te veel argumenten.', `Gebruik: me ${command.usage}`);
    }
    ctx = makeContext(io, parsed.values, args);
    const result = (await command.run(ctx)) ?? {};
    if (ctx.json) {
      if (!result.silent) stdout.write(`${JSON.stringify(result.data ?? {}, null, 2)}\n`);
    } else if (result.text) stdout.write(`${terminalSafe(result.text)}\n`);
    return result.exitCode ?? 0;
  } catch (error) {
    if (!(error instanceof CliError)) {
      error = new CliError(error?.message ?? String(error), { code: 'internal' });
    }
    if (wantsJson) {
      const payload = { code: error.code, message: error.message };
      if (error.status) payload.status = error.status;
      if (error.hint) payload.hint = error.hint;
      stdout.write(`${JSON.stringify({ error: payload }, null, 2)}\n`);
    } else {
      stderr.write(`Fout: ${terminalSafe(error.message)}\n`);
      if (error.hint) stderr.write(`${terminalSafe(error.hint)}\n`);
    }
    return error.exitCode ?? 1;
  } finally {
    ctx?.closePrompter();
  }
}
