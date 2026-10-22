# SDK API for game pages

Game pages import the bundle the engine serves: `import { … } from '/sdk/mini-engine.js'`. The full typed surface is the single file `types/mini-engine.d.ts` (copied into every scaffolded game; in an engine checkout also `web/mini-engine.d.ts`). When in doubt, read that file — it is the contract. Engines with the declaration route also serve it at `/sdk/mini-engine.d.ts`.

## Session → client

```js
import { MiniEngine, loadSession } from '/sdk/mini-engine.js';
const role = /** @type {import('/sdk/mini-engine.js').Role} */ (document.body.dataset.role); // 'host' | 'player' | 'display'
const code = new URLSearchParams(location.search).get('room') || '';
const session = loadSession(code, role);          // null when the page was not opened through the room launcher
const client = new MiniEngine(session).connect(); // after the null check
```

`/demo` and the room shell save credentials as `sessionStorage['mini-engine:CODE:ROLE']` (`{code, token, role, player_id?, display_token?}`); the game iframe gets only `?room=CODE`. Never put tokens in query strings or logs.

## `MiniEngine<PublicState, Settings, PrivateState>`

| Member | Who | Notes |
| --- | --- | --- |
| `connect()` / `resume()` | all | Returns the client. Reconnects with backoff; `connected` turns true only after the first snapshot. |
| `room` | all | Latest snapshot (`null` before the first one). |
| `on(event, fn)` / `once(event, fn)` | all | Returns an unsubscribe function. Events: `snapshot` (room), `action` (host only: `{player_id, name, data}`), `status` (`connecting/connected/reconnecting/disconnected`), `error` (`MiniEngineError`), `closed` (terminal reason). |
| `waitForSnapshot(predicate?, {timeout?, signal?})` | all | Resolves with a matching current/future snapshot. |
| `ready(ready = true)` | players | Lobby only (`room_started` otherwise). A moderator host has no readiness. |
| `action(name, data = {}, {actionId?})` | **players only** in custom games | Name: 1–64 of `A-Za-z0-9_.-`; data: JSON ≤ 8 KiB. Fails with `host_offline` if the host tab is not connected. Ack = queued at host. |
| `setState({expected_version, public_state, host_state?, player_states?})` | host | Replaces all state. Omitted `host_state` → `null`, omitted `player_states` → `{}`. ≤ 64 KiB total. Unknown player ids are rejected. |
| `lifecycle('running' / 'finished' / 'lobby')` | host | Only `lobby→running→finished→lobby`; `running` needs every player ready (`players_not_ready`); `lobby` wipes state. |
| `setSettings(settings)` | host | Whole object, schema-validated, uses the current version. |
| `configure({display_enabled?, allow_late_join?})` | host, lobby | Host mode cannot change. |
| `close()` | all | Stops reconnecting; call on `pagehide`, `resume()` on `pageshow` (scaffold does this). |

Outstanding requests reject on disconnect or timeout (`request_timeout`, `disconnected`). The SDK **never replays** a command; after an uncertain failure, look at the next snapshot before acting again.

## Snapshot (`room`)

`code`, `game_id`, `status` (`lobby`/`running`/`finished`), `version`, `round_id`, `max_players`, `host_connected`, `players[]` (`{id, name, connected, ready, account_id?}` — the moderator is not in this list), `settings`, `config` (`{host_mode, display_enabled, allow_late_join}`), `runtime`, `public_state`, `you` (`{role, player_id}`; `player_id` is `null` for the moderator and display). Host only: `host_state`, `player_states`. Player: `private_state` (own entry of `player_states`, or `null`).

Presence, joins and readiness produce snapshots **without** a version bump: never drop a snapshot because its version is unchanged.

## HTTP helpers useful in games

```js
import { ApiClient, saveSession, removeSession, http } from '/sdk/mini-engine.js';
const api = new ApiClient();                       // same origin
await api.gameData(code, hostToken);               // private data.json (host token)
await api.displayToken(code, hostToken);           // rotate → { token } for /room/CODE/display#TOKEN
await api.roomInfo(code);                          // public: status, counts, config
await api.getRoom(code, roomToken);                // the snapshot for that token's role
```

Seat management has no `ApiClient` method; use `http` (it adds the bearer and throws `MiniEngineError`):

| Route | Token | Effect |
| --- | --- | --- |
| `POST /api/v1/rooms/CODE/leave` | player | Gives up the seat; 204, empty body. |
| `DELETE /api/v1/rooms/CODE/players/PLAYER_ID` | host | Kicks a player and revokes their token; 204. |
| `DELETE /api/v1/rooms/CODE` | host | Deletes the room for everyone; 204. |
| `GET /api/v1/rooms/CODE/game-data` | host (others get 403) | `data.json` — what `api.gameData` calls. |

```js
await http(`/api/v1/rooms/${code}/leave`, { method: 'POST', token: session.token }); // resolves to null on 204
```

`gameData` returns whatever JSON is in `data.json`, untyped: validate its shape once after loading.

## Errors

Every failure is a `MiniEngineError` with `.code` (and `.status` for HTTP). Codes you will meet: `host_offline`, `version_conflict`, `players_not_ready`, `invalid_transition`, `room_started`, `state_too_large`, `rate_limit` (60 commands/s for players and displays, 240 for the host), `not_connected`, `request_timeout`, `disconnected`, `forbidden`. Terminal `closed` reasons: `session_revoked`, `room_deleted`, `room_expired` (12 h idle), `session_replaced` (same seat opened elsewhere).

## Types in plain JavaScript

```js
/** @import { Snapshot } from '/sdk/mini-engine.js' */
/** @typedef {{ rounds: number }} Settings */
/** @typedef {{ phase?: 'choosing' | 'revealed', scores?: Record<string, number> }} PublicState */
/** @type {MiniEngine<PublicState, Settings, { pick?: number } | null>} */
const client = new MiniEngine(session);
```

The scaffold's `jsconfig.json` maps `/sdk/mini-engine.js` to the declarations with `checkJs` and `strict`; `npx -p typescript tsc -p jsconfig.json` checks the game. Keep these typedefs equal to what the host publishes.
