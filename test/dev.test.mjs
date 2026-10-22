import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gameFiles } from '../vendor/sdk/bin/templates.mjs';
import { ApiClient, MiniEngine } from '../vendor/sdk/dist/mini-engine.js';
import { BIN, runMe, tempHome } from './helpers/run.mjs';

const PARITY_URL = process.env.ME_DEV_PARITY_URL;
const PARITY_GAME = process.env.ME_DEV_PARITY_GAME;
const HOST_ACCOUNT = process.env.ME_DEV_PARITY_HOST_TOKEN;
const PLAYER_ACCOUNTS = (process.env.ME_DEV_PARITY_PLAYER_TOKENS ?? '').split(',').filter(Boolean);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function writeGame(root, slug, change = manifest => manifest) {
  const files = gameFiles(slug);
  files['manifest.json'] = `${JSON.stringify(change(JSON.parse(files['manifest.json'])), null, 2)}\n`;
  const dir = join(root, slug);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

function startDev(args, { home, cwd = home }) {
  const child = spawn(process.execPath, [BIN, 'dev', ...args, '--no-open'], { cwd, env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, stdout: '', stderr: '', code: null };
  child.stdout.on('data', chunk => (run.stdout += chunk));
  child.stderr.on('data', chunk => (run.stderr += chunk));
  run.exited = new Promise(resolve => child.on('close', code => resolve((run.code = code))));
  run.ready = async () => {
    const match = await until(() => /Overzicht: (http:\/\/127\.0\.0\.1:\d+)/.exec(run.stdout) || run.code !== null, 'me dev to start');
    if (match === true) throw new Error(`me dev stopped: ${run.stderr}`);
    run.url = match[1];
    return run;
  };
  run.stop = async () => {
    if (run.code === null) child.kill('SIGTERM');
    return run.exited;
  };
  return run;
}

function connect(baseUrl, credentials) {
  const client = new MiniEngine({ ...credentials, baseUrl, reconnectDelay: 100 });
  client.heard = [];
  client.actions = [];
  client.achievements = [];
  client.realtime.on('*', (data, from, ts, channel) => client.heard.push({ channel, data, from, ts }));
  client.on('action', action => client.actions.push(action));
  client.on('achievement', event => client.achievements.push(event));
  client.on('error', () => {});
  return client.connect();
}

const rejection = async promise => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

async function call(base, path, { method = 'GET', token, body, type = 'application/json' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && type) headers['content-type'] = type;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

describe('me dev speaks the engine protocol', () => {
  let home;
  let cleanup;
  let dev;
  let base;
  let gameId;
  const clients = [];

  before(async () => {
    if (PARITY_URL) {
      base = PARITY_URL.replace(/\/+$/, '');
      gameId = PARITY_GAME;
      return;
    }
    ({ home, cleanup } = await tempHome());
    await writeGame(home, 'stemtest');
    dev = await startDev(['stemtest', '--port', '0'], { home }).ready();
    base = dev.url;
    gameId = 'stemtest';
  });

  after(async () => {
    for (const client of clients) client.close();
    await dev?.stop();
    await cleanup?.();
  });

  const open = credentials => {
    const client = connect(base, credentials);
    clients.push(client);
    return client;
  };
  const host = () => new ApiClient({ baseUrl: base, accountToken: HOST_ACCOUNT });
  const player = index => new ApiClient({ baseUrl: base, accountToken: PLAYER_ACCOUNTS[index] });

  test('game pages, assets and the SDK are served like the engine serves them', async () => {
    const room = await host().createRoom({ game_id: gameId });
    const page = await call(base, `/api/v1/games/${gameId}/host?room=${room.code}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const policy = page.headers.get('content-security-policy');
    assert.match(policy, /^default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'/);
    assert.match(policy, /base-uri 'none'; object-src 'none'$/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const version = (await call(base, `/api/v1/rooms/${room.code}/info`)).json.game_version;
    assert.ok(page.text.includes(`/releases/${gameId}/${version}/assets/app.js`), 'a room page uses the assets of its pinned release');
    const script = await call(base, `/releases/${gameId}/${version}/assets/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('content-type'), 'text/javascript');
    assert.equal((await call(base, `/games/${gameId}/assets/style.css`)).headers.get('content-type'), 'text/css');
    const hidden = await call(base, `/games/${gameId}/manifest.json`);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.json.error.code, 'asset_not_found');
    const sdk = await call(base, '/sdk/mini-engine.js');
    assert.equal(sdk.status, 200);
    assert.match(sdk.text, /\bMiniEngine\b/);
    assert.equal((await call(base, `/api/v1/games/${gameId}/judge?room=${room.code}`)).json.error.code, 'game_page_not_found');
  });

  test('the HTTP API refuses bad input with the engine error envelope', async () => {
    const created = await call(base, '/api/v1/rooms', { method: 'POST', body: { game_id: gameId }, type: null });
    assert.equal(created.status, 415);
    assert.equal(created.json.error.code, 'invalid_json');
    const unknown = await call(base, '/api/v1/rooms', { method: 'POST', body: { game_id: gameId, colour: 'rood' } });
    assert.equal(unknown.status, 422);
    assert.equal((await call(base, '/api/v1/rooms', { method: 'POST', body: '{"game_id":' })).status, 400);
    assert.equal((await call(base, '/api/v1/rooms', { method: 'POST', body: { game_id: 'bestaat-niet' } })).json.error.code, 'game_not_found');
    const missing = await call(base, '/api/v1/rooms/QQQQQQ/info');
    assert.deepEqual([missing.status, missing.json.error.code], [404, 'room_not_found']);
    // The template plays along by default; these checks are about a host who only leads.
    const room = await host().createRoom({ game_id: gameId, config: { host_mode: 'moderator' } });
    assert.equal(room.role, 'host');
    assert.equal(room.player_id, null);
    assert.equal(typeof room.display_token, 'string');
    await player(0).joinRoom(room.code, 'Dani');
    const taken = await call(base, `/api/v1/rooms/${room.code.toLowerCase()}/join`, { method: 'POST', body: { name: ' dani ' } });
    assert.deepEqual([taken.status, taken.json.error.code], [409, 'name_taken']);
    const name = await call(base, `/api/v1/rooms/${room.code}/join`, { method: 'POST', body: { name: 'x'.repeat(25) } });
    assert.deepEqual([name.status, name.json.error.code], [400, 'invalid_request']);
    const sander = await player(1).joinRoom(room.code, 'Sander');
    assert.equal((await call(base, `/api/v1/rooms/${room.code}`, { token: 'x'.repeat(64) })).json.error.code, 'unauthorized');
    assert.equal((await call(base, `/api/v1/rooms/${room.code}/game-data`, { token: sander.token })).json.error.code, 'forbidden');
    assert.equal((await call(base, `/api/v1/rooms/${room.code}/game-data`, { token: room.token })).status, 200);
    const settings = await call(base, `/api/v1/rooms/${room.code}/settings`, { method: 'PUT', token: room.token, body: { expected_version: 0, settings: { prompt: 'Pizza?' } } });
    assert.deepEqual([settings.status, settings.json.error.message], [400, 'Missing required setting: allow_change']);
    const wrongMethod = await call(base, `/api/v1/rooms/${room.code}/info`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await call(base, `/api/v1/rooms/${room.code}`, { method: 'DELETE', token: room.token })).status, 204);
  });

  test('a full round: ready, start, actions, versioned state, realtime and awards', async () => {
    const credentials = await host().createRoom({ game_id: gameId, config: { host_mode: 'moderator' } });
    const daniSeat = await player(0).joinRoom(credentials.code, 'Dani');
    const sanderSeat = await player(1).joinRoom(credentials.code, 'Sander');
    const hostClient = open(credentials);
    const dani = open(daniSeat);
    const sander = open(sanderSeat);
    const display = open({ code: credentials.code, token: credentials.display_token, role: 'display' });
    const everyone = [hostClient, dani, sander, display];
    await Promise.all(everyone.map(client => client.waitForSnapshot(room => room.host_connected && room.players.every(p => p.connected))));

    assert.equal(hostClient.room.you.role, 'host');
    assert.ok('host_state' in hostClient.room && 'player_states' in hostClient.room);
    assert.equal(dani.room.you.player_id, daniSeat.player_id);
    assert.equal(dani.room.private_state, null);
    assert.ok(!('host_state' in dani.room) && !('player_states' in dani.room));
    assert.ok(!('private_state' in display.room) && !('host_state' in display.room));
    assert.equal(display.room.you.role, 'display');
    assert.equal(hostClient.room.status, 'lobby');
    assert.equal(hostClient.room.version, 0);

    assert.equal((await rejection(hostClient.lifecycle('running'))).code, 'players_not_ready');
    assert.equal((await rejection(hostClient.ready(true))).code, 'forbidden');
    await dani.ready(true);
    await sander.ready(true);
    await hostClient.waitForSnapshot(room => room.players.every(p => p.ready));
    assert.equal(hostClient.room.version, 0, 'readiness does not change the state version');
    await hostClient.lifecycle('running');
    await Promise.all(everyone.map(client => client.waitForSnapshot(room => room.status === 'running' && room.version === 1)));
    assert.equal((await rejection(dani.ready(false))).code, 'room_started');

    await dani.action('vote', { yes: true });
    const action = await until(() => hostClient.actions[0], 'the action to reach the host');
    assert.equal(action.player_id, daniSeat.player_id);
    assert.equal(action.name, 'vote');
    assert.deepEqual(action.data, { yes: true });
    assert.equal(dani.actions.length + sander.actions.length + display.actions.length, 0);
    assert.equal((await rejection(dani.action('bad name!'))).code, 'invalid_request');
    assert.equal((await rejection(display.action('vote', { yes: true }))).code, 'forbidden');

    await hostClient.setState({
      expected_version: 1,
      public_state: { votes: { [daniSeat.player_id]: true } },
      host_state: { secret: 'alleen voor de host' },
      player_states: { [daniSeat.player_id]: { hand: [1, 2] } },
    });
    await Promise.all(everyone.map(client => client.waitForSnapshot(room => room.version === 2)));
    assert.deepEqual(display.room.public_state, { votes: { [daniSeat.player_id]: true } });
    assert.deepEqual(dani.room.private_state, { hand: [1, 2] });
    assert.equal(sander.room.private_state, null);
    assert.deepEqual(hostClient.room.host_state, { secret: 'alleen voor de host' });
    assert.equal((await rejection(hostClient.setState({ expected_version: 1, public_state: {} }))).code, 'version_conflict');
    assert.equal((await rejection(hostClient.setState({ expected_version: 2, public_state: { big: 'x'.repeat(70 * 1024) } }))).code, 'state_too_large');
    assert.equal((await rejection(hostClient.setState({ expected_version: 2, public_state: {}, player_states: { iemand: 1 } }))).code, 'invalid_request');
    assert.equal((await rejection(dani.setState({ expected_version: 2, public_state: {} }))).code, 'forbidden');
    assert.equal((await rejection(hostClient.setSettings({ prompt: 'Pizza?', allow_change: 'ja' }))).code, 'invalid_request');
    await hostClient.setSettings({ prompt: 'Pizza?', allow_change: false });
    await dani.waitForSnapshot(room => room.version === 3 && room.settings.prompt === 'Pizza?');

    const before = Date.now();
    assert.equal(dani.realtime.emit('buzz', { at: 1 }, { to: 'host' }), true);
    dani.realtime.emit('mark', null);
    await Promise.all([hostClient, sander, display].map(client => until(() => client.heard.some(e => e.channel === 'mark'), 'the marker event')));
    const buzz = hostClient.heard.find(e => e.channel === 'buzz');
    assert.deepEqual(buzz.data, { at: 1 });
    assert.deepEqual(buzz.from, { role: 'player', player_id: daniSeat.player_id });
    assert.ok(buzz.ts >= before - 2000 && buzz.ts <= Date.now() + 2000, 'the server stamps its own receive time');
    assert.ok(!sander.heard.some(e => e.channel === 'buzz') && !display.heard.some(e => e.channel === 'buzz'));
    assert.ok(!dani.heard.some(e => e.channel === 'mark'), 'the sender does not hear itself without echo');

    hostClient.realtime.emit('round', 1, { to: 'players' });
    hostClient.realtime.emit('only', 'Sander', { to: [sanderSeat.player_id] });
    hostClient.realtime.emit('mark2', null, { echo: true });
    await Promise.all(everyone.map(client => until(() => client.heard.some(e => e.channel === 'mark2'), 'the second marker')));
    assert.deepEqual(everyone.map(client => client.heard.some(e => e.channel === 'round')), [false, true, true, false]);
    assert.deepEqual(everyone.map(client => client.heard.some(e => e.channel === 'only')), [false, false, true, false]);
    assert.deepEqual(hostClient.heard.find(e => e.channel === 'mark2').from, { role: 'host', player_id: null });

    dani.realtime.set('cursor', { x: 3 });
    await until(() => hostClient.realtime.value(daniSeat.player_id, 'cursor'), 'the realtime value');
    assert.deepEqual(hostClient.realtime.value(daniSeat.player_id, 'cursor'), { x: 3 });
    display.close();
    const late = open({ code: credentials.code, token: credentials.display_token, role: 'display' });
    await late.waitForSnapshot();
    await until(() => late.realtime.value(daniSeat.player_id, 'cursor'), 'rt.values for a new connection');

    const award = await rejection(hostClient.award(daniSeat.player_id, 'bestaat-niet'));
    assert.equal(award.code, 'achievement_unknown');
    assert.equal((await rejection(dani.award(sanderSeat.player_id, 'bestaat-niet'))).code, 'forbidden');

    const round = hostClient.room.round_id;
    await hostClient.lifecycle('finished');
    await hostClient.lifecycle('lobby');
    await hostClient.waitForSnapshot(room => room.status === 'lobby' && room.version === 5);
    assert.deepEqual(hostClient.room.public_state, {});
    assert.equal(hostClient.room.host_state, null);
    assert.deepEqual(hostClient.room.player_states, {});
    assert.ok(hostClient.room.players.every(p => !p.ready));
    assert.notEqual(hostClient.room.round_id, round);
    assert.equal((await rejection(hostClient.lifecycle('finished'))).code, 'invalid_transition');

    hostClient.close();
    await dani.waitForSnapshot(room => !room.host_connected);
    assert.equal((await rejection(dani.action('vote', { yes: false }))).code, 'host_offline');
  });

  test('the raw socket: auth, ack order, closing reasons and realtime limits', async () => {
    const credentials = await host().createRoom({ game_id: gameId });
    const daniSeat = await player(0).joinRoom(credentials.code, 'Dani');
    const socket = (token, onOpen = () => {}) => {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/rooms/${credentials.code}/ws`);
      ws.messages = [];
      ws.addEventListener('message', event => ws.messages.push(JSON.parse(event.data)));
      ws.closed = new Promise(resolve => ws.addEventListener('close', resolve));
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
        onOpen(ws);
      });
      ws.next = async (type, from = 0) => until(() => ws.messages.slice(from).find(message => message.type === type), `a ${type} message`);
      return ws;
    };
    const stranger = socket('f'.repeat(64));
    assert.equal((await stranger.next('error')).error.code, 'unauthorized');
    await stranger.closed;

    const ws = socket(daniSeat.token);
    await ws.next('rt.values');
    assert.equal(ws.messages[0].type, 'snapshot');
    assert.equal(ws.messages[1].type, 'rt.values');
    let from = ws.messages.length;
    ws.send(JSON.stringify({ type: 'ready', ready: true, request_id: 'r1' }));
    const ack = await ws.next('ack', from);
    assert.equal(ack.request_id, 'r1');
    const order = ws.messages.slice(from).map(message => message.type);
    assert.ok(order.indexOf('snapshot') < order.indexOf('ack'), 'a changing command sends its snapshot before the ack');
    from = ws.messages.length;
    ws.send(JSON.stringify({ type: 'ping', request_id: 'p' }));
    assert.equal((await ws.next('ack', from)).request_id, 'p');
    ws.send(JSON.stringify({ type: 'dance', request_id: 'd' }));
    const unknown = await ws.next('error', from);
    assert.deepEqual([unknown.request_id, unknown.error.code], ['d', 'invalid_request']);
    from = ws.messages.length;
    ws.send(JSON.stringify({ type: 'rt.emit', channel: 'buzz', request_id: 'x' }));
    assert.equal((await ws.next('error', from)).error.code, 'invalid_request');
    from = ws.messages.length;
    ws.send(JSON.stringify({ type: 'rt.reset' }));
    assert.equal((await ws.next('error', from)).error.code, 'forbidden');
    from = ws.messages.length;
    ws.send(JSON.stringify({ type: 'rt.emit', channel: 'c', data: 'x'.repeat(3000) }));
    assert.equal((await ws.next('error', from)).error.message, 'Realtime-data mag maximaal 2 KiB zijn.');
    from = ws.messages.length;
    for (let i = 0; i < 200; i += 1) ws.send(JSON.stringify({ type: 'rt.emit', channel: 'burst', data: i }));
    const throttled = await ws.next('rt.throttled', from);
    assert.ok(throttled.dropped >= 1);
    assert.equal(ws.readyState, WebSocket.OPEN, 'realtime overflow never closes the socket');

    const replacement = socket(daniSeat.token);
    await replacement.next('snapshot');
    assert.equal((await ws.next('closed')).reason, 'session_replaced');
    await call(base, `/api/v1/rooms/${credentials.code}/players/${daniSeat.player_id}`, { method: 'DELETE', token: credentials.token });
    assert.equal((await replacement.next('closed')).reason, 'session_revoked');
    const hostSocket = socket(credentials.token);
    await hostSocket.next('snapshot');
    await call(base, `/api/v1/rooms/${credentials.code}`, { method: 'DELETE', token: credentials.token });
    assert.equal((await hostSocket.next('closed')).reason, 'room_deleted');
  });
});

const PLAYING_GAME = process.env.ME_DEV_PARITY_PLAYING_GAME;
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#2b6"/></svg>';

describe('me dev lets the host of a browser-host game play along', { skip: PARITY_URL && !PLAYING_GAME ? 'set ME_DEV_PARITY_PLAYING_GAME for a game with host_modes ["moderator", "playing"]' : false }, () => {
  let home;
  let cleanup;
  let dev;
  let base;
  let gameId;
  const clients = [];

  before(async () => {
    if (PARITY_URL) {
      base = PARITY_URL.replace(/\/+$/, '');
      gameId = PLAYING_GAME;
      return;
    }
    ({ home, cleanup } = await tempHome());
    const dir = await writeGame(home, 'meespelen', manifest => ({ ...manifest, host_modes: ['moderator', 'playing'], default_host_mode: 'playing', icon: 'assets/icoon.svg', achievements: [{ id: 'winnaar', title: 'Winnaar', description: 'Win de stemming.' }] }));
    await writeFile(join(dir, 'assets', 'icoon.svg'), ICON);
    dev = await startDev(['meespelen', '--port', '0', '--players', '1'], { home }).ready();
    base = dev.url;
    gameId = 'meespelen';
  });

  after(async () => {
    for (const client of clients) client.close();
    await dev?.stop();
    await cleanup?.();
  });

  const open = credentials => {
    const client = connect(base, credentials);
    clients.push(client);
    return client;
  };
  const host = () => new ApiClient({ baseUrl: base, accountToken: HOST_ACCOUNT });
  const player = index => new ApiClient({ baseUrl: base, accountToken: PLAYER_ACCOUNTS[index] });

  test('the games listing carries the icon exactly as declared, and the icon is served', { skip: Boolean(PARITY_URL) }, async () => {
    const listing = (await call(base, '/api/v1/games')).json.games.find(game => game.id === gameId);
    assert.equal(listing.icon, 'assets/icoon.svg');
    assert.equal((await call(base, `/api/v1/games/${gameId}`)).json.icon, 'assets/icoon.svg');
    const icon = await call(base, `/games/${gameId}/assets/icoon.svg`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.equal(icon.text, ICON);
  });

  test('the creator gets a seat on the host credential that never blocks the start and can earn achievements', async () => {
    const credentials = await host().createRoom({ game_id: gameId, name: ' Cas ', config: { host_mode: 'playing' } });
    assert.equal(credentials.role, 'host');
    assert.equal(typeof credentials.player_id, 'string');
    const daniSeat = await player(0).joinRoom(credentials.code, 'Dani');
    const hostClient = open(credentials);
    const dani = open(daniSeat);
    const display = open({ code: credentials.code, token: credentials.display_token, role: 'display' });
    const everyone = [hostClient, dani, display];
    await Promise.all(everyone.map(client => client.waitForSnapshot(room => room.host_connected && room.players.every(p => p.connected))));

    for (const client of everyone) assert.equal(client.room.host_player_id, credentials.player_id);
    assert.deepEqual(hostClient.room.you, { role: 'host', player_id: credentials.player_id });
    assert.deepEqual(hostClient.room.players.map(p => [p.name, p.ready]), [['Cas', true], ['Dani', false]]);
    assert.equal(hostClient.room.private_state, null, 'the playing host also gets its own private state');
    assert.equal((await rejection(hostClient.action('vote', { yes: true }))).code, 'forbidden');
    assert.equal((await call(base, `/api/v1/rooms/${credentials.code}/leave`, { method: 'POST', token: credentials.token })).json.error.code, 'forbidden');
    const kick = await call(base, `/api/v1/rooms/${credentials.code}/players/${credentials.player_id}`, { method: 'DELETE', token: credentials.token });
    assert.equal(kick.status, 400);

    assert.equal((await rejection(hostClient.lifecycle('running'))).code, 'players_not_ready');
    await hostClient.ready(false);
    await dani.ready(true);
    await hostClient.waitForSnapshot(room => room.players.every(p => p.ready === (p.id === daniSeat.player_id)));
    assert.equal(hostClient.room.version, 0);
    await hostClient.lifecycle('running');
    await hostClient.award(credentials.player_id, 'winnaar');
    const earned = await until(() => hostClient.achievements[0], 'the achievement event for the playing host');
    assert.equal(earned.achievement.id, 'winnaar', 'a host who plays along can earn an achievement on its own seat');
    await hostClient.setState({ expected_version: 1, public_state: {}, player_states: { [credentials.player_id]: { hand: [7] } } });
    await hostClient.waitForSnapshot(room => room.version === 2);
    assert.deepEqual(hostClient.room.private_state, { hand: [7] });
    await hostClient.lifecycle('finished');
    await hostClient.lifecycle('lobby');
    await Promise.all(everyone.map(client => client.waitForSnapshot(room => room.status === 'lobby' && room.version === 4)));
    assert.deepEqual(hostClient.room.players.map(p => [p.name, p.ready]), [['Cas', true], ['Dani', false]]);
    assert.equal(display.room.host_player_id, credentials.player_id);
  });

  test('the host seat counts towards the players; a moderator room has no host seat; hostless is refused', async () => {
    const full = await host().createRoom({ game_id: gameId, max_players: 2 });
    assert.equal(typeof full.player_id, 'string', 'default_host_mode decides when config leaves host_mode out');
    const snapshot = (await call(base, `/api/v1/rooms/${full.code}`, { token: full.token })).json;
    assert.deepEqual(snapshot.players.map(p => p.name), ['Spelleider']);
    await player(0).joinRoom(full.code, 'Dani');
    const third = await call(base, `/api/v1/rooms/${full.code}/join`, { method: 'POST', body: { name: 'Sander' } });
    assert.deepEqual([third.status, third.json.error.code], [409, 'room_full']);

    const moderated = await host().createRoom({ game_id: gameId, name: 'Cas', config: { host_mode: 'moderator' } });
    assert.equal(moderated.player_id, null);
    const view = (await call(base, `/api/v1/rooms/${moderated.code}`, { token: moderated.token })).json;
    assert.equal(view.host_player_id, null);
    assert.deepEqual(view.players, []);

    const hostless = await call(base, '/api/v1/rooms', { method: 'POST', body: { game_id: gameId, config: { host_mode: 'hostless' } } });
    assert.deepEqual([hostless.status, hostless.json.error.code], [400, 'invalid_request']);
    const name = await call(base, '/api/v1/rooms', { method: 'POST', body: { game_id: gameId, name: 'x'.repeat(25) } });
    assert.deepEqual([name.status, name.json.error.code], [400, 'invalid_request']);
  });

  test('the launcher seats the host as a player too', { skip: Boolean(PARITY_URL) }, async () => {
    const state = (await call(dev.url, '/__me/state')).json;
    assert.deepEqual(state.seats.map(seat => seat.label), ['Spelleider', 'Scherm', 'Dani']);
    const credential = JSON.parse(decodeURIComponent(state.seats[0].hash));
    assert.equal(typeof credential.player_id, 'string');
  });
});

describe('me dev', () => {
  let home;
  let cleanup;
  const running = [];
  before(async () => ({ home, cleanup } = await tempHome()));
  after(async () => {
    for (const run of running) await run.stop();
    await cleanup();
  });
  const launch = async (args, options = {}) => {
    const run = startDev(args, { home, ...options });
    running.push(run);
    return run.ready();
  };

  test('is listed in the help under Lokaal testen', async () => {
    const help = await runMe(['--help'], { home });
    assert.match(help.stdout, /Lokaal testen\n {2}dev \[map\] +Game lokaal testen met een nagebootste engine/);
    const own = await runMe(['dev', '--help'], { home });
    assert.match(own.stdout, /Gebruik: me dev \[map\] \[--port 3170\] \[--players 2\] \[--set bestand\.json\] \[--no-open\]/);
    const bad = await runMe(['dev', '--port', 'hoog'], { home });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--port moet een geheel getal van 0 tot 65535 zijn/);
  });

  test('refuses to start on manifest errors, with the messages of me game upload', async () => {
    const empty = join(home, 'leeg');
    await mkdir(empty);
    const none = await runMe(['dev', 'leeg', '--no-open'], { home });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /Geen manifest\.json gevonden in .*leeg\./);

    const serverGame = await writeGame(home, 'servergame', manifest => ({ ...manifest, runtime: 'server' }));
    const dev = await runMe(['dev', serverGame, '--no-open'], { home });
    const upload = await runMe(['game', 'upload', serverGame, '--dry-run'], { home });
    assert.equal(dev.code, 1);
    assert.match(dev.stderr, /manifest\.json: alleen games met runtime "host" kunnen worden geüpload\./);
    assert.equal(dev.stderr, upload.stderr);

    await writeGame(home, 'zonderhtml');
    await rm(join(home, 'zonderhtml', 'player.html'));
    const html = await runMe(['dev', 'zonderhtml', '--no-open'], { home });
    assert.match(html.stderr, /Ontbrekende bestanden: player\.html/);

    await writeGame(home, 'badges', manifest => ({ ...manifest, achievements: [{ id: 'Winnaar', title: 'Winnaar', description: 'Win.' }] }));
    const badges = await runMe(['dev', 'badges', '--no-open'], { home });
    const badgesUpload = await runMe(['game', 'upload', join(home, 'badges'), '--dry-run'], { home });
    assert.equal(badges.code, 1);
    assert.match(badges.stderr, /manifest\.json: achievements\[0\]\.id moet 1 tot 48 kleine letters/);
    assert.equal(badges.stderr, badgesUpload.stderr);

    await writeGame(home, 'zonderleider', manifest => ({ ...manifest, host_modes: ['hostless'], default_host_mode: 'hostless' }));
    const hostless = await runMe(['dev', 'zonderleider', '--no-open'], { home });
    assert.equal(hostless.code, 1);
    assert.match(hostless.stderr, /"hostless" is alleen voor ingebouwde games\./);
    assert.equal(hostless.stderr, (await runMe(['game', 'upload', join(home, 'zonderleider'), '--dry-run'], { home })).stderr);

    const scripted = await writeGame(home, 'scripticoon', manifest => ({ ...manifest, icon: 'assets/icoon.svg' }));
    await writeFile(join(scripted, 'assets', 'icoon.svg'), '<svg onload="alert(1)"></svg>');
    const icon = await runMe(['dev', 'scripticoon', '--no-open'], { home });
    assert.equal(icon.code, 1);
    assert.match(icon.stderr, /manifest\.json: icon assets\/icoon\.svg bevat een on…=-attribuut\. Een icoon mag geen scripts bevatten\./);
    assert.equal(icon.stderr, (await runMe(['game', 'upload', scripted, '--dry-run'], { home })).stderr);

    await writeGame(home, 'schema', manifest => ({ ...manifest, default_settings: { prompt: 'x', allow_change: 'ja' } }));
    const schema = await runMe(['dev', 'schema', '--no-open'], { home });
    assert.match(schema.stderr, /De engine weigert deze game: Setting has an invalid value type\./);
  });

  test('declared achievements reach every seat and the terminal; undeclared ones are refused', async () => {
    await writeGame(home, 'prijzen', manifest => ({
      ...manifest,
      achievements: [{ id: 'winnaar', title: 'Winnaar', description: 'Win de stemming.' }],
    }));
    const run = await launch(['prijzen', '--port', '0']);
    const api = new ApiClient({ baseUrl: run.url });
    const credentials = await api.createRoom({ game_id: 'prijzen' });
    const daniSeat = await api.joinRoom(credentials.code, 'Dani');
    const hostClient = connect(run.url, credentials);
    const dani = connect(run.url, daniSeat);
    try {
      await Promise.all([hostClient, dani].map(client => client.waitForSnapshot(room => room.host_connected)));
      assert.ok(dani.room.players[0].account_id, 'every player counts as a player with an account');
      assert.equal((await rejection(hostClient.award(daniSeat.player_id, 'winnaar'))).code, 'game_not_running');
      await dani.ready();
      await hostClient.lifecycle('running');
      await hostClient.award(daniSeat.player_id, 'winnaar');
      const event = await until(() => dani.achievements[0], 'the achievement event');
      assert.deepEqual(event, { player_id: daniSeat.player_id, achievement: { id: 'winnaar', title: 'Winnaar', description: 'Win de stemming.' } });
      await until(() => run.stdout.includes('Dani kreeg Winnaar'), 'the terminal line');
      await hostClient.award(daniSeat.player_id, 'winnaar');
      const repeat = await call(run.url, `/api/v1/rooms/${credentials.code}/achievements`, { method: 'POST', token: credentials.token, body: { player_id: daniSeat.player_id, achievement_id: 'winnaar' } });
      assert.equal(repeat.json.already_earned, true);
      assert.equal(dani.achievements.length, 1, 'an achievement is celebrated once');
      assert.equal((await rejection(hostClient.award(daniSeat.player_id, 'kampioen'))).code, 'achievement_unknown');
      assert.equal(run.stdout.match(/kreeg/g).length, 1);
    } finally {
      hostClient.close();
      dani.close();
    }
  });

  test('--set is checked against the declared set kind and served as game data', async () => {
    const schema = {
      type: 'object',
      properties: { vragen: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 80 } } },
      required: ['vragen'],
      additionalProperties: false,
    };
    await writeGame(home, 'kwis', manifest => ({ ...manifest, set_kinds: [{ id: 'vragen', title: 'Vragen', description: 'Een lijst vragen.', schema }] }));
    await writeFile(join(home, 'kwis', 'data.json'), JSON.stringify({ vragen: ['Standaard?'] }));
    await writeFile(join(home, 'fout.json'), JSON.stringify({ vragen: [] }));
    const wrong = await runMe(['dev', 'kwis', '--set', 'fout.json', '--no-open'], { home });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /fout\.json past niet bij set-soort vragen: vragen: gebruik 1–5 items\./);

    await writeFile(join(home, 'filmavond.json'), JSON.stringify({ vragen: ['Wie regisseerde Jaws?'] }));
    const run = await launch(['kwis', '--set', 'filmavond.json', '--port', '0']);
    assert.match(run.stdout, /Set: filmavond \(vragen\)/);
    const state = (await call(run.url, '/__me/state')).json;
    const seat = JSON.parse(decodeURIComponent(state.seats.find(item => item.role === 'host').hash));
    const data = await call(run.url, `/api/v1/rooms/${seat.code}/game-data`, { token: seat.token });
    assert.deepEqual(data.json, { vragen: ['Wie regisseerde Jaws?'] });
    const snapshot = await call(run.url, `/api/v1/rooms/${seat.code}`, { token: seat.token });
    assert.equal(snapshot.json.set.kind, 'vragen');
    assert.equal(snapshot.json.set.title, 'filmavond');
    const plain = await new ApiClient({ baseUrl: run.url }).createRoom({ game_id: 'kwis' });
    assert.deepEqual((await call(run.url, `/api/v1/rooms/${plain.code}/game-data`, { token: plain.token })).json, { vragen: ['Standaard?'] });
    const chosen = await call(run.url, '/api/v1/rooms', { method: 'POST', body: { game_id: 'kwis', set_id: snapshot.json.set.id } });
    assert.equal(chosen.status, 201);
    const missing = await call(run.url, '/api/v1/rooms', { method: 'POST', body: { game_id: 'kwis', set_id: 'iets-anders' } });
    assert.equal(missing.json.error.code, 'set_not_found');
  });

  test('every seat has its own port; the launcher frames them and adds players', async () => {
    await writeGame(home, 'stoelen');
    const run = await launch(['stoelen', '--port', '0', '--players', '3']);
    const launcher = await call(run.url, '/');
    assert.equal(launcher.status, 200);
    assert.match(launcher.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
    const state = (await call(run.url, '/__me/state')).json;
    assert.deepEqual(state.seats.map(seat => seat.label), ['Spelleider', 'Scherm', 'Dani', 'Sander', 'Kevin']);
    const ports = state.seats.map(seat => seat.port);
    assert.equal(new Set([...ports, Number(new URL(run.url).port)]).size, 6);
    const dani = state.seats[2];
    const seatBase = `http://127.0.0.1:${dani.port}`;
    const shell = await call(seatBase, dani.path);
    assert.match(shell.text, /\/__me\/seat\.js/);
    const launcherOrigin = run.url;
    assert.ok(shell.headers.get('content-security-policy').includes(`frame-ancestors 'self' ${launcherOrigin}`));
    const credential = JSON.parse(decodeURIComponent(dani.hash));
    const game = await call(seatBase, `/api/v1/games/stoelen/player?room=${credential.code}`);
    assert.equal(game.status, 200);
    assert.equal((await call(seatBase, '/__me/state')).status, 404, 'the launcher API lives on the launcher port only');
    const renewed = await call(run.url, '/__me/room', { method: 'POST', body: '', type: 'text/plain' });
    assert.equal(renewed.status, 200);
    const added = await fetch(`${run.url}/__me/players`, { method: 'POST' }).then(response => response.json());
    assert.equal(added.seats.at(-1).label, 'Jelmer');
    assert.equal(added.room.code, renewed.json.room.code);
    assert.notEqual(added.room.code, credential.code);
    const refused = await fetch(`${run.url}/__me/players`, { method: 'POST', headers: { origin: 'https://example.com' } });
    assert.equal(refused.status, 403);
    const port = new URL(run.url).port;
    for (const host of [`rebound.example:${port}`, `127.0.0.1.example:${port}`]) {
      const status = await new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host } }, response => { response.resume(); resolve(response.statusCode); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 421, `a page reached through ${host} must not be served`);
    }
  });

  test('reloads the seats after a change and reports manifest errors without stopping', async () => {
    const dir = await writeGame(home, 'herladen');
    const run = await launch(['herladen', '--port', '0']);
    const states = [];
    const controller = new AbortController();
    const response = await fetch(`${run.url}/__me/events`, { signal: controller.signal });
    const reader = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (data) states.push(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        return;
      }
    })();
    try {
      await until(() => states.length, 'the first state');
      const start = states[0].generation;
      await sleep(150);
      await writeFile(join(dir, 'assets', 'app.js'), `${await readFile(join(dir, 'assets', 'app.js'), 'utf8')}\n`);
      await until(() => states.some(state => state.generation > start), 'a reload', 8000);
      await until(() => run.stdout.includes('Herladen na wijziging in assets/app.js'), 'the reload line');
      const manifestPath = join(dir, 'manifest.json');
      const good = await readFile(manifestPath, 'utf8');
      await writeFile(manifestPath, '{ niet af');
      const broken = await until(() => states.find(state => state.problem), 'the problem', 8000);
      assert.match(broken.problem, /manifest\.json is geen geldige JSON/);
      await until(() => run.stderr.includes('Fout in de game'), 'the terminal error');
      assert.equal(run.code, null, 'me dev keeps running');
      const room = broken.room.code;
      assert.equal((await call(run.url, `/api/v1/rooms/${room}/info`)).status, 200, 'the room survives');
      await writeFile(manifestPath, good);
      await until(() => states.at(-1).problem === null, 'the repaired game', 8000);
      assert.equal(states.at(-1).room.code, room);
    } finally {
      controller.abort();
      await reader;
    }
  });

  test('--json prints one object with the address and the seats', async () => {
    await writeGame(home, 'jsongame');
    const run = startDev(['jsongame', '--port', '0', '--json'], { home });
    running.push(run);
    const info = await until(() => {
      try {
        return JSON.parse(run.stdout);
      } catch {
        return null;
      }
    }, 'the JSON object');
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(info.game.id, 'jsongame');
    assert.deepEqual(info.seats.map(seat => seat.role), ['host', 'display', 'player', 'player']);
    assert.equal(await run.stop(), 0);
    assert.doesNotThrow(() => JSON.parse(run.stdout));
  });
});
