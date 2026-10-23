// Who presses first after the signal? Presses travel as realtime events; the host ranks them by the engine's ts and publishes the result.
import { $, button, drawScores, enqueue, mount, openRoom, refresh, role, showError } from './room.js';
import { COLLECT_MS, GIVE_UP_MS, MIN_PLAYERS, RESULT_MS, WAIT_MS, addPress, decide, go, newGame, nextRound } from './logic.js';
import { fill, t } from './texts.js';
/** @import { MiniEngine, Snapshot } from '/sdk/mini-engine.js' */
/** @import { Game, Press } from './logic.js' */

/** @typedef {{ rounds: number }} Settings Mirrors settings_schema in manifest.json. */
/** @typedef {Partial<Game>} PublicState Everyone sees this; each new game starts as {}. */
/** @typedef {Snapshot<PublicState, Settings>} Room */

/** @type {MiniEngine<PublicState, Settings> | null} */
const client = openRoom();
if (client) {
  /** @param {Room} room */
  const gameOf = room => (room.public_state.phase ? /** @type {Game} */ (room.public_state) : null);
  /** @param {Room} room @param {Game} game */
  const publish = (room, game) => client.setState({ expected_version: room.version, public_state: game });

  if (role === 'host') {
    // Presses live only in the host's memory until it publishes the decision.
    /** @type {{ round: number, open: boolean, presses: Press[], early: string[] }} */
    const heard = { round: 0, open: false, presses: [], early: [] };
    let timer = 0;
    let planned = '';
    /** Runs the task later, inside the queue, only if the game is still at the same step. @param {string} key @param {(room: Room, game: Game) => Promise<unknown>} task @param {number} wait */
    const later = (key, task, wait) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => enqueue(async () => {
        const room = client.room;
        const game = room && gameOf(room);
        if (room?.status === 'running' && game && `${game.phase}:${game.round}` === key) await task(room, game);
      }), wait);
    };
    /** @param {Game} game */
    const plan = game => {
      const key = `${game.phase}:${game.round}`;
      if (key === planned) return;
      planned = key;
      if (heard.round !== game.round) Object.assign(heard, { round: game.round, open: game.phase !== 'wait', presses: [], early: [] });
      if (game.phase === 'wait') {
        later(key, (room, now) => {
          heard.open = true;
          return publish(room, go(now));
        }, WAIT_MS.min + Math.random() * (WAIT_MS.max - WAIT_MS.min));
      } else if (game.phase === 'go') {
        later(key, (room, now) => publish(room, decide(now, heard.presses, heard.early)), GIVE_UP_MS);
      } else if (game.phase === 'result') {
        later(key, async (room, now) => {
          const next = nextRound(now);
          await publish(room, next);
          if (next.phase === 'done') await client.lifecycle('finished');
        }, RESULT_MS);
      }
    };

    client.on('snapshot', () => enqueue(async () => {
      const room = client.room;
      if (!room || room.status !== 'running') return;
      const game = gameOf(room);
      if (game) return plan(game);
      await publish(room, newGame(room.players.map(player => player.id), room.settings.rounds));
    }));

    // from and ts are set by the engine; data comes from a phone and is checked like an action.
    client.realtime.on('press', (data, from, ts) => {
      const room = client.room;
      const game = room && gameOf(room);
      const round = data && typeof data === 'object' && !Array.isArray(data) ? data.round : null;
      const id = from.player_id;
      if (!room || !game || room.status !== 'running' || round !== heard.round || game.round !== heard.round) return;
      if (!id || !room.players.some(player => player.id === id)) return;
      if (!heard.open) {
        if (!heard.early.includes(id)) heard.early.push(id);
        return;
      }
      if (heard.early.includes(id) || heard.presses.some(press => press.player_id === id)) return;
      heard.presses = addPress(heard.presses, id, ts);
      if (heard.presses.length === 1) later(`go:${heard.round}`, (now, current) => publish(now, decide(current, heard.presses, heard.early)), COLLECT_MS);
    });
  }

  /** @type {{ round: number, early: boolean } | null} */
  let pressed = null;
  button('buzz').onclick = () => {
    const game = client.room && gameOf(client.room);
    if (!game || (game.phase !== 'wait' && game.phase !== 'go') || pressed?.round === game.round) return;
    // The host plays along with echo, so its own press reaches its referee with the engine's ts too.
    if (!client.realtime.emit('press', { round: game.round }, { echo: role === 'host' })) return showError(new Error(t.errors.not_connected));
    pressed = { round: game.round, early: game.phase === 'wait' };
    refresh();
  };

  /** @param {Room} room @param {import('./room.js').Page} page */
  const render = (room, page) => {
    const game = gameOf(room);
    const me = room.you.player_id ?? '';
    const name = (/** @type {string | null} */ id) => room.players.find(player => player.id === id)?.name ?? '';
    $('rules').textContent = fill(t.rules, { rounds: room.settings.rounds });
    $('rules').hidden = room.status !== 'lobby';
    $('scores').hidden = !game || game.phase === 'go' || game.phase === 'result' || (game.phase === 'wait' && !page.screen);
    $('order').hidden = !game || game.phase !== 'result';
    const buzz = button('buzz');
    buzz.hidden = !game || game.phase === 'done' || game.phase === 'result';
    if (!game) {
      $('headline').textContent = t.headline;
      $('progress').textContent = '';
      return;
    }
    const mine = pressed?.round === game.round ? pressed : null;
    $('progress').textContent = game.phase === 'done' ? '' : fill(t.progress, { n: game.round, total: game.rounds });
    buzz.classList.toggle('is-go', game.phase === 'go');
    buzz.textContent = mine ? (mine.early || game.early.includes(me) ? t.tooEarly : t.pressed) : game.phase === 'go' ? t.press : t.wait;
    buzz.disabled = Boolean(mine) || page.busy || !client.connected;
    const winner = game.winner && name(game.winner);
    $('headline').textContent =
      game.phase === 'wait' ? t.waitTitle
      : game.phase === 'go' ? t.goTitle
      : game.phase === 'result' ? (winner ? fill(t.fastest, { name: winner }) : t.nobody)
      : t.final;
    $('status').textContent =
      game.phase === 'wait' ? (mine?.early ? t.earlyNote : page.screen ? t.waitScreen : t.waitSeat)
      : game.phase === 'go' ? (mine ? t.pressedNote : t.goNote)
      : game.phase === 'result' ? (game.winner === me ? t.youWon : game.early.length ? fill(t.earlyList, { names: game.early.map(name).join(', ') }) : '')
      : fill(t.best, { names: room.players.filter(player => (game.scores[player.id] ?? 0) === Math.max(0, ...Object.values(game.scores))).map(player => player.name).join(', ') });
    const first = game.order[0]?.ts ?? 0;
    $('order').replaceChildren(...game.order.map((press, index) => {
      const item = document.createElement('li');
      if (index === 0) item.className = 'is-turn';
      const who = document.createElement('span');
      who.className = 'me-name';
      who.textContent = name(press.player_id);
      const gap = document.createElement('span');
      gap.className = 'me-score';
      gap.textContent = index === 0 ? '' : `+${press.ts - first} ms`;
      item.append(who, gap);
      return item;
    }));
    drawScores($('scores'), room.players, game.scores, { you: room.you.player_id, sorted: game.phase === 'done' });
  };

  mount(client, render, { minPlayers: MIN_PLAYERS });
  client.connect();
}
