// Players take turns: roll as often as you dare, a 1 loses the turn's points. The host page is the referee: it throws the dice and skips players who are away.
import { $, button, drawScores, enqueue, mount, openRoom, role, run } from './room.js';
import { MIN_PLAYERS, OFFLINE_SKIP_MS, hold, newGame, offlineClock, offlineDue, roll, skip, sync } from './logic.js';
import { fill, t } from './texts.js';
/** @import { MiniEngine, Snapshot } from '/sdk/mini-engine.js' */
/** @import { Event, Game, OfflineClock } from './logic.js' */

/** @typedef {{ target: number }} Settings Mirrors settings_schema in manifest.json. */
/** @typedef {Partial<Game>} PublicState Everyone sees this; each new game starts as {}. */
/** @typedef {Snapshot<PublicState, Settings>} Room */

/** A fair die from the browser's crypto source; rejection sampling avoids a bias. */
function throwDie() {
  const byte = new Uint8Array(1);
  do crypto.getRandomValues(byte); while (byte[0] >= 252);
  return 1 + (byte[0] % 6);
}

/** @type {MiniEngine<PublicState, Settings> | null} */
const client = openRoom();
if (client) {
  /** @param {Room} room */
  const gameOf = room => (room.public_state.phase ? /** @type {Game} */ (room.public_state) : null);
  /** @param {Room} room @param {Game} game */
  const publish = (room, game) => client.setState({ expected_version: room.version, public_state: game });

  /** Host only, inside the queue: a move by whoever's turn it is, the host's own included. @param {string} playerId @param {string} name */
  const move = async (playerId, name) => {
    const room = client.room;
    const game = room && gameOf(room);
    if (!room || !game || room.status !== 'running') return;
    const next = name === 'roll' ? roll(game, playerId, throwDie()) : name === 'hold' ? hold(game, playerId) : null;
    if (next) await publish(room, next);
  };

  if (role === 'host') {
    /** @type {OfflineClock | null} */
    let clock = null;
    let clockTimer = 0;
    // A quiet room sends no snapshots, so a timer checks again when the clock would run out.
    /** @param {Room} room @param {Game} game */
    const watchOffline = async (room, game) => {
      clock = offlineClock(clock, game, room.players, room.host_player_id ?? null, Date.now());
      clearTimeout(clockTimer);
      if (offlineDue(clock, Date.now())) {
        clock = null;
        const next = skip(game);
        if (next) await publish(room, next);
        return;
      }
      if (clock?.since == null) return;
      clockTimer = window.setTimeout(() => enqueue(async () => {
        const now = client.room;
        const current = now && gameOf(now);
        if (now?.status === 'running' && current) await watchOffline(now, current);
      }), clock.since + OFFLINE_SKIP_MS - Date.now() + 50);
    };

    client.on('snapshot', () => enqueue(async () => {
      const room = client.room;
      if (!room || room.status !== 'running') return;
      const game = gameOf(room);
      const ids = room.players.map(player => player.id);
      if (!game) return publish(room, newGame(ids, room.settings.target, Math.floor(Math.random() * ids.length)));
      if (game.phase === 'done') return client.lifecycle('finished');
      const present = sync(game, ids);
      if (present !== game) return publish(room, present);
      await watchOffline(room, game);
    }));
    client.on('action', action => enqueue(() => move(action.player_id, action.name)));
  }

  /** @param {'roll' | 'hold'} name */
  const play = name => run(async () => {
    if (role !== 'host') return client.action(name);
    const own = client.room?.you.player_id;
    if (own) await enqueue(() => move(own, name));
  });
  button('roll').onclick = () => play('roll');
  button('hold').onclick = () => play('hold');

  mount(client, (room, page) => {
    const game = gameOf(room);
    const me = room.you.player_id ?? '';
    const name = (/** @type {string | null} */ id) => room.players.find(player => player.id === id)?.name ?? '';
    /** @type {Record<Event['kind'], string>} */
    const said = { rolled: t.rolled, bust: t.bust, held: t.held, skipped: t.skipped, won: t.won };
    $('rules').textContent = fill(t.rules, { target: room.settings.target });
    $('rules').hidden = room.status !== 'lobby';
    $('table').hidden = !game || game.phase === 'done';
    $('scores').hidden = !game;
    if (!game) {
      $('headline').textContent = t.headline;
      return;
    }
    const mine = game.phase === 'turn' && game.turn === me;
    $('headline').textContent = game.phase === 'done' ? fill(t.winner, { name: name(game.winner) }) : mine ? t.yourTurn : fill(t.theirTurn, { name: name(game.turn) });
    $('status').textContent = game.event ? fill(said[game.event.kind], { name: name(game.event.player), value: game.event.value }) : '';
    $('die').textContent = game.die === null ? '–' : String(game.die);
    $('pot').textContent = fill(t.pot, { n: game.pot });
    button('roll').hidden = !mine;
    button('hold').hidden = !mine;
    button('roll').disabled = page.busy || !client.connected || !room.host_connected;
    button('hold').disabled = button('roll').disabled || game.pot === 0;
    const seats = game.seats.map(id => room.players.find(player => player.id === id)).filter(player => player !== undefined);
    drawScores($('scores'), seats, game.scores, { you: room.you.player_id, turn: game.phase === 'turn' ? game.turn : null, sorted: game.phase === 'done' });
  }, { minPlayers: MIN_PLAYERS });
  client.connect();
}
