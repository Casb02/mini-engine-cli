# SDK API for game pages

Game pages import the bundle the engine serves: `import { … } from '/sdk/mini-engine.js'`. The full typed surface is the single file `types/mini-engine.d.ts` (copied into every scaffolded game). When in doubt, read that file — it is the contract. Mini Engine and `me dev` also serve it at `/sdk/mini-engine.d.ts`. The routes and WebSocket messages underneath are documented at https://docs.miniengine.nl/api/overzicht.html and in the public API reference PDF (https://docs.miniengine.nl/downloads/MiniEngine-API-v0.6.pdf).

## Session → client

```js
import { MiniEngine, loadSession } from '/sdk/mini-engine.js';
const role = /** @type {import('/sdk/mini-engine.js').Role} */ (document.body.dataset.role); // 'host' | 'player' | 'display'
const code = new URLSearchParams(location.search).get('room') || '';
const session = loadSession(code, role);          // null when the page was not opened through the room launcher
const client = new MiniEngine(session).connect(); // after the null check
```

`/home` and the room shell save credentials as `sessionStorage['mini-engine:CODE:ROLE']` (`{code, token, role, player_id?, display_token?}`); the game iframe gets only `?room=CODE`. Never put tokens in query strings or logs.

## `MiniEngine<PublicState, Settings, PrivateState>`

| Member | Who | Notes |
| --- | --- | --- |
| `connect()` / `resume()` | all | Returns the client. Reconnects with backoff; `connected` turns true only after the first snapshot. |
| `room` | all | Latest snapshot (`null` before the first one). |
| `on(event, fn)` / `once(event, fn)` | all | Returns an unsubscribe function. Events: `snapshot` (room), `action` (host only: `{player_id, name, data}`), `status` (`connecting/connected/reconnecting/disconnected`), `error` (`MiniEngineError`), `closed` (terminal reason), `throttled` (`{dropped}`: realtime messages the engine dropped), `achievement` (`{player_id, achievement: {id, title, description}}`, first time only, to everyone). |
| `waitForSnapshot(predicate?, {timeout?, signal?})` | all | Resolves with a matching current/future snapshot. |
| `ready(ready = true)` | players | Lobby only (`room_started` otherwise). A host without a seat (`moderator`, `tv`) has no readiness. A host who plays along does not need it: its seat counts as ready (`ready()` from it only changes the flag). |
| `action(name, data = {}, {actionId?})` | **players only** in custom games | The host gets `forbidden`, also when it plays along: it applies its own moves with `setState`. Name: 1–64 of `A-Za-z0-9_.-`; data: JSON ≤ 8 KiB. Fails with `host_offline` if the host tab is not connected. Ack = queued at host. |
| `setState({expected_version, public_state, host_state?, player_states?})` | host | Replaces all state. Omitted `host_state` → `null`, omitted `player_states` → `{}`. ≤ 64 KiB total. Unknown player ids are rejected. |
| `lifecycle('running' / 'finished' / 'lobby')` | host | Only `lobby→running→finished→lobby`; `running` needs every player ready except the host's own seat (`players_not_ready`); `lobby` wipes state. |
| `setSettings(settings)` | host | Whole object, schema-validated, uses the current version. |
| `configure({display_enabled?, allow_late_join?})` | host, lobby | Host mode cannot change. |
| `award(playerId, achievementId)` | host | 0.5+. Grants a declared achievement; see "Achievements" below. Ack also when the player already had it. |
| `realtime.emit(channel, data = null, {to?, echo?})` | all | 0.5+. Fire-and-forget event; returns `false` when not connected (dropped, never queued). `to`: `'all'` (default), `'host'`, `'players'`, `'display'` or ≤ 16 player ids. The sender does not get its own event unless `echo: true`. |
| `realtime.on(channel \| '*', fn)` | all | `fn(data, from, ts, channel)`; `from` = `{role, player_id}` and `ts` (server receive time, ms) are set by the engine. Returns unsubscribe. |
| `realtime.set(key, value)` | all | This connection's latest-wins value; `null` deletes. Coalesced per key, sent at most every 33 ms (`new MiniEngine({..., realtime: {setInterval}})`). Does nothing while not connected. |
| `realtime.value(from, key)` | all | Current value from `'host'`, `'display'`, a player id or a `from` object; `undefined` if none. |
| `realtime.onValue(key \| '*', fn)` | all | `fn(value, from, ts, key)`; `value` is `null` when deleted, when its player left, or after a reset. Fires for current values after (re)connecting. Your own `set()` also fires your own handlers immediately (local echo, `ts` = this device's clock): skip `from.player_id === myId` when you only draw others, or a render that calls `set()` loops. |
| `realtime.reset()` | host | Clears every value in the room; values the host sets afterwards are kept. |
| `close()` | all | Stops reconnecting; call on `pagehide`, `resume()` on `pageshow` (scaffold does this). |

Outstanding requests reject on disconnect or timeout (`request_timeout`, `disconnected`). The SDK **never replays** a command; after an uncertain failure, look at the next snapshot before acting again.

## Realtime (0.5+)

Events and values are never stored, versioned or put in a snapshot, and they can be lost under load (a slow receiver skips them). They have no order relative to snapshots and acks: sort by `ts` when order matters. Names (`channel`, `key`): 1–64 of `A-Za-z0-9_.:-`; `data`/`value`: JSON ≤ 2 KiB. An invalid message gives an `error` event (`invalid_request`); the socket stays open. Per connection 60 realtime messages/s, bursts of 120, apart from the command budget; over it messages are dropped and `throttled` reports the count at most once per 5 s. Values: ≤ 64 keys per sender, ≤ 256 KiB per room. A player's values vanish when they leave; all values vanish when the room closes or the server restarts.

## Snapshot (`room`)

`code`, `game_id`, `status` (`lobby`/`running`/`finished`), `version`, `round_id`, `max_players`, `host_connected`, `players[]` (`{id, name, connected, ready, account_id?}` — a moderator is not in this list, a host who plays along is; `account_id` is `null` for guests), `host_player_id` (0.5.1+: the creator's seat when they play along, otherwise `null`; every role receives it), `settings`, `config` (`{host_mode, display_enabled, allow_late_join}`), `runtime`, `set` (0.5+: `{id, kind, title}` of the player-made set the room plays with, or `null`), `public_state`, `you` (`{role, player_id}`; `player_id` is `null` for a moderator and the display, and equals `host_player_id` for a host who plays along). Host only: `host_state`, `player_states`. Player: `private_state` (own entry of `player_states`, or `null`).

Presence, joins and readiness produce snapshots **without** a version bump: never drop a snapshot because its version is unchanged.

## HTTP helpers useful in games

```js
import { ApiClient, saveSession, removeSession, http } from '/sdk/mini-engine.js';
const api = new ApiClient();                       // same origin
await api.gameData(code, hostToken);               // private data.json, or the room's set (host token)
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
| `GET /api/v1/rooms/CODE/game-data` | host (others get 403) | `data.json`, or the room's set when it has one — what `api.gameData` calls. |
| `POST /api/v1/rooms/CODE/achievements` | host | 0.5+. Body `{player_id, achievement_id}`; answers `{player_id, achievement, already_earned}`. Same rules as `client.award`. |

```js
await http(`/api/v1/rooms/${code}/leave`, { method: 'POST', token: session.token }); // resolves to null on 204
```

`gameData` returns whatever JSON is in `data.json`, untyped: validate its shape once after loading. When the room was created with a set (`room.set` is not `null`), it returns that set's content instead, in the shape of the set kind's schema.

## Achievements (0.5+)

`client.award(playerId, achievementId)` (host) is refused unless: the room is a browser-host room (`forbidden` otherwise) that is `running` or `finished` (`game_not_running`); the player is in `room.players` (`player_not_found`) and has an account (`not_eligible`); the id is declared in the release the room is pinned to (`achievement_unknown`); the room was created by a logged-in host and the player's account is not that host's account (`not_eligible`), except on the host's own seat when it plays along (0.5.1+) and in `tv` rooms, where the TV is a device (0.5.2+); and the room has awarded fewer than 30 in the last minute (`rate_limit`). The engine takes the account from its own seat record. Awarding twice changes nothing and still acks; the `achievement` event goes out only the first time. These awards are stored as `source: "game"` and shown apart from server-verified ones.

## Account routes (0.5+)

These need the account token (`new ApiClient({accountToken})`), which game pages normally do not have; players manage sets at `/home/sets`. `api.achievements(token?)` → `{achievements: [{game_id, game_title, id, title, description, source, awarded_at}]}`, newest first. Sets: `listSets({game_id?, kind?})` (without content), `getSet(id)`, `createSet({game_id, kind, title, data})`, `updateSet(id, {title, data})`, `deleteSet(id)`; title 1–80 characters, data ≤ 64 KiB, ≤ 50 sets per account. `createRoom({game_id, set_id})` plays a room with one of the account's sets.

Images for image fields (engine 0.8+, same account token):

| Method | Route | Result |
| --- | --- | --- |
| `uploadMedia(file, {contentType?})` | `POST /api/v1/accounts/media` | `file`: `Blob`, `ArrayBuffer` or `Uint8Array`, sent as the raw body (no multipart, no JSON) with `contentType` or the Blob's type. → `{media, used_bytes, limit_bytes}`. |
| `listMedia()` | `GET /api/v1/accounts/media` | `{media: MediaItem[], used_bytes, limit_bytes, request}`, newest first. `request`: the latest `MediaRequest` or `null` (engine 0.8.1+). |
| `requestMediaSpace({message?})` | `POST /api/v1/accounts/media/requests` | Engine 0.8.1+ (older: 404). Asks the admins for space; `message` ≤ 500 characters (else 400 `invalid_request`). → `{request}`. Once per 7 days, sooner 429 `media_request_wait`. |
| `deleteMedia(id)` | `DELETE /api/v1/accounts/media/{id}` | `null`. 409 `media_in_use` while a set of the account uses it. |

`MediaItem` = `{id, url, content_type, width, height, size, created_at}`. `url` (`/media/<id>`) is the value for the image field and a public, same-origin `<img src>`. `limit_bytes` is this account's space and may be 0 (engine 0.8.1+: admins 1 GiB, accounts with a working dev key 250 MiB, others nothing, unless an admin chose an amount). `MediaRequest` = `{id, status: 'pending' | 'granted' | 'rejected', message, requested_at, next_request_at, decided_at, granted_mb}` (seconds since 1970; `decided_at`, `granted_mb` `null` until decided). Limits: `manifest-and-settings.md`, "Image fields".

## Errors

Every failure is a `MiniEngineError` with `.code` (and `.status` for HTTP). Codes you will meet: `host_offline`, `version_conflict`, `players_not_ready`, `invalid_transition`, `room_started`, `state_too_large`, `rate_limit` (60 commands/s for players and displays, 240 for the host; realtime has its own budget), `not_connected`, `request_timeout`, `disconnected`, `forbidden`, `invalid_request`. Since 0.5 also `not_eligible`, `achievement_unknown`, `game_not_running`, `player_not_found` (awards) and `set_not_found`, `quota_sets`, `set_too_large`, `release_changed` (sets). Since 0.8 `media_too_large`, `media_unsupported`, `media_invalid`, `quota_media`, `media_in_use`, `media_not_found` (images) and `quota_set_media` (a set with too many or too large images); since 0.8.1 `media_request_wait` (asked for space within 7 days). Terminal `closed` reasons: `session_revoked`, `room_deleted`, `room_expired` (12 h idle), `session_replaced` (same seat opened elsewhere).

## Types in plain JavaScript

```js
/** @import { Snapshot } from '/sdk/mini-engine.js' */
/** @typedef {{ rounds: number }} Settings */
/** @typedef {{ phase?: 'choosing' | 'revealed', scores?: Record<string, number> }} PublicState */
/** @type {MiniEngine<PublicState, Settings, { pick?: number } | null>} */
const client = new MiniEngine(session);
```

The scaffold's `jsconfig.json` maps `/sdk/mini-engine.js` to the declarations with `checkJs` and `strict`; `npx -p typescript tsc -p jsconfig.json` checks the game. Keep these typedefs equal to what the host publishes.
