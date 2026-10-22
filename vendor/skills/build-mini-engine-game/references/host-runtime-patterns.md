# Host-runtime patterns

The scaffolded vote game (`assets/app.js`) is the reference implementation of the queue, ready/start flow and rendering. These recipes extend it. Code is plain JavaScript with JSDoc types, checked by the game's `jsconfig.json`.

## 1. Model state in three layers plus a phase

| Layer | Who receives it | Put here |
| --- | --- | --- |
| `public_state` | host, players, display | phase, round counter, who has submitted (booleans), scores, revealed results |
| `host_state` | host only | secret choices of everyone, answers from `data.json`, internal bookkeeping |
| `player_states[playerId]` | host + that player (as `room.private_state`) | the player's own secret: their pick, hand, role card |

The engine starts every lobby with `public_state = {}`, `host_state = null`, `player_states = {}`. `lifecycle('running')` does **not** initialise anything: the host must publish the first game state after the room starts. All of it must fit in 64 KiB together.

## 2. Pure rules in `assets/logic.js`

A complete example for a "pick a secret number, closest to 2/3 of the mean wins" game:

```js
/** @typedef {{ phase: 'choosing' | 'revealed', round: number, rounds: number, submitted: Record<string, boolean>, scores: Record<string, number>, last: null | { picks: Record<string, number>, target: number, winners: string[] } }} GameState */
/** @typedef {{ picks: Record<string, number> }} Secrets */

/** @param {string[]} playerIds @param {number} rounds @returns {{ game: GameState, secrets: Secrets }} */
export function newGame(playerIds, rounds) {
  return {
    game: { phase: 'choosing', round: 1, rounds, submitted: {}, last: null, scores: Object.fromEntries(playerIds.map(id => [id, 0])) },
    secrets: { picks: {} },
  };
}

/** Returns null when the move is not allowed, so the caller can ignore it. @param {GameState} game @param {Secrets} secrets @param {string} playerId @param {unknown} value */
export function pick(game, secrets, playerId, value) {
  if (game.phase !== 'choosing' || typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) return null;
  return { game: { ...game, submitted: { ...game.submitted, [playerId]: true } }, secrets: { picks: { ...secrets.picks, [playerId]: value } } };
}

/** Moves the secrets into public view and scores the round. @param {GameState} game @param {Secrets} secrets */
export function reveal(game, secrets) {
  const entries = Object.entries(secrets.picks);
  const target = entries.length ? (2 / 3) * (entries.reduce((sum, [, value]) => sum + value, 0) / entries.length) : 0;
  const best = Math.min(...entries.map(([, value]) => Math.abs(value - target)));
  const winners = entries.filter(([, value]) => Math.abs(value - target) === best).map(([id]) => id);
  const scores = { ...game.scores };
  for (const id of winners) scores[id] = (scores[id] ?? 0) + 1;
  return { game: { ...game, phase: /** @type {const} */ ('revealed'), scores, last: { picks: secrets.picks, target, winners } }, secrets };
}

/** @param {GameState} game @returns {{ game: GameState, secrets: Secrets }} */
export function nextRound(game) {
  return { game: { ...game, phase: 'choosing', round: game.round + 1, submitted: {}, last: null }, secrets: { picks: {} } };
}
```

Test it with Node's built-in runner from the game directory (`node --test tests/*.test.mjs`, Node 22+; `.js` files with `import`/`export` load as ES modules):

```js
// tests/logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, pick, reveal, nextRound } from '../assets/logic.js';

test('a round scores the pick closest to 2/3 of the mean', () => {
  let { game, secrets } = newGame(['a', 'b'], 3);
  assert.equal(pick(game, secrets, 'a', 0), null);
  ({ game, secrets } = pick(game, secrets, 'a', 20));
  ({ game, secrets } = pick(game, secrets, 'b', 40));
  const result = reveal(game, secrets);
  assert.deepEqual(result.game.last?.winners, ['a']);
  assert.equal(result.game.scores.a, 1);
  assert.equal(nextRound(result.game).game.round, 2);
});
```

Keep `logic.js` free of DOM and SDK imports so the tests run in Node. Remember `assets/` is public: rules may be public, secrets may not.

## 3. Host reducer

`run`, `showError`, `button`, `role` and `session` are the helpers at the top of the scaffolded `assets/app.js`.

```js
import { MiniEngine, loadSession } from '/sdk/mini-engine.js';
import { newGame, pick, reveal, nextRound } from './logic.js';
/** @import { Snapshot } from '/sdk/mini-engine.js' */
/** @import { GameState, Secrets } from './logic.js' */
/** @typedef {{ rounds: number }} Settings */
/** @typedef {Snapshot<Partial<GameState>, Settings>} Room */

/** @type {MiniEngine<Partial<GameState>, Settings>} */
const client = new MiniEngine(session);
/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/** Every host write goes through here, so each one reads the version the previous one produced. @param {() => Promise<unknown>} task */
const enqueue = task => (queue = queue.then(task).catch(showError));

/** Publish the complete next state; player_states is rebuilt from current players so departed seats never block setState. @param {Room} room @param {GameState} game @param {Secrets} secrets */
function publish(room, game, secrets) {
  const player_states = Object.fromEntries(room.players
    .filter(player => secrets.picks[player.id] !== undefined)
    .map(player => [player.id, { pick: secrets.picks[player.id] }]));
  return client.setState({ expected_version: room.version, public_state: game, host_state: secrets, player_states });
}
/** host_state is untyped JSON in the SDK; narrow it once. @param {Room} room @returns {Secrets} */
const secretsOf = room => /** @type {Secrets} */ (room.host_state ?? { picks: {} });

if (role === 'host') {
  // Snapshot-driven steps must be idempotent: decide from the snapshot whether a write is needed.
  client.on('snapshot', () => enqueue(async () => {
    const room = client.room;
    if (!room || room.status !== 'running' || room.public_state.phase) return;
    const { game, secrets } = newGame(room.players.map(player => player.id), room.settings.rounds);
    await publish(room, game, secrets);
  }));
  client.on('action', action => enqueue(async () => {
    const room = client.room;   // read inside the queue: the latest snapshot
    if (!room || room.status !== 'running' || !room.public_state.phase) return;
    if (!room.players.some(player => player.id === action.player_id)) return;
    const data = action.data && typeof action.data === 'object' && !Array.isArray(action.data) ? action.data : {};
    if (action.name !== 'pick') return;
    const next = pick(/** @type {GameState} */ (room.public_state), secretsOf(room), action.player_id, data.value);
    if (!next) return;                       // invalid or out of phase: ignore silently
    const everyone = room.players.every(player => next.game.submitted[player.id]);
    const result = everyone ? reveal(next.game, next.secrets) : next;
    await publish(room, result.game, result.secrets);
  }));
  button('next').onclick = () => run(() => enqueue(async () => {
    const room = client.room;
    if (!room || room.public_state.phase !== 'revealed') return;
    const { game, secrets } = nextRound(/** @type {GameState} */ (room.public_state));
    await publish(room, game, secrets);
  }));
}
```

Rules that keep this correct:

- **Validate everything** in the action: name, payload shape and range, `room.status`, your `phase`, sender is in `room.players`. `action.player_id` is set by the server and can be trusted; anything in `action.data` cannot.
- **Read `client.room` inside the queued task**, never from a closure captured earlier.
- Host buttons (`Reveal now`, `Next round`, `Finish`) also go through `enqueue` and call `publish` or `client.lifecycle(...)`.
- After a rejected write (`version_conflict`, `state_too_large`, …) do not blindly retry: the next snapshot or action re-evaluates from fresh state.
- Reloading the host tab is safe when all game state lives in the snapshot (the host receives `host_state` and `player_states` back). Do not keep game state only in variables or the DOM.
- The SDK never replays actions. Host-runtime actions carry no `action_id` to the host, so make each move idempotent by state (e.g. `pick` overwrites or rejects a second pick).

## 4. Rounds, scores and game end

- Rounds inside one game: keep `round`, `rounds`, `scores` in `public_state`; `Next round` clears `submitted`/secrets and increments `round`.
- Final standings: publish the result, then `client.lifecycle('finished')`. `finished` keeps the state visible.
- New game: `client.lifecycle('lobby')` wipes all state and readiness; players press ready again; the host starts; the snapshot handler publishes `newGame`.
- Host-runtime scores are not written to account statistics (only built-in server games feed `/accounts/stats`).

## 5. Players joining and leaving

- Without late join (`supports_late_join: false`) the player list is fixed once running, except for departures (leave or kick).
- Departed players disappear from `room.players`. Compute "everyone has submitted" over current `room.players`, and rebuild `player_states` from them (recipe above) — the engine rejects `player_states` keys of unknown players.
- With late join enabled, new players appear while `running`: give them a neutral state (score 0, not submitted) instead of assuming they were there from the start.
- If the departed player held a key secret (the spy, the dealer, the one who knows the answer), the round cannot finish fairly: detect it in the snapshot handler and offer the host a clear "re-deal / skip round" action, or resolve it automatically.
- `room.players[].connected` is presence. Offer the host a manual "reveal now / skip" for players whose phone went to sleep instead of waiting forever.

## 6. Player side

```js
/** @param {number} value */
const sendPick = value => run(() => client.action('pick', { value }));
```

- Disable the control while the request is pending and once `room.public_state.submitted?.[room.you.player_id ?? '']` is true.
- The ack means "queued at the host". Show "Sent — waiting for the host" until a snapshot confirms it.
- Read your own secret from `room.private_state` (typed as the third `MiniEngine` generic, e.g. `MiniEngine<Partial<GameState>, Settings, { pick?: number } | null>`).
- `host_offline` errors: show "The host is away; try again shortly". Nothing was queued.
- Action names: 1–64 of `A–Z a–z 0–9 _ . -`; action data ≤ 8 KiB.

## 7. Opening the shared display from the host page

The room creator's session (saved by `/demo`) usually contains `display_token`. Open the display in a new tab from a click handler (open the window synchronously, or the popup is blocked):

```js
import { ApiClient, saveSession } from '/sdk/mini-engine.js';

button('open-display').onclick = () => {
  const target = window.open('about:blank', '_blank');
  if (!target) return showError(new Error('Allow pop-ups to open the shared screen.'));
  target.opener = null;
  run(async () => {
    if (!session.display_token) {
      // Rotates the display credential: an already open display is signed out.
      session.display_token = (await new ApiClient().displayToken(session.code, session.token)).token;
      saveSession(session);
    }
    target.location.href = `/room/${session.code}/display#${encodeURIComponent(session.display_token)}`;
  });
};
```

Hide the button when `room.config?.display_enabled === false`. The token travels in the URL fragment; the room shell stores it and strips it before loading the game. For a TV, open that URL on the TV's browser instead (copy it from the host).

## 8. Timers

There are no server timers for custom games. The host tab runs `setTimeout` and publishes the phase change through `enqueue`. Device clocks differ, so publish a deadline as information but let the host decide when time is up; show countdowns as approximate.
