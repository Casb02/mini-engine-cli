// A skeleton to build on: lobby, start, one example move (tap) and an end. The host page is the referee.
import { $, button, drawScores, enqueue, mount, openRoom, role, run } from './room.js';
import { MIN_PLAYERS, newGame, tap } from './logic.js';
import { fill, t } from './texts.js';
/** @import { MiniEngine } from '/sdk/mini-engine.js' */
/** @import { Game } from './logic.js' */

/** @typedef {Record<string, never>} Settings Mirrors settings_schema in manifest.json. */
/** @typedef {Partial<Game>} PublicState Everyone sees this; each new game starts as {}. */

/** @type {MiniEngine<PublicState, Settings> | null} */
const client = openRoom();
if (client) {
  /** Host only, inside the queue: a player's tap or the host's own. @param {string} playerId */
  const applyTap = async playerId => {
    const room = client.room;
    if (!room || room.status !== 'running' || !room.public_state.taps) return;
    const next = tap(/** @type {Game} */ (room.public_state), playerId);
    if (next) await client.setState({ expected_version: room.version, public_state: next });
  };

  if (role === 'host') {
    client.on('snapshot', () => enqueue(async () => {
      const room = client.room;
      if (room?.status !== 'running' || room.public_state.taps) return;
      await client.setState({ expected_version: room.version, public_state: newGame(room.players.map(player => player.id)) });
    }));
    client.on('action', action => enqueue(async () => {
      if (action.name === 'tap') await applyTap(action.player_id);
    }));
    button('finish').onclick = () => run(() => enqueue(() => client.lifecycle('finished')));
  }

  button('tap').onclick = () => run(async () => {
    if (role !== 'host') return client.action('tap');
    const own = client.room?.you.player_id;
    if (own) await enqueue(() => applyTap(own));
  });

  mount(client, (room, page) => {
    const taps = room.public_state.taps;
    const mine = room.you.player_id ? taps?.[room.you.player_id] : undefined;
    $('headline').textContent = room.status === 'finished' ? t.over : t.headline;
    if (room.status === 'running') $('status').textContent = typeof mine === 'number' ? fill(t.tapped, { n: mine }) : t.running;
    if (room.status === 'finished') $('status').textContent = '';
    button('tap').hidden = room.status !== 'running' || !taps;
    button('tap').disabled = page.busy || !client.connected || !room.host_connected;
    button('finish').hidden = room.status !== 'running';
    button('finish').disabled = page.busy || !client.connected;
    $('scores').hidden = !taps;
    drawScores($('scores'), room.players, taps ?? {}, { you: room.you.player_id, sorted: room.status === 'finished' });
  }, { minPlayers: MIN_PLAYERS });
  client.connect();
}
