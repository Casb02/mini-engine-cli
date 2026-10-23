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

Snapshots arrive with object keys sorted (the engine and `me dev` serialize JSON that way), so never decide "has it changed?" with `JSON.stringify(a) === JSON.stringify(b)` against what you published: that is always different and republishes on every snapshot, forever. Compare the fields that matter, or use a key-order-independent compare.

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

- When the host plays along, its own moves go through the same rules and queue: see §11.
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

The room creator's session (saved by `/home`) usually contains `display_token`. Open the display in a new tab from a click handler (open the window synchronously, or the popup is blocked):

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

There are no server timers for custom games. The host tab runs `setTimeout` and publishes the phase change through `enqueue`. Device clocks differ, so publish a deadline as information but let the host decide when time is up; show countdowns as approximate. When the order of fast reactions matters (who pressed first), do not compare device clocks either: use the engine's realtime `ts` (§9).

## 9. Realtime: buzzers and positions (engine 0.5+)

`client.realtime` delivers small messages within milliseconds and never touches `room.version`, so it suits buzzers, reactions and live positions. Messages can be lost under load and have no order relative to snapshots. The rule: **realtime shows, state decides.** Whatever counts is decided by the host and published with `setState` through the queue.

### Buzzer

Every player emits a press. The engine adds `from` (who sent it) and `ts` (when the engine received it, in ms), so presses from different phones are compared on one clock. It is arrival time, not the moment of the tap: a phone on a slow connection loses a few milliseconds.

```js
// player.html side
button('buzz').onclick = () => {
  const room = client.room;
  if (!room || room.public_state.phase !== 'open') return;
  if (!client.realtime.emit('press', { question: room.public_state.question ?? null })) showError(new Error('Not connected. Try again in a moment.'));
};
```

```js
// host.html side
/** @type {{ question: number | null, presses: { player_id: string, ts: number }[], timer?: ReturnType<typeof setTimeout> }} */
const buzz = { question: null, presses: [] };
client.realtime.on('press', (data, from, ts) => {
  const room = client.room;
  const question = data && typeof data === 'object' && !Array.isArray(data) && typeof data.question === 'number' ? data.question : null;
  if (!room || room.public_state.phase !== 'open' || question !== room.public_state.question) return;
  if (!from.player_id || !room.players.some(player => player.id === from.player_id)) return;
  if (buzz.question !== question) Object.assign(buzz, { question, presses: [] });
  if (buzz.presses.some(press => press.player_id === from.player_id)) return;
  buzz.presses.push({ player_id: from.player_id, ts });
  buzz.timer ??= setTimeout(() => enqueue(async () => {
    buzz.timer = undefined;
    const room = client.room;
    if (!room || room.public_state.phase !== 'open' || room.public_state.question !== buzz.question) return;
    const order = [...buzz.presses].sort((a, b) => a.ts - b.ts);
    await publish(room, { ...room.public_state, phase: 'answering', buzzer: order[0]?.player_id, order }, secretsOf(room));
  }), 150);
});
```

- Accept a press only for the open question, from a seated player, once per player. Take the player and time from `from` and `ts`, never from `data`: `data` is client input, like action data.
- Wait a short moment (100–200 ms) after the first press, then sort by `ts`. Two presses can reach the host in a different order than the engine received them.
- The decision goes through `enqueue` and `setState`, so a reloaded host, a late display and the players all see the same winner. The collected presses live only in the host's memory; after a host reload, players simply press again.
- A lost press looks like no press. Keep the buzz button usable while the question is open (the host ignores a second press from the same player) and show "Pressed" next to it.
- The display can listen to the same `press` event to show the order at once, with the gap from the first press ("Sander +14 ms"), and switch to the published result when the snapshot arrives. Jeopardy, a built-in game, works this way.

### Live positions

Values are latest-wins per sender and key, and late joiners get the current ones. Use them for markers, cursors and karts.

```js
// player.html side: the SDK sends each key at most every 33 ms, however often you call set
board.addEventListener('pointermove', event => {
  if (event.buttons) client.realtime.set('pos', { x: event.offsetX / board.clientWidth, y: event.offsetY / board.clientHeight });
});
```

```js
// display.html side
/** @type {Map<string, { x: number, y: number }>} */
const positions = new Map();
let frame = 0;
client.realtime.onValue('pos', (value, from) => {
  if (!from.player_id) return;
  const point = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (point && typeof point.x === 'number' && typeof point.y === 'number') positions.set(from.player_id, { x: point.x, y: point.y });
  else positions.delete(from.player_id);
  frame ||= requestAnimationFrame(() => { frame = 0; draw(positions); });
});
```

- Send fractions of the board (0–1), not pixels: every screen has another size.
- One key sent at full speed uses about 30 of the 60 realtime messages per second a connection may send. Keep it to one moving key per player, or raise the interval with `new MiniEngine({ ...session, realtime: { setInterval: 66 } })`. If the `throttled` event fires, send less.
- `onValue` also fires for the values that were already there when the page connected or reconnected. A player who leaves comes back as `null` for each of their keys.
- At a new round the host calls `client.realtime.reset()` to clear everyone's values.
- When a position decides something (who reached the finish first), the host checks it with `client.realtime.value(playerId, 'pos')` or the player sends an action, and the host publishes the outcome with `setState`. Validate the value like action data.

## 10. Achievements (engine 0.5+)

Declare them in `manifest.json` (rules in `manifest-and-settings.md`):

```json
"achievements": [
  { "id": "drie-keer-raak", "title": "Drie keer raak", "description": "Win drie rondes in één spel." }
]
```

The host awards them when the rules decide, for example right after publishing the final result:

```js
/** Guests cannot earn achievements; a refusal never stops the game. @param {Room} room @param {GameState} game */
function awardWinners(room, game) {
  for (const player of room.players) {
    if (!player.account_id || (game.scores[player.id] ?? 0) < 3) continue;
    client.award(player.id, 'drie-keer-raak').catch(error => {
      if (!['not_eligible', 'rate_limit'].includes(error.code)) showError(error);
    });
  }
}
```

- Only the host awards, only while the room is `running` or `finished`: award before `lifecycle('lobby')`.
- Skip players whose `account_id` is `null`: guests never earn achievements.
- The engine also answers `not_eligible` when the room was created without logging in, or when another seat uses the host's own account (a moderator who also joined as a player). A host who plays along earns achievements on its own seat (`room.host_player_id`, engine 0.5.1+) like any player. In a `tv` room the TV is a device: a phone seat with the TV's account may earn them too (engine 0.5.2+). The snapshot does not show whether the host was logged in, so treat `not_eligible` as normal and never show it as an error.
- Awarding the same achievement again does nothing and still acks, so awarding at every finish is fine. At most 30 awards per room per minute: award only what was earned.
- Only ids declared in the release the room started with work (`achievement_unknown` otherwise). After adding one, upload and activate the release, then create a new room.
- The account page lists these awards apart from server-verified ones, under "Toegekend door eigen spellen". Make achievements about how someone played, not about anything that needs a referee you cannot trust.

Celebrate on every screen: the first time a player earns an achievement, every connection in the room receives the `achievement` event.

```js
client.on('achievement', ({ player_id, achievement }) => {
  const name = client.room?.players.find(player => player.id === player_id)?.name ?? 'A player';
  showNotice(`${name} earned ${achievement.title}`);
});
```

Like realtime, this event can be lost and is not in the snapshot: keep it a short, calm moment and never the only place where something important appears. With MiniEngineUI, see its achievement note.

## 11. Iedereen doet mee: the host plays along (engine 0.5.1+)

In a `playing` room the creator has a seat: `room.you.player_id` and `room.host_player_id` are that seat, and it is in `room.players`. The host page is still the referee, and the host connection still cannot send `action`s (`forbidden`). So the host's own move runs the same rules function as a player's action, inside the same queue, and is published with `setState`.

```js
/** One move for any seat, the host's own included. Call it only inside enqueue. @param {string} playerId @param {unknown} value */
async function applyPick(playerId, value) {
  const room = client.room;
  if (!room || room.status !== 'running' || !room.public_state.phase) return;
  if (!room.players.some(player => player.id === playerId)) return;
  const next = pick(/** @type {GameState} */ (room.public_state), secretsOf(room), playerId, value);
  if (!next) return;
  const everyone = room.players.every(player => next.game.submitted[player.id]);
  const result = everyone ? reveal(next.game, next.secrets) : next;
  await publish(room, result.game, result.secrets);
}

if (role === 'host') {
  client.on('action', action => enqueue(async () => {
    const data = action.data && typeof action.data === 'object' && !Array.isArray(action.data) ? action.data : {};
    if (action.name === 'pick') await applyPick(action.player_id, data.value);
  }));
}

/** The pick button on the host page and on player pages. @param {number} value */
const sendPick = value => run(async () => {
  if (role !== 'host') return client.action('pick', { value });
  const own = client.room?.you.player_id;
  if (own) await enqueue(() => applyPick(own, value));
});
```

- **Seats come from `room.players`.** It includes the host when `room.host_player_id` is set, so `newGame(room.players.map(player => player.id), …)`, turn order, scores and "everyone has submitted" need no special case.
- **Readiness**: the engine marks the host seat ready, also after `lifecycle('lobby')`. Hide the ready button on the host page, and leave the host seat out of a "can start" check: `room.players.every(player => player.id === room.host_player_id || player.ready)`.
- **In a party game the host page is the player's page.** Same layout, same order, same way to move as a phone. On top of that only what the game needs from the creator: "Start het spel" in the lobby instead of "Ik ben klaar", "Nieuw spel" afterwards, a quiet "Spel stoppen" link at the bottom, and game-specific steps (in a Gartic Phone-like game: walking through the final drawings). No console, no skip button, no cards for rules, players or the shared screen: the creator is a player like everyone else. A quiz master is the exception (`moderator`, a console).
- **One page, two views.** Keep the referee (queue, publish, actions, timers) in its own module and mount a view on the first snapshot by `room.config.host_mode`: the seat view for `playing` (the same module the player page uses), the shared-screen view for `tv` (§12).
- **The host's own secret**: the host receives every `player_states` entry; show only `room.player_states?.[room.you.player_id]` in its player area. The other secrets stay hidden (behind a toggle, or not shown at all).
- **Do not label the host as host** in a party game: the creator is one of the players. Other pages may say who starts: "Hessel start het spel als iedereen klaar is."
- **No kick, no leave** for the host seat: hide those buttons for `room.host_player_id`.
- Awards to the host's own seat work like any other (§10).

## 12. TV, offline players and the screen staying on (engine 0.5.2+)

**TV.** In a `tv` room the device that created the room is the TV: `room.you.player_id` and `room.host_player_id` are `null`, and every seat is a phone. Mount the shared-screen view on the host page: QR and code in the lobby, the game large, the scores. Add only "Start het spel" (enabled when `room.players.length >= min_players` and every seat is ready) and "Nieuw spel" afterwards. The referee runs exactly as in `playing`. A separate display is not needed: a group that wants a TV picks TV.

**Skip a player who is offline during their turn.** Phones lock while a player waits, so `connected: false` is normal between turns. Count only offline time within the turn: start a clock at the later of "the turn began" and "this player went offline", as the referee sees it. Stop it when they reconnect, and skip after 30 seconds. Never put the host's own seat on the clock. Keep the clock a pure function so it can be tested:

```js
export const OFFLINE_SKIP_MS = 30_000;
/** @typedef {{ turn: string, since: number | null }} OfflineClock */
/** @returns {OfflineClock | null} null when nobody can be skipped now */
export function offlineClock(clock, game, players, hostSeat, now) {
  if (game.phase === 'done' || game.turn === hostSeat) return null;
  const player = players.find(entry => entry.id === game.turn);
  if (!player) return null;
  if (player.connected) return { turn: game.turn, since: null };
  const same = clock?.turn === game.turn && clock.since !== null;
  return { turn: game.turn, since: same ? clock.since : now };
}
export const offlineDue = (clock, now) => clock?.since != null && now - clock.since >= OFFLINE_SKIP_MS;
```

The referee recomputes the clock on every snapshot, sets a timer to `since + OFFLINE_SKIP_MS` and, inside the queue, publishes the skip only if the clock is still due for that same turn.

**Keep the screen on.** While a game runs, the seat view and the TV view ask for a wake lock: phones lock less often, and the TV, which nobody touches and which is the referee, does not dim or sleep. Ask again when the page becomes visible, and ignore every failure:

```js
let lock = null;
const wanted = () => client.room?.status === 'running' && document.visibilityState === 'visible';
async function keepScreenOn() {
  if (!wanted()) { lock?.release().catch(() => {}); lock = null; return; }
  if (lock || !('wakeLock' in navigator)) return;
  try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch {}
}
client.on('snapshot', keepScreenOn);
document.addEventListener('visibilitychange', keepScreenOn);
```
