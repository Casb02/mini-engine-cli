import { randomUUID } from 'node:crypto';
import { unwatchFile, watch, watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, relative, sep } from 'node:path';
import { CliError } from '../errors.mjs';
import { DevEngine } from './engine.mjs';
import { EngineError, notFound } from './errors.mjs';
import { createApp } from './http.mjs';
import { loadPackage } from './package.mjs';
import { validateSetContent } from './schema.mjs';

export const NAMES = ['Dani', 'Sander', 'Kevin', 'Jelmer', 'Hessel', 'Pim'];
export const MAX_PHONES = 8;
const RELOAD_DELAY = 120;

export async function loadSet(path, metadata, id) {
  const name = basename(path);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`Kan ${name} niet lezen.`, { hint: 'Controleer het pad bij --set.' });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${name} is geen geldige JSON: ${error.message}`);
  }
  if (!metadata.set_kinds.length) return { set: null, data, override: true };
  const title = [...name.replace(/\.json$/i, '').trim()].slice(0, 80).join('') || 'Eigen set';
  const problems = [];
  for (const kind of metadata.set_kinds) {
    try {
      validateSetContent(metadata, kind.id, data);
      return { set: { id, kind: kind.id, title }, data, override: false };
    } catch (error) {
      problems.push(`${kind.id}: ${error.message}`);
    }
  }
  if (problems.length === 1) throw new CliError(`${name} past niet bij set-soort ${problems[0]}`);
  throw new CliError(`${name} past bij geen enkele set-soort van deze game:\n  ${problems.join('\n  ')}`);
}

class DevProject {
  constructor(pkg, setFile, chosen, setId) {
    this.pkg = pkg;
    this.setFile = setFile;
    this.setId = setId;
    this.chosen = chosen;
    this.problem = null;
    this.generation = 0;
  }

  static async load(dir, setFile) {
    const pkg = await loadPackage(dir);
    const setId = randomUUID();
    const chosen = setFile ? await loadSet(setFile, pkg.metadata, setId) : null;
    return new DevProject(pkg, setFile, chosen, setId);
  }

  get metadata() {
    return this.pkg.metadata;
  }

  get data() {
    return this.chosen?.override ? this.chosen.data : this.pkg.data;
  }

  get roomSet() {
    return this.chosen && !this.chosen.override ? this.chosen.set : null;
  }

  html(role) {
    return Object.hasOwn(this.pkg.html, role) ? this.pkg.html[role] : undefined;
  }

  asset(path) {
    return this.pkg.assets.get(path);
  }

  chooseSet(id) {
    if (!this.chosen || this.chosen.override || this.chosen.set.id !== id) {
      throw notFound('set_not_found', 'Deze set bestaat niet.');
    }
    return { set: { ...this.chosen.set }, data: structuredClone(this.chosen.data) };
  }

  async reload() {
    const pkg = await loadPackage(this.pkg.dir);
    if (pkg.metadata.id !== this.pkg.metadata.id) {
      throw new CliError(`Het id in manifest.json is veranderd (${this.pkg.metadata.id} → ${pkg.metadata.id}). Start me dev opnieuw.`);
    }
    const chosen = this.setFile ? await loadSet(this.setFile, pkg.metadata, this.setId) : null;
    this.pkg = pkg;
    this.chosen = chosen;
    this.generation += 1;
  }
}

class DevSession {
  constructor({ engine, project, allocate, release = async () => {}, log, notify }) {
    this.engine = engine;
    this.project = project;
    this.allocate = allocate;
    this.release = release;
    this.log = log;
    this.notify = notify;
    this.code = null;
    this.host = null;
    this.display = null;
    this.players = [];
    this.started = false;
  }

  nextName() {
    const used = new Set(this.players.map(seat => seat.name));
    const free = NAMES.find(name => !used.has(name));
    if (free) return free;
    let number = NAMES.length + 1;
    while (used.has(`Speler ${number}`)) number += 1;
    return `Speler ${number}`;
  }

  async start(count) {
    this.host = { port: await this.allocate(), credential: null };
    if (this.project.metadata.has_display) this.display = { port: await this.allocate(), credential: null };
    for (let index = 0; index < count; index += 1) this.players.push({ name: this.nextName(), port: await this.allocate(), credential: null, error: null });
    return this.newRoom();
  }

  async newRoom() {
    if (this.code && this.host?.credential) {
      try {
        this.engine.delete(this.code, this.host.credential.token);
      } catch {
        this.code = null;
      }
    }
    if (this.project.metadata.has_display && !this.display) this.display = { port: await this.allocate(), credential: null };
    for (const seat of this.players.filter(entry => entry.remote)) await this.release(seat.port);
    this.players = this.players.filter(seat => !seat.remote);
    const room = this.project.roomSet;
    const credential = this.engine.createRoom({ game_id: this.project.metadata.id, set_id: room?.id ?? null });
    this.code = credential.code;
    this.host.credential = credential;
    if (this.display) {
      this.display.credential = credential.display_token ? { code: credential.code, token: credential.display_token, role: 'display', player_id: null } : null;
    }
    for (const seat of this.players) {
      try {
        seat.credential = this.engine.join(this.code, seat.name);
        seat.error = null;
      } catch (error) {
        seat.credential = null;
        seat.error = error.message;
      }
    }
    if (this.started) this.log(`Nieuwe kamer ${this.code}.`);
    this.started = true;
    this.notify();
    return this.state();
  }

  async addPlayer() {
    const name = this.nextName();
    const credential = this.engine.join(this.code, name);
    const port = await this.allocate();
    this.players.push({ name, port, credential, error: null });
    this.log(`${name} doet mee (poort ${port}).`);
    this.notify();
    return this.state();
  }

  joinInfo() {
    return { title: this.project.metadata.title, open: Boolean(this.code) };
  }

  async addPhone(wanted) {
    if (this.players.filter(seat => seat.remote).length >= MAX_PHONES) {
      throw new EngineError(409, 'phones_full', `Er doen al ${MAX_PHONES} telefoons mee. Kies Nieuwe kamer in het overzicht om opnieuw te beginnen.`);
    }
    const name = String(wanted ?? '').trim() || this.nextName();
    const credential = this.engine.join(this.code, name);
    const port = await this.allocate({ phone: true });
    this.players.push({ name, port, credential, error: null, remote: true });
    this.log(`${name} doet mee op een ander apparaat (poort ${port}).`);
    this.notify();
    return this.seat(`player-${this.players.length}`, 'player', name, port, credential, false, null, true);
  }

  observe(type, code, extra) {
    if (type === 'award') this.log(`${extra.player} kreeg ${extra.title}`);
    if (code !== this.code) return;
    if (type === 'display-token' && this.display) {
      this.display.credential = { code, token: extra, role: 'display', player_id: null };
    }
    this.notify();
  }

  seat(id, role, label, port, credential, connected, error = null, remote = false) {
    return {
      id,
      role,
      label,
      port,
      remote,
      path: credential ? `/room/${credential.code}/${role}` : null,
      hash: credential ? encodeURIComponent(JSON.stringify(credential)) : null,
      connected,
      error,
    };
  }

  state() {
    const metadata = this.project.metadata;
    const presence = this.code ? this.engine.presence(this.code) : null;
    const seats = [this.seat('host', 'host', 'Spelleider', this.host.port, presence ? this.host.credential : null, Boolean(presence?.host))];
    if (this.display) {
      const credential = presence ? this.display.credential : null;
      seats.push(this.seat('display', 'display', 'Scherm', this.display.port, credential, Boolean(presence?.display), presence && !credential ? 'Deze kamer heeft geen scherm.' : null));
    }
    this.players.forEach((player, index) => {
      const credential = presence ? player.credential : null;
      const id = credential?.player_id;
      const left = credential && presence && !(id in presence.players);
      seats.push(
        this.seat(`player-${index + 1}`, 'player', player.name, player.port, left ? null : credential, Boolean(id && presence?.players[id]), left ? 'Deze speler zit niet meer in de kamer.' : player.error, Boolean(player.remote)),
      );
    });
    return {
      game: { id: metadata.id, title: metadata.title, version: metadata.version, has_display: metadata.has_display, max_players: metadata.max_players },
      problem: this.project.problem,
      generation: this.project.generation,
      set: this.project.roomSet,
      room: presence ? { code: this.code, status: presence.status, version: presence.version } : null,
      join: this.joinUrl ?? null,
      seats,
    };
  }
}

/** This computer's IPv4 addresses on the local network: Wi-Fi and ethernet first, virtual bridges last. */
export function lanAddresses() {
  const rank = (name, address) => (/^(en|eth|wl)/.test(name) ? 0 : 2) + (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 0 : 1);
  const found = Object.entries(networkInterfaces())
    .flatMap(([name, entries]) => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => ({ address: entry.address, rank: rank(name, entry.address) })))
    .sort((a, b) => a.rank - b.rank);
  return [...new Set(found.map(entry => entry.address))];
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      resolve(server.address().port);
    });
  });
}

export async function startDev({ dir, port = 3170, players = 2, setFile = null, lan = false, log = () => {}, warn = () => {} }) {
  const project = await DevProject.load(dir, setFile);
  const servers = [];
  let launcherPort = null;
  let session = null;
  let pending = null;
  const lanHosts = lan ? lanAddresses() : [];
  const byPort = new Map();
  const phonePorts = new Set();
  let joinPort = null;
  const engine = new DevEngine({ game: project, observe: (type, code, extra) => session?.observe(type, code, extra) });
  const app = createApp({ engine, project, session: () => session, launcherPort: () => launcherPort, lanHosts, joinPort: () => joinPort, phonePorts: () => phonePorts });
  const notify = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      if (session) app.broadcast('state', session.state());
    }, 30);
  };

  // The overview and the seats on this computer listen on 127.0.0.1 only; with --lan the join page and the phones' seats also on the network.
  const open = async (wanted, network = false) => {
    const server = createServer(app.request);
    server.on('upgrade', app.upgrade);
    const bound = await listenOn(server, wanted, network ? '0.0.0.0' : '127.0.0.1');
    servers.push(server);
    byPort.set(bound, server);
    return bound;
  };

  try {
    launcherPort = await open(port);
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new CliError(`Poort ${port} is al in gebruik.`, { hint: 'Kies een andere poort met --port.' });
    throw error;
  }

  let last = launcherPort;
  const allocate = async ({ phone = false } = {}) => {
    const take = bound => {
      if (phone) phonePorts.add(bound);
      return bound;
    };
    if (port === 0) return take(await open(0, phone));
    for (let candidate = last + 1; candidate <= Math.min(last + 200, 65535); candidate += 1) {
      try {
        last = await open(candidate, phone);
        return take(last);
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new CliError(`Geen vrije poort gevonden na ${last}.`, { hint: 'Kies een andere poort met --port.' });
  };
  const release = async freed => {
    const server = byPort.get(freed);
    if (!server) return;
    byPort.delete(freed);
    phonePorts.delete(freed);
    servers.splice(servers.indexOf(server), 1);
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  if (lan) {
    let candidate = launcherPort;
    for (;;) {
      candidate = port === 0 ? 0 : candidate + 1;
      try {
        joinPort = await open(candidate, true);
        last = Math.max(last, joinPort);
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || candidate >= 65535) throw error;
      }
    }
  }

  session = new DevSession({ engine, project, allocate, release, log, notify });
  const lanUrl = lan && lanHosts.length ? `http://${lanHosts[0]}:${joinPort}/join` : null;
  session.joinUrl = lanUrl;
  try {
    await session.start(Math.min(players, project.metadata.max_players));
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }

  let timer = null;
  let reloading = null;
  const changed = new Set();
  const reload = async () => {
    const files = [...changed].filter(Boolean).sort();
    changed.clear();
    const before = project.problem;
    try {
      await project.reload();
      project.problem = null;
      if (before) log('De game is weer in orde.');
      log(files.length ? `Herladen na wijziging in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` en ${files.length - 3} meer` : ''}.` : 'Herladen.');
    } catch (error) {
      const text = error.hint ? `${error.message}\n${error.hint}` : error.message;
      if (text !== before) warn(`Fout in de game: ${text}`);
      project.problem = text;
    }
    notify();
  };
  const schedule = file => {
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      reloading = (reloading ?? Promise.resolve()).then(reload);
    }, RELOAD_DELAY);
  };

  let watcher = null;
  try {
    watcher = watch(dir, { recursive: true }, (_, name) => {
      const file = name ? String(name).split(sep).join('/') : '';
      if (file && file.split('/').some(part => part.startsWith('.') || part === 'node_modules')) return;
      schedule(file);
    });
    watcher.on('error', () => {});
  } catch {
    warn('Wijzigingen volgen lukt hier niet; herlaad de stoelen zelf.');
  }
  if (setFile) watchFile(setFile, { interval: 500 }, () => schedule(relative(dir, setFile).split(sep).join('/')));

  const url = `http://127.0.0.1:${launcherPort}`;
  return {
    url,
    lanUrl,
    joinPort,
    phonePorts,
    openPorts: () => [...byPort.keys()],
    project,
    session,
    engine,
    async close() {
      watcher?.close();
      if (setFile) unwatchFile(setFile);
      clearTimeout(timer);
      clearTimeout(pending);
      await reloading;
      engine.close('server_shutdown');
      await new Promise(resolve => setTimeout(resolve, 50));
      app.shutdown();
      await Promise.all(
        servers.map(
          server =>
            new Promise(resolve => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
