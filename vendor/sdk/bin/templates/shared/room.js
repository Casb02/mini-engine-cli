// Shared by every page: session, connection, errors, room code, lobby buttons and the player list.
import { MiniEngine, loadSession } from '/sdk/mini-engine.js';
import { bindCopyCode, bindQrDialog, joinUrl, qrSvg } from './ui/invite.js'; //@ui
import { fill, t } from './texts.js';
/** @import { Role, Snapshot } from '/sdk/mini-engine.js' */

/** @param {string} id */
export const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
export const button = id => /** @type {HTMLButtonElement} */ (document.getElementById(id));
export const role = /** @type {Role} */ (document.body.dataset.role);
const code = new URLSearchParams(location.search).get('room') || '';

/** @param {unknown} error */
export function showError(error) {
  const known = t.errors[/** @type {{ code?: string }} */ (error)?.code ?? ''];
  $('error').textContent = known ?? /** @type {Error} */ (error)?.message ?? String(error);
}

/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/** The host's writes run one at a time, so each one sees the version the previous one made. @param {() => Promise<unknown>} task */
export const enqueue = task => (queue = queue.then(task).catch(showError));

let busy = false;
let redraw = () => {};
/** Draws the page again, for changes only this page knows about. */
export const refresh = () => redraw();
/** Buttons stay disabled until the request is answered. @param {() => Promise<unknown>} request */
export async function run(request) {
  $('error').textContent = '';
  busy = true;
  redraw();
  try {
    await request();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    redraw();
  }
}

/** Null when the page was not opened through the room page, the only way a tab knows its seat. @template P, S, V @returns {MiniEngine<P, S, V> | null} */
export function openRoom() {
  const session = loadSession(code, role);
  if (!session) {
    showError(new Error(t.openFromRoom));
    $('status').textContent = '';
    return null;
  }
  /** @type {MiniEngine<P, S, V>} */
  const client = new MiniEngine(session);
  client.on('error', showError);
  client.on('closed', reason => showError(new Error(t.closed[reason] ?? t.closedOther)));
  window.addEventListener('pagehide', () => client.close());
  window.addEventListener('pageshow', () => client.resume());
  showCode();
  return client;
}

function showCode() {
  $('invite-code').textContent = code;
  $('invite-label').textContent = fill(t.joinAt, { host: location.host });
  $('code').textContent = code; //@plain
  $('invite-qr').innerHTML = qrSvg(joinUrl(code)); //@ui
  if (role === 'display') $('code').textContent = code; //@ui
  else bindCopyCode($('code'), code, { copied: t.copied, copy: t.copyLink }); //@ui
  if (role !== 'display') bindQrDialog($('show-qr'), code, { close: t.close, scan: t.scan, showQr: t.showQrTitle }); //@ui
}

/** @typedef {{ busy: boolean, screen: boolean }} Page screen: this page is the TV or the shared screen. */

/** @template P, S, V @param {MiniEngine<P, S, V>} client @param {(room: Snapshot<P, S, V>, page: Page) => void} render @param {{ minPlayers: number }} options */
export function mount(client, render, { minPlayers }) {
  const draw = () => {
    const room = client.room;
    if (!room) return;
    const screen = role === 'display' || (role === 'host' && !room.you.player_id);
    showParts(screen);
    drawLobby(client, room, minPlayers, screen);
    drawPlayers(room);
    render(room, { busy, screen });
    if (!client.connected) $('status').textContent = t.reconnecting;
    $('away').textContent = role !== 'host' && !room.host_connected && room.status === 'running' ? t.hostAway : '';
    keepScreenOn(room.status === 'running');
  };
  redraw = draw;
  client.on('snapshot', draw);
  client.on('status', draw);
  document.addEventListener('visibilitychange', draw);
  button('ready').onclick = () => run(() => client.ready(!client.room?.players.find(player => player.id === client.room?.you.player_id)?.ready));
  if (role === 'host') {
    button('start').onclick = () => run(() => enqueue(() => client.lifecycle('running')));
    button('again').onclick = () => run(() => enqueue(() => client.lifecycle('lobby')));
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let shown;
  client.on('achievement', ({ player_id, achievement }) => {
    const mine = player_id === client.room?.you.player_id;
    if (document.body.dataset.view === 'seat' && !mine) return;
    const name = client.room?.players.find(player => player.id === player_id)?.name ?? '';
    $('achievement').textContent = mine
      ? fill(t.earnedYou, { title: achievement.title, description: achievement.description })
      : fill(t.earned, { name, title: achievement.title });
    clearTimeout(shown);
    shown = setTimeout(() => { $('achievement').textContent = ''; }, 6000);
  });
}

/** data-for="seat" is a phone or the host who plays along, "screen" the TV or shared screen. @param {boolean} screen */
function showParts(screen) {
  const view = screen ? 'screen' : 'seat';
  document.body.dataset.view = view;
  document.querySelectorAll('[data-for]').forEach(part => {
    const wanted = (part.getAttribute('data-for') ?? '').split(' ');
    /** @type {HTMLElement} */ (part).hidden = !wanted.includes(view) && !wanted.includes(role);
  });
}

/** The host's own seat is always ready. @template P, S, V @param {MiniEngine<P, S, V>} client @param {Snapshot<P, S, V>} room @param {number} minPlayers @param {boolean} screen */
function drawLobby(client, room, minPlayers, screen) {
  const lobby = room.status === 'lobby';
  const me = room.players.find(player => player.id === room.you.player_id);
  const enough = room.players.length >= minPlayers;
  const allReady = room.players.every(player => player.id === room.host_player_id || player.ready);
  const ready = button('ready');
  ready.hidden = role !== 'player' || !lobby;
  ready.textContent = me?.ready ? t.readyDone : t.ready;
  ready.classList.toggle('is-primary', !me?.ready);
  ready.classList.toggle('is-ready', Boolean(me?.ready));
  ready.disabled = busy || !client.connected;
  button('start').hidden = role !== 'host' || !lobby;
  button('start').disabled = busy || !client.connected || !enough || !allReady;
  button('again').hidden = role !== 'host' || room.status !== 'finished';
  button('again').disabled = busy || !client.connected;
  $('invite').hidden = !lobby || !screen;
  if (!lobby) return;
  if (role === 'host') $('status').textContent = !enough ? fill(t.needPlayers, { n: minPlayers }) : allReady ? t.everyoneReady : t.waitForReady;
  else if (role === 'player') $('status').textContent = me?.ready ? t.waitForStart : t.getReady;
  else $('status').textContent = t.waitForStart;
}

/** @template P, S, V @param {Snapshot<P, S, V>} room */
function drawPlayers(room) {
  const list = $('players');
  list.hidden = room.status !== 'lobby' || !room.players.length;
  list.replaceChildren(...room.players.map(player => {
    const item = document.createElement('li');
    const presence = document.createElement('span');
    presence.className = player.connected ? 'me-presence is-online' : 'me-presence';
    presence.title = player.connected ? t.online : t.offline;
    const name = document.createElement('span');
    name.className = 'me-name';
    name.textContent = player.id === room.you.player_id ? fill(t.nameYou, { name: player.name }) : player.name;
    const ready = document.createElement('span');
    ready.className = player.ready ? 'me-ready is-ready' : 'me-ready';
    ready.textContent = player.ready ? t.isReady : t.notReady;
    item.append(presence, name, ready);
    return item;
  }));
}

/** @param {HTMLElement} list @param {{ id: string, name: string }[]} players @param {Record<string, number>} scores @param {{ you?: string | null, turn?: string | null, sorted?: boolean }} [options] */
export function drawScores(list, players, scores, { you = null, turn = null, sorted = false } = {}) {
  const rows = players.map(player => ({ player, score: scores[player.id] ?? 0 }));
  if (sorted) rows.sort((a, b) => b.score - a.score);
  list.replaceChildren(...rows.map(({ player, score }) => {
    const item = document.createElement('li');
    if (player.id === turn) item.className = 'is-turn';
    const name = document.createElement('span');
    name.className = 'me-name';
    name.textContent = player.id === you ? fill(t.nameYou, { name: player.name }) : player.name;
    const points = document.createElement('span');
    points.className = 'me-score';
    points.textContent = String(score);
    item.append(name, points);
    return item;
  }));
}

/** @type {WakeLockSentinel | null} */
let lock = null;
let asking = false;
/** Since Mini Engine 0.6.1 the room page keeps the screen on itself; me dev and older servers need this. @param {boolean} running */
async function keepScreenOn(running) {
  if (!running || document.visibilityState !== 'visible') {
    lock?.release().catch(() => {});
    lock = null;
    return;
  }
  if (lock || asking || !('wakeLock' in navigator)) return;
  asking = true;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch {
    lock = null;
  } finally {
    asking = false;
  }
}
