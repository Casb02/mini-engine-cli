# Running, verifying and troubleshooting

## Run the engine

From the engine checkout root (defaults are relative to the working directory):

```sh
cargo run                                   # or a built binary: ./target/debug/mini-engine
MINI_ENGINE_BIND=0.0.0.0:3000 cargo run     # phones on the same Wi-Fi: open http://<LAN-IP>:3000/demo everywhere, host included
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

1. Open `http://localhost:3000/demo`, pick the game and create a room (moderator). This tab becomes the host at `/room/CODE/host`.
2. For each player open a **new** tab in a separate browser profile/private window or another device, open `/demo`, enter the room code, then a unique player name. The tab becomes `/room/CODE/player`. Do not duplicate tabs: `sessionStorage` (where the seat credentials live) is per tab and is copied by "duplicate", which makes both tabs the same seat (`session_replaced`).
3. Open the display from your host page's button (see host-runtime-patterns §7) or browse to `/room/CODE/display#<display_token>`.
4. Play a complete game: ready → start → every round → finish → new game. Then: reload the host tab mid-round, put a player offline, and let a player leave mid-round (`POST /api/v1/rooms/CODE/leave` with their token — see sdk-api.md), including a player who holds a special secret role.

## Scripted play-through (Playwright)

`scripts/play.mjs` in this skill drives a real room: it creates the room over HTTP, injects each seat's credentials into its own browser context exactly like the launcher, opens `/room/CODE/<role>` (the real shell and iframe) and opens the display through its `#token` link. Copy it to `games/<id>/tests/play.mjs`, replace the game-specific block (it ships with steps for the scaffolded vote game), start the engine, then from the engine checkout:

```sh
npm ci                              # once; installs the engine's pinned Playwright
npx playwright install chromium     # once, if no browser is installed
node games/<id>/tests/play.mjs http://127.0.0.1:3000 /tmp/shots   # second argument: screenshot directory
```

Interact with game elements through `seat.game` (a frame locator into the game iframe). It saves phone- and TV-sized screenshots: look at them.

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
| Game missing in `/demo` | Engine not restarted, or directory name ≠ manifest `id`. |
| Engine will not start | Invalid package; read the startup error (see above). |
| Page says to open it from the room launcher | Opened `/api/v1/games/...` or the HTML directly; there is no session in this tab. Use `/demo` or `/room/CODE/<role>`. |
| Console: `Refused to execute inline script` / `Refused to load the script` (CSP), or a 404 for a module | Inline script, inline event handler, external script or import map; or a wrong absolute asset path (`/games/<id>/assets/...`). |
| Player action error `host_offline` | Host tab closed, asleep or reconnecting. |
| Action acked but nothing changes | Host reducer ignored it: wrong name, payload shape, phase or status. Log in the host's `action` handler. |
| `version_conflict` | A host write used an old `room.version`: write outside the queue or a stale closure. |
| `invalid_request` "Player state bevat een onbekende speler" | `player_states` contains a player who left; rebuild it from `room.players`. |
| `players_not_ready` on start | Every current player must press ready; the moderator has no ready state. |
| `invalid_transition` | Lifecycle must go `lobby → running → finished → lobby`. |
| `state_too_large` | Published state > 64 KiB; keep history short, send ids not full objects. |
| Scores vanish after "new round" | `lifecycle('lobby')` wipes state; keep rounds inside `running`. |
| `session_replaced` / a tab goes silent | The same seat was opened in another tab. |
| Display shows nothing / "Open het scherm via de schermlink" | Display opened without the `#token` fragment, or display disabled for the room. |
