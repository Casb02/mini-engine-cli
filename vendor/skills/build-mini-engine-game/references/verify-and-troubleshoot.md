# Running, verifying and troubleshooting

## Quick loop without an engine: `me dev`

The Mini Engine CLI (0.5+) fakes the engine for `runtime: "host"` games, so you can play while you build:

```sh
cd <game directory>
me dev                          # --players 4, --set sets/test.json, --port 3170, --no-open
```

It checks `manifest.json` like `me game upload`, then opens one page with the host, the display and every player side by side; each seat runs on its own port, so each has its own session like a separate phone. Saving a file reloads the seats and keeps the room. Rooms, ready, state versions, actions, realtime, achievements (every player counts as logged in; awards appear in the terminal) and game data (`--set` swaps in a set file, validated against `set_kinds`) work as on the engine. Everything lives in memory.

Use it for the hand-played game and fast iteration. It is a fake: before you report done, still run the game once on a real engine (below, or an uploaded test release).

## Run the engine

From the engine checkout root (defaults are relative to the working directory):

```sh
cargo run                                   # or a built binary: ./target/debug/mini-engine
MINI_ENGINE_BIND=0.0.0.0:3000 cargo run     # phones on the same Wi-Fi: open http://<LAN-IP>:3000/home everywhere, host included
```

| Variable | Default |
| --- | --- |
| `MINI_ENGINE_BIND` | `127.0.0.1:3000` |
| `MINI_ENGINE_GAMES` | `games` |
| `MINI_ENGINE_WEB` | `web` |
| `MINI_ENGINE_DB` | `data/mini-engine.sqlite` (use a temp path for throwaway test runs) |

Games are loaded once at startup: **restart after every change under `games/`** (CSS/JS too — assets are held in memory). If the engine exits at startup, the message names the problem (e.g. `Invalid manifest for <id>: …`, `Unsupported settings schema feature: pattern`, `Manifest id must match its package directory.`, `A required game role HTML file is missing.`, `Invalid runtime or unsupported host modes.`). Check `curl -s localhost:3000/api/v1/games` lists your game.

## Static checks (fast, run first)

```sh
cd games/<id>
npx -p typescript tsc -p jsconfig.json   # SDK misuse, typos in state/settings fields (downloads TypeScript;
                                         # offline: node <sdk>/node_modules/typescript/bin/tsc -p jsconfig.json)
node --test tests/*.test.mjs             # pure rules in assets/logic.js
```

## Play it by hand

1. Open `http://localhost:3000/home`, pick the game, fill in your name and create a room ("Iedereen doet mee", then again with "TV" when the game offers it). This tab becomes the host at `/room/CODE/host`; with "Iedereen doet mee" it is also your seat and must look like a player's phone, with "TV" it is the shared screen.
2. For each player open a **new** tab in a separate browser profile/private window or another device, open `/home`, enter the room code, then a unique player name. The tab becomes `/room/CODE/player`. Do not duplicate tabs: `sessionStorage` (where the seat credentials live) is per tab and is copied by "duplicate", which makes both tabs the same seat (`session_replaced`).
3. Open the display from your host page's button (see host-runtime-patterns §7) or browse to `/room/CODE/display#<display_token>`.
4. Play a complete game: ready → start → every round → finish → new game. Then: reload the host tab mid-round, lock a player's phone during their turn (they are skipped after 30 seconds in a turn-based game), and let a player leave mid-round (`POST /api/v1/rooms/CODE/leave` with their token — see sdk-api.md), including a player who holds a special secret role.

## Scripted play-through (Playwright)

For 3D games, launch Chromium with the GPU on: headless Chromium falls back to software rendering, and several WebGL pages then crawl at 10 fps (on macOS: `chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] })`).

`scripts/play.mjs` in this skill drives a real room: it creates the room over HTTP, injects each seat's credentials into its own browser context exactly like the launcher, opens `/room/CODE/<role>` (the real shell and iframe) and opens the display through its `#token` link. Copy it to `games/<id>/tests/play.mjs`, replace the game-specific block (it ships with steps for the scaffolded vote game), start the engine, then from the engine checkout:

```sh
npm ci                              # once; installs the engine's pinned Playwright
npx playwright install chromium     # once, if no browser is installed
node games/<id>/tests/play.mjs http://127.0.0.1:3000 /tmp/shots   # second argument: screenshot directory
```

Interact with game elements through `seat.game` (a frame locator into the game iframe). It saves phone- and TV-sized screenshots: look at them.

### Achievements

Achievements (engine 0.5+) only reach logged-in seats: guests never earn them, and a browser-host game can only award them in a room whose creator was logged in, to a player with another account. Give `post()` in `play.mjs` account tokens as its third argument:

```js
const account = name => post('/api/v1/accounts/login', { username: name, password: 'speel-mee-2026' });
const [hessel, dani] = await Promise.all(['hessel', 'dani'].map(account));
const host = await post('/api/v1/rooms', { game_id: gameId, name: 'Hessel', config: { host_mode: 'playing', display_enabled: true } }, hessel.token);
const players = [
  await post(`/api/v1/rooms/${host.code}/join`, { name: 'Dani' }, dani.token),
  await post(`/api/v1/rooms/${host.code}/join`, { name: 'Sander' }),
];
// …play until your rules award, then check Dani's account:
const { achievements } = await (await fetch(`${base}/api/v1/accounts/achievements`, { headers: { authorization: `Bearer ${dani.token}` } })).json();
assert.ok(achievements.some(item => item.id === 'drie-keer-raak' && item.source === 'game'));
```

- Create the accounts once with `POST /api/v1/accounts/register` (`{username, password, display_name, email}`; username 3–24 of `a-z 0-9 _`, password at least 10 characters), then log in on later runs. An engine allows five registrations per ten minutes per address, and an engine with Turnstile configured refuses scripted registrations, so test on a local engine. A confirmed email address is not needed.
- Sander stays a guest on purpose: he must get nothing, and nothing on screen may break.
- Hessel plays along, so his own seat (`host.player_id`) can earn achievements too (engine 0.5.1+). Another seat with his account cannot: do not also log Hessel in as a player in the same room. In a `tv` room (engine 0.5.2+) the TV is a device, so the TV's account may also earn on a phone seat.

## Privacy check

During an open round, fetch each role's snapshot and confirm secrets appear only where intended:

```sh
curl -s -H "Authorization: Bearer $PLAYER_TOKEN" localhost:3000/api/v1/rooms/$CODE   # no host_state/player_states; private_state = own only
curl -s -H "Authorization: Bearer $DISPLAY_TOKEN" localhost:3000/api/v1/rooms/$CODE  # no private data at all
```

Also search the player and display DOM for secret values. The host legitimately sees everything.

## Symptom → cause

| Symptom | Cause / fix |
| --- | --- |
| Game missing in `/home` | Engine not restarted, or directory name ≠ manifest `id`. |
| Engine will not start | Invalid package; read the startup error (see above). |
| Page says to open it from the room launcher | Opened `/api/v1/games/...` or the HTML directly; there is no session in this tab. Use `/home` or `/room/CODE/<role>`. |
| Console: `Refused to execute inline script` / `Refused to load the script` (CSP), or a 404 for a module | Inline script, inline event handler, external script or import map; or a wrong absolute asset path (`/games/<id>/assets/...`). |
| Player action error `host_offline` | Host tab closed, asleep or reconnecting. |
| Action acked but nothing changes | Host reducer ignored it: wrong name, payload shape, phase or status. Log in the host's `action` handler. |
| `version_conflict` | A host write used an old `room.version`: write outside the queue or a stale closure. |
| `invalid_request` "Player state bevat een onbekende speler" | `player_states` contains a player who left; rebuild it from `room.players`. |
| `players_not_ready` on start | Every other player must press ready. The host seat never blocks the start (a host who plays along counts as ready), and a moderator has no ready state. |
| `invalid_transition` | Lifecycle must go `lobby → running → finished → lobby`. |
| `state_too_large` | Published state > 64 KiB; keep history short, send ids not full objects. |
| Scores vanish after "new round" | `lifecycle('lobby')` wipes state; keep rounds inside `running`. |
| `session_replaced` / a tab goes silent | The same seat was opened in another tab. |
| Display shows nothing / "Open het scherm via de schermlink" | Display opened without the `#token` fragment, or display disabled for the room. |
| `realtime.emit` returns `false`, or realtime handlers never fire | Not connected yet (wait for the first snapshot), an engine older than 0.5, or the event targets someone else (`to`). The sender only gets its own event with `echo: true`. |
| `throttled` events | The page sends more than 60 realtime messages per second, more than 64 keys, or the room's values exceed 256 KiB. Send less, or raise `realtime.setInterval`. |
| `error` event `invalid_request` after a realtime call | Channel or key outside `A-Za-z0-9_.:-` (1–64), data over 2 KiB, or a bad `to`. |
| `award` fails with `not_eligible` | The player is a guest, the room was created without logging in, or another seat uses the host's own account. Expected; do not show it as an error. |
| The host's own move fails with `forbidden` | The host page called `action()`. Apply the move in the host queue with `setState` (host-runtime-patterns §11). |
| Engine refuses the package: `Invalid runtime or unsupported host modes.` | `hostless` in `host_modes`, an empty list, `playing` on an engine older than 0.5.1, or `tv` on an engine older than 0.5.2 (or with `runtime: "server"`). |
| `Invalid icon: …` | The `icon` path or file breaks a rule in `manifest-and-settings.md` (path under `assets/`, `.svg`, ≤ 64 KiB, no scripts or event attributes). |
| `award` fails with `achievement_unknown` | The id is not in the release this room started with: check `manifest.json`, upload and activate, then create a new room. |
| `gameData` returns another shape than `data.json` | The room plays with a player's own set (`room.set`); give `data.json` the shape of the set kind. |
