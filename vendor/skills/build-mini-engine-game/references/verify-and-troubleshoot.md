# Running, verifying and troubleshooting

The loop, in this order: static checks, a hand-played game in `me dev`, a scripted run with `scripts/play.mjs`, then a test upload played on real phones. Achievements and privacy are checked along the way.

## Static checks (fast, run first)

```sh
cd <game directory>
npx -p typescript tsc -p jsconfig.json   # SDK misuse, typos in state/settings fields (downloads TypeScript;
                                         # offline: node <sdk>/node_modules/typescript/bin/tsc -p jsconfig.json)
node --test tests/*.test.mjs             # pure rules in assets/logic.js
```

## Play it by hand with `me dev`

The Mini Engine CLI (0.5+, `npm install -g github:Casb02/mini-engine-cli`) runs a local stand-in for Mini Engine for `runtime: "host"` games:

```sh
cd <game directory>
me dev                          # --players 4, --set sets/test.json, --port 3170, --no-open
```

It checks `manifest.json` like `me game upload`, then opens one page with the host, the display and every player side by side; each seat runs on its own port, so each has its own session like a separate phone. Saving a file reloads the seats and keeps the room. Rooms, ready, state versions, actions, realtime, achievements (every player counts as logged in; awards appear in the terminal) and game data (`--set` swaps in a set file, validated against `set_kinds`) work as on the server. Everything lives in memory; it listens on 127.0.0.1 only.

A package error (such as `Invalid manifest for <id>: …`, `Unsupported settings schema feature: pattern`, `A required game role HTML file is missing.`, `Invalid runtime or unsupported host modes.`, or a Dutch `manifest.json: …` message from the CLI's own checks) shows in the overview and the terminal; fix and save. `curl -s http://127.0.0.1:3170/api/v1/games/<id>` shows the manifest as the server reads it.

The room uses the manifest's `default_host_mode`. To try `tv` or `moderator` locally, change `default_host_mode` for a moment and press **Nieuwe kamer**, or create the room from `play.mjs` with that `host_mode`.

Play a complete game: ready → start → every round → finish → new game. Then reload the host seat mid-round, add a player with **Speler toevoegen**, and let a player leave mid-round (`POST /api/v1/rooms/CODE/leave` with their token — see sdk-api.md), including a player who holds a special secret role.

## Scripted play-through (Playwright)

`scripts/play.mjs` in this skill drives a whole room: it creates the room over HTTP, puts each seat's credentials into its own browser context exactly like the room launcher, opens `/room/CODE/<role>` (the real shell and iframe) for the host, the players and the display, and saves phone- and TV-sized screenshots. It works against `me dev` and against a server where the game is uploaded and active.

Copy it to `<game>/tests/play.mjs` (`me game upload` skips `tests/`), replace the game-specific block (it ships with steps for the scaffolded vote game), then:

```sh
cd <game directory>
npm install --no-save playwright                # once; me dev and me game upload skip node_modules/
npx playwright install chromium                 # once, if no browser is installed
me dev --no-open                                # in a second terminal
node tests/play.mjs http://127.0.0.1:3170 /tmp/shots   # base URL (default: me dev), screenshots (default: tests/)
```

Interact with game elements through `seat.game` (a frame locator into the game iframe). Look at the screenshots. For 3D games, launch Chromium with the GPU on: headless Chromium falls back to software rendering, and several WebGL pages then crawl at 10 fps (on macOS: `chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] })`).

## On the server with real phones

`me dev` is a stand-in. Before you report done, play the game once on a Mini Engine server, with phones. That needs a dev key (`me auth`); without one, say so in your report and stop after `me dev`.

```sh
me game upload                  # bump "version" in manifest.json first; a version can never be overwritten
```

- **The first upload of a new game is live at once:** everyone on that server sees it on `/home`. Later versions only become active with `me game upload --activate` (or `me game activate <id> <version>`), and only rooms created after that get them. Roll back with `me game activate <id> <previous version>`.
- To test without touching a published game, upload a copy with its own `id` in `manifest.json` (such as `<id>-test`) and turn it off afterwards with `me game disable <id>-test`.
- After an active upload the CLI prints `<server>/home/new/<id>`. Create a room there ("Iedereen doet mee", then again with "TV" when the game offers it); join on phones with the code or the QR code; open the display from **Kamer** → **Open het gedeelde scherm**. One private window or device per seat: `sessionStorage` (where seat credentials live) is per tab and is copied by "duplicate", which makes both tabs the same seat (`session_replaced`).
- Lock a player's phone during their turn: in a turn-based game they are skipped after 30 seconds.
- `node tests/play.mjs https://miniengine.nl /tmp/shots` runs the same script there; it creates a real room.

## Achievements

Achievements (Mini Engine 0.5+) only reach logged-in seats: guests never earn them, and a browser-host game can only award them in a room whose creator was logged in, to a player with another account.

- **In `me dev`** every seat counts as logged in, so awards just work: each one is printed in the `me dev` terminal (`Dani kreeg Winnaar`), and every page in the room gets the `achievement` event. A guest seat cannot be simulated there.
- **On the server**, give `post()` in `play.mjs` account tokens as its third argument. Make the test accounts once by hand on `/home/account` (a confirmed email address is not needed), then log in from the script:

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

- Sander stays a guest on purpose: he must get nothing, and nothing on screen may break.
- Hessel plays along, so his own seat (`host.player_id`) can earn achievements too (Mini Engine 0.5.1+). Another seat with his account cannot: do not also log Hessel in as a player in the same room. In a `tv` room (0.5.2+) the TV is a device, so the TV's account may also earn on a phone seat.

## Privacy check

During an open round, fetch each role's snapshot and confirm secrets appear only where intended (`me dev` on port 3170, or the server):

```sh
curl -s -H "Authorization: Bearer $PLAYER_TOKEN" http://127.0.0.1:3170/api/v1/rooms/$CODE   # no host_state/player_states; private_state = own only
curl -s -H "Authorization: Bearer $DISPLAY_TOKEN" http://127.0.0.1:3170/api/v1/rooms/$CODE  # no private data at all
```

`play.mjs` asserts the player side of this. Also search the player and display DOM for secret values. The host legitimately sees everything.

## Symptom → cause

| Symptom | Cause / fix |
| --- | --- |
| `me dev` or `me game upload` refuses the package | Read the reason (see above); the server applies the same rules. |
| Game missing in `/home` on the server | Not uploaded, upload failed, or the game is turned off (`me game list`). |
| A change works in `me dev` but not on the server | The server only has what you uploaded: bump `version`, upload, activate, then create a **new** room (rooms keep their version). |
| A module 404s on the server only | An absolute import of your own module (`/games/<id>/assets/…`) loads the active version; import your own modules relatively (`./logic.js`). |
| Page says to open it from the room launcher | Opened `/api/v1/games/...` or the HTML directly; there is no session in this tab. Use `/home`, `/room/CODE/<role>` or the `me dev` overview. |
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
| Display shows nothing / "Open het scherm via de schermlink" | Display opened without its credentials (the `#token` link or the `me dev` seat), or display disabled for the room. |
| `realtime.emit` returns `false`, or realtime handlers never fire | Not connected yet (wait for the first snapshot), a server older than 0.5, or the event targets someone else (`to`). The sender only gets its own event with `echo: true`. |
| `throttled` events | The page sends more than 60 realtime messages per second, more than 64 keys, or the room's values exceed 256 KiB. Send less, or raise `realtime.setInterval`. |
| `error` event `invalid_request` after a realtime call | Channel or key outside `A-Za-z0-9_.:-` (1–64), data over 2 KiB, or a bad `to`. |
| `award` fails with `not_eligible` | The player is a guest, the room was created without logging in, or another seat uses the host's own account. Expected; do not show it as an error. |
| The host's own move fails with `forbidden` | The host page called `action()`. Apply the move in the host queue with `setState` (host-runtime-patterns §11). |
| `Invalid runtime or unsupported host modes.` | `hostless` in `host_modes`, an empty list, a `default_host_mode` outside the list, `playing` on a server older than 0.5.1, or `tv` on one older than 0.5.2. |
| `manifest.json: icon …` (CLI) or `Invalid icon: …` (server) | The `icon` path or file breaks a rule in `manifest-and-settings.md` (path under `assets/`, `.svg`, ≤ 64 KiB, no scripts or event attributes). |
| `award` fails with `achievement_unknown` | The id is not in the release this room started with: check `manifest.json`, upload and activate, then create a new room. |
| `gameData` returns another shape than `data.json` | The room plays with a player's own set (`room.set`); give `data.json` the shape of the set kind. |
