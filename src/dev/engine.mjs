import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { bad, conflict, EngineError, forbidden, gameNotFound, missing, unauthorized } from './errors.mjs';
import { isObject, jsonBytes, stringify } from './json.mjs';
import { createPeer, Realtime } from './realtime.mjs';
import { charCount, hasControl, validateSetContent, validateSettings } from './schema.mjs';

export const MAX_STATE_BYTES = 64 * 1024;
export const AWARDS_PER_MINUTE = 30;
const MAX_ROOMS = 500;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MODES = ['moderator', 'playing', 'hostless'];

const now = () => Math.floor(Date.now() / 1000);
const newToken = () => randomBytes(32).toString('hex');
const hash = token => createHash('sha256').update(token).digest('hex');

export function roomCode(input) {
  const code = String(input).trim().replace(/[a-z]/g, letter => letter.toUpperCase());
  if (!/^[A-Z]{6}$/.test(code)) throw missing();
  return code;
}

function validateName(name) {
  if (!name || charCount(name) > 24 || hasControl(name)) throw bad('Gebruik een naam van 1–24 tekens zonder controletekens.');
}

function identifies(room, key) {
  return key === room.host_hash || (key === room.display_hash && room.config.display_enabled) || room.players.some(player => player.token_hash === key);
}

function identify(room, token) {
  if (typeof token !== 'string' || Buffer.byteLength(token) !== 64) throw unauthorized();
  const key = hash(token);
  if (key === room.host_hash) return { role: 'host', player_id: room.host_player_id ?? null, key };
  if (key === room.display_hash && room.config.display_enabled) return { role: 'display', player_id: null, key };
  const player = room.players.find(item => item.token_hash === key);
  if (!player) throw unauthorized();
  return { role: 'player', player_id: player.id, key };
}

function requireHost(identity) {
  if (identity.role !== 'host') throw forbidden();
}

function checkVersion(room, expected) {
  if (room.version !== expected) throw conflict('version_conflict', 'De state is intussen gewijzigd. Gebruik de nieuwste versie.');
}

export function parseRoomConfig(value) {
  const invalid = () => bad('Ongeldige roomconfiguratie.');
  if (!isObject(value)) throw invalid();
  const config = { host_mode: 'moderator', display_enabled: true, allow_late_join: false };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'host_mode' && MODES.includes(item)) config.host_mode = item;
    else if ((key === 'display_enabled' || key === 'allow_late_join') && typeof item === 'boolean') config[key] = item;
    else throw invalid();
  }
  return config;
}

function project(live, identity) {
  const room = live.data;
  const view = {
    code: room.code,
    game_id: room.game_id,
    game_version: room.game_version,
    status: room.status,
    version: room.version,
    max_players: room.max_players,
    settings: room.settings,
    host_connected: live.sessions.has(room.host_hash),
    host_player_id: room.host_player_id ?? null,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      connected: live.sessions.has(player.token_hash),
      ready: player.ready,
      account_id: player.account_id,
    })),
    public_state: room.public_state,
    you: { role: identity.role, player_id: identity.player_id },
    runtime: room.runtime,
    config: room.config,
    round_id: room.round_id,
    set: room.set,
  };
  if (identity.role === 'host') {
    view.host_state = room.host_state;
    view.player_states = room.player_states;
    if (identity.player_id) view.private_state = room.player_states[identity.player_id] ?? null;
  } else if (identity.role === 'player') {
    view.private_state = room.player_states[identity.player_id] ?? null;
  }
  return JSON.parse(stringify(view));
}

export class DevEngine {
  constructor({ game, hostAccount = randomUUID(), observe = () => {} }) {
    this.game = game;
    this.hostAccount = hostAccount;
    this.observe = observe;
    this.rooms = new Map();
    this.earned = new Set();
  }

  live(code) {
    const live = this.rooms.get(code);
    if (!live) throw missing();
    return live;
  }

  metadataFor(gameId) {
    const metadata = this.game.metadata;
    if (!metadata || metadata.id !== gameId) throw gameNotFound();
    return metadata;
  }

  changed(live) {
    const room = live.data;
    for (const [id, entry] of live.connections) {
      if (live.sessions.get(entry.key) !== id || !identifies(room, entry.key)) {
        entry.peer.revoked = true;
        live.connections.delete(id);
      }
    }
    for (const subscriber of [...live.subscribers]) subscriber.push({ type: 'changed' });
    this.observe('changed', room.code);
  }

  closeRoom(live, reason) {
    for (const entry of live.connections.values()) entry.peer.revoked = true;
    live.connections.clear();
    live.realtime.clear();
    for (const subscriber of [...live.subscribers]) subscriber.push({ type: 'closed', reason });
    this.observe('closed', live.data.code);
  }

  mutate(input, token, change) {
    const code = roomCode(input);
    const live = this.live(code);
    const identity = identify(live.data, token);
    const draft = structuredClone(live.data);
    change(draft, identity);
    draft.last_active = now();
    live.data = draft;
    this.changed(live);
    return project(live, identity);
  }

  createRoom(input, { accountId = this.hostAccount } = {}) {
    const metadata = this.metadataFor(input.game_id);
    const max = input.max_players ?? Math.max(Math.min(metadata.max_players, 24), metadata.min_players);
    if (max < metadata.min_players || max > metadata.max_players) throw bad('Aantal spelers valt buiten de limieten van dit spel.');
    const settings = this.initialSettings(metadata, input.settings);
    const base = { host_mode: metadata.default_host_mode, display_enabled: metadata.has_display, allow_late_join: false };
    if (input.config !== null && input.config !== undefined && !isObject(input.config)) throw bad('config moet een object zijn.');
    const config = parseRoomConfig({ ...base, ...(input.config ?? {}) });
    let chosen = null;
    if (input.set_id !== null && input.set_id !== undefined) {
      chosen = this.game.chooseSet(input.set_id);
      validateSetContent(metadata, chosen.set.kind, chosen.data);
    }
    return this.createWithOptions(metadata, max, settings, { config, accountId, set: chosen, name: input.name });
  }

  initialSettings(metadata, incoming) {
    const merged = isObject(metadata.default_settings) ? { ...metadata.default_settings } : null;
    if (incoming !== null && incoming !== undefined) {
      if (!isObject(incoming)) throw bad('Settings must be a JSON object.');
      if (!merged) throw bad('Default settings must be a JSON object.');
      Object.assign(merged, incoming);
    }
    validateSettings(metadata.settings_schema, merged ?? metadata.default_settings);
    return merged ?? metadata.default_settings;
  }

  createWithOptions(metadata, maxPlayers, settings, { config, accountId, set, name }) {
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 100 || !isObject(settings)) {
      throw bad('Kies 1–100 spelers en een settings-object.');
    }
    if (
      !metadata.host_modes.includes(config.host_mode) ||
      maxPlayers < metadata.min_players ||
      maxPlayers > metadata.max_players ||
      (config.display_enabled && !metadata.has_display) ||
      (config.allow_late_join && !metadata.supports_late_join)
    ) {
      throw bad('Deze game ondersteunt deze modus of capaciteit niet.');
    }
    if (metadata.runtime === 'host' && config.host_mode === 'hostless') {
      throw bad('Browser-hostgames hebben een spelleider nodig: kies moderator of playing.');
    }
    if (this.rooms.size >= MAX_ROOMS) throw new EngineError(503, 'room_limit', 'De server zit vol. Probeer later opnieuw.');
    let code;
    do {
      code = Array.from(randomBytes(6), byte => LETTERS[byte % LETTERS.length]).join('');
    } while (this.rooms.has(code));
    const host = newToken();
    const display = newToken();
    const playerId = config.host_mode !== 'moderator' ? randomUUID() : null;
    const players = [];
    if (playerId) {
      const hostName = (name ?? 'Spelleider').trim();
      validateName(hostName);
      // In a browser-host game the host starts the game; that is their consent.
      players.push({ id: playerId, name: hostName, token_hash: hash(host), account_id: accountId ?? null, ready: metadata.runtime === 'host' });
    }
    const data = {
      code,
      game_id: metadata.id,
      status: 'lobby',
      version: 0,
      max_players: maxPlayers,
      host_hash: hash(host),
      display_hash: hash(display),
      players,
      public_state: {},
      host_state: null,
      player_states: {},
      settings,
      last_active: now(),
      runtime: metadata.runtime,
      config,
      host_player_id: playerId,
      round_id: randomUUID(),
      game_version: metadata.version,
      host_account_id: accountId ?? null,
      set: set ? set.set : null,
    };
    this.rooms.set(code, {
      data,
      set: set ? set.data : null,
      sessions: new Map(),
      connections: new Map(),
      subscribers: new Set(),
      realtime: new Realtime(),
      awards: { started: Date.now(), count: 0 },
    });
    this.observe('created', code);
    const credential = { code, token: host, role: 'host', player_id: playerId };
    if (config.display_enabled) credential.display_token = display;
    return credential;
  }

  join(input, rawName, { accountId = randomUUID() } = {}) {
    const name = String(rawName).trim();
    validateName(name);
    const code = roomCode(input);
    const live = this.live(code);
    const data = structuredClone(live.data);
    if (data.status !== 'lobby' && !(data.status === 'running' && data.config.allow_late_join)) {
      throw conflict('room_started', 'Deze room is al gestart.');
    }
    if (accountId && data.players.some(player => player.account_id === accountId)) {
      throw conflict('already_joined', 'Dit account zit al in deze room. Hervat de bestaande sessie.');
    }
    if (data.players.length >= data.max_players) throw conflict('room_full', 'Deze room is vol.');
    if (data.players.some(player => player.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('name_taken', 'Deze naam is al in gebruik.');
    }
    const secret = newToken();
    const id = randomUUID();
    data.players.push({ id, name, token_hash: hash(secret), account_id: accountId ?? null, ready: false });
    data.last_active = now();
    live.data = data;
    this.changed(live);
    return { code, token: secret, role: 'player', player_id: id };
  }

  snapshot(input, token) {
    const live = this.live(roomCode(input));
    return project(live, identify(live.data, token));
  }

  info(input) {
    const room = this.live(roomCode(input)).data;
    return {
      code: room.code,
      game_id: room.game_id,
      game_version: room.game_version,
      status: room.status,
      player_count: room.players.length,
      max_players: room.max_players,
      config: room.config,
      runtime: room.runtime,
      set: room.set,
    };
  }

  setState(input, token, update) {
    return this.mutate(input, token, (room, identity) => {
      requireHost(identity);
      checkVersion(room, update.expected_version);
      const size = jsonBytes({ public: update.public_state, host: update.host_state, players: update.player_states });
      if (size > MAX_STATE_BYTES) throw new EngineError(413, 'state_too_large', 'Game state mag maximaal 64 KiB zijn.');
      if (Object.keys(update.player_states).some(id => !room.players.some(player => player.id === id))) {
        throw bad('Player state bevat een onbekende speler.');
      }
      room.public_state = update.public_state;
      room.host_state = update.host_state;
      room.player_states = update.player_states;
      room.version += 1;
    });
  }

  checkSettings(input, token, settings) {
    const view = this.snapshot(input, token);
    if (view.you.role !== 'host') throw forbidden();
    validateSettings(this.metadataFor(view.game_id).settings_schema, settings);
  }

  settings(input, token, update) {
    const live = this.live(roomCode(input));
    identify(live.data, token);
    validateSettings(this.metadataFor(live.data.game_id).settings_schema, update.settings);
    return this.mutate(input, token, (room, identity) => {
      requireHost(identity);
      checkVersion(room, update.expected_version);
      if (!isObject(update.settings) || jsonBytes(update.settings) > 8192) throw bad('Settings moeten een object van maximaal 8 KiB zijn.');
      room.settings = update.settings;
      room.version += 1;
    });
  }

  lifecycle(input, token, status) {
    identify(this.live(roomCode(input)).data, token);
    return this.mutate(input, token, (room, identity) => {
      requireHost(identity);
      const allowed = (room.status === 'lobby' && status === 'running') || (room.status === 'running' && status === 'finished') || (room.status === 'finished' && status === 'lobby');
      if (!allowed) throw conflict('invalid_transition', 'Gebruik lobby → running → finished → lobby.');
      if (status === 'running' && room.players.some(player => !player.ready && player.id !== room.host_player_id)) throw conflict('players_not_ready', 'Wacht tot iedereen klaar is.');
      room.status = status;
      room.version += 1;
      if (status === 'lobby') {
        room.public_state = {};
        room.host_state = null;
        room.player_states = {};
        room.round_id = randomUUID();
        for (const player of room.players) player.ready = player.id === room.host_player_id;
      }
    });
  }

  ready(input, token, ready) {
    return this.mutate(input, token, (room, identity) => {
      if (room.status !== 'lobby') throw conflict('room_started', 'Klaarzetten kan alleen in de lobby.');
      if (!identity.player_id) throw forbidden();
      const player = room.players.find(item => item.id === identity.player_id);
      if (!player) throw unauthorized();
      player.ready = ready;
    });
  }

  configurePatch(input, token, expectedVersion, patch) {
    const view = this.snapshot(input, token);
    if (!isObject(patch)) throw bad('config moet een object zijn.');
    const config = parseRoomConfig({ ...view.config, ...patch });
    const live = this.live(roomCode(input));
    identify(live.data, token);
    const metadata = this.metadataFor(live.data.game_id);
    if ((config.display_enabled && !metadata.has_display) || (config.allow_late_join && !metadata.supports_late_join)) {
      throw bad('Deze game ondersteunt dit apparaat of later aansluiten niet.');
    }
    return this.mutate(input, token, (room, identity) => {
      requireHost(identity);
      checkVersion(room, expectedVersion);
      if (room.status !== 'lobby') throw conflict('room_started', 'Apparaatinstellingen staan vast tijdens het spel.');
      if (room.config.host_mode !== config.host_mode) throw bad('De hostmodus kies je bij het maken van de room.');
      if (room.config.display_enabled && !config.display_enabled) room.display_hash = hash(newToken());
      room.config = config;
      room.version += 1;
    });
  }

  displayToken(input, token) {
    const secret = newToken();
    this.mutate(input, token, (room, identity) => {
      requireHost(identity);
      if (!room.config.display_enabled) throw forbidden();
      room.display_hash = hash(secret);
    });
    this.observe('display-token', roomCode(input), secret);
    return secret;
  }

  removePlayer(input, token, id) {
    const code = roomCode(input);
    const live = this.live(code);
    const identity = identify(live.data, token);
    let playerId = id;
    if (id === undefined) {
      if (identity.role !== 'player') throw forbidden();
      playerId = identity.player_id;
    } else {
      requireHost(identity);
    }
    const data = structuredClone(live.data);
    if (data.host_player_id === playerId) throw bad('De maker kan niet uit zijn eigen room worden verwijderd.');
    const player = data.players.find(item => item.id === playerId);
    if (!player) throw new EngineError(404, 'player_not_found', 'Deze speler bestaat niet.');
    data.players = data.players.filter(item => item.id !== playerId);
    delete data.player_states[playerId];
    data.last_active = now();
    live.data = data;
    live.sessions.delete(player.token_hash);
    this.changed(live);
    live.realtime.forget(player.id, Date.now());
  }

  leave(input, token) {
    this.removePlayer(input, token);
  }

  kick(input, token, id) {
    this.removePlayer(input, token, id);
  }

  delete(input, token) {
    const code = roomCode(input);
    const live = this.live(code);
    requireHost(identify(live.data, token));
    this.rooms.delete(code);
    this.closeRoom(live, 'room_deleted');
  }

  close(reason) {
    for (const live of this.rooms.values()) {
      for (const subscriber of [...live.subscribers]) subscriber.push({ type: 'closed', reason });
    }
  }

  attach(input, token, subscriber, deliver) {
    const code = roomCode(input);
    const live = this.live(code);
    const identity = identify(live.data, token);
    live.data.last_active = now();
    live.subscribers.add(subscriber);
    const connection = randomUUID();
    const peer = createPeer(identity, connection, deliver);
    live.sessions.set(identity.key, connection);
    live.connections.set(connection, { key: identity.key, peer });
    const values = live.realtime.subscribe(peer);
    this.changed(live);
    return { identity, connection, peer, realtime: live.realtime, values };
  }

  touch(input, token) {
    const live = this.live(roomCode(input));
    identify(live.data, token);
    live.data.last_active = now();
  }

  isCurrent(input, identity, connection) {
    const live = this.rooms.get(input);
    return Boolean(live) && live.sessions.get(identity.key) === connection;
  }

  canSnapshot(input, token) {
    try {
      this.snapshot(input, token);
      return true;
    } catch {
      return false;
    }
  }

  detach(input, attachment, subscriber) {
    const live = this.rooms.get(input);
    attachment.realtime.unsubscribe(attachment.peer);
    if (!live) return;
    live.subscribers.delete(subscriber);
    if (live.sessions.get(attachment.identity.key) === attachment.connection) {
      live.sessions.delete(attachment.identity.key);
      this.changed(live);
    }
  }

  action(input, token, name, data, requestId, actionId) {
    const code = roomCode(input);
    const live = this.live(code);
    const identity = identify(live.data, token);
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw bad('Gebruik een actienaam van 1–64 letters, cijfers, _, . of -.');
    }
    if (jsonBytes(data) > 8192) throw bad('Actiedata mag maximaal 8 KiB zijn.');
    if (actionId !== null && actionId !== undefined && (actionId.length === 0 || Buffer.byteLength(actionId) > 64 || hasControl(actionId))) {
      throw bad('action_id moet 1–64 tekens zijn.');
    }
    if (identity.role !== 'player') throw forbidden();
    if (!live.sessions.has(live.data.host_hash)) {
      throw conflict('host_offline', 'De host is offline. Probeer opnieuw zodra de host terug is.');
    }
    live.data.last_active = now();
    const text = stringify({ type: 'action', player_id: identity.player_id, name, data, request_id: requestId ?? null });
    for (const subscriber of [...live.subscribers]) subscriber.push({ type: 'action', text });
  }

  award(input, token, playerId, achievementId) {
    const code = roomCode(input);
    const live = this.live(code);
    const room = live.data;
    requireHost(identify(room, token));
    const declared = this.metadataFor(room.game_id).achievements;
    if (room.status !== 'running' && room.status !== 'finished') {
      throw conflict('game_not_running', 'Achievements toekennen kan alleen tijdens of na het spel.');
    }
    const notEligible = message => new EngineError(403, 'not_eligible', message);
    const player = room.players.find(item => item.id === playerId);
    if (!player) throw new EngineError(404, 'player_not_found', 'Deze speler bestaat niet.');
    if (!player.account_id) throw notEligible('Deze speler speelt als gast. Alleen spelers met een account krijgen achievements.');
    const achievement = declared.find(item => item.id === achievementId);
    if (!achievement) throw new EngineError(404, 'achievement_unknown', 'Dit spel heeft geen achievement met dit id.');
    if (!room.host_account_id) {
      throw notEligible('Deze room is zonder account gemaakt. Log in voordat je een room maakt om achievements te geven.');
    }
    // A host who plays along is a player like any other; a moderator cannot reward their own account by also joining.
    if (room.host_account_id === player.account_id && player.id !== room.host_player_id) throw notEligible('Je kunt jezelf geen achievement geven.');
    if (Date.now() - live.awards.started >= 60_000) live.awards = { started: Date.now(), count: 0 };
    if (live.awards.count >= AWARDS_PER_MINUTE) {
      throw new EngineError(429, 'rate_limit', 'Te veel achievements in korte tijd. Probeer het over een minuut opnieuw.');
    }
    live.awards.count += 1;
    const key = `${player.account_id}\u0000${room.game_id}\u0000${achievement.id}`;
    const earned = !this.earned.has(key);
    this.earned.add(key);
    if (earned) {
      live.realtime.achievement(player.id, achievement);
      this.observe('award', code, { player: player.name, title: achievement.title });
    }
    return {
      player_id: player.id,
      achievement: { id: achievement.id, title: achievement.title, description: achievement.description },
      already_earned: !earned,
    };
  }

  gameData(input, token) {
    const view = this.snapshot(input, token);
    if (view.you.role !== 'host') throw forbidden();
    const live = this.live(roomCode(input));
    if (live.set !== null) return live.set;
    this.metadataFor(view.game_id);
    return this.game.data;
  }

  presence(code) {
    const live = this.rooms.get(code);
    if (!live) return null;
    const room = live.data;
    return {
      status: room.status,
      version: room.version,
      host: live.sessions.has(room.host_hash),
      display: room.config.display_enabled && live.sessions.has(room.display_hash),
      players: Object.fromEntries(room.players.map(player => [player.id, live.sessions.has(player.token_hash)])),
    };
  }

  pinnedVersions(gameId) {
    return new Set([...this.rooms.values()].filter(live => live.data.game_id === gameId).map(live => live.data.game_version));
  }
}
