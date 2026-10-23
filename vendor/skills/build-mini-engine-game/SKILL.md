---
name: build-mini-engine-game
description: Use when asked to build, extend or debug a Mini Engine (miniengine✳) party game — a game package with manifest.json, host/player/display pages and the /sdk/mini-engine.js client, tested with me dev and published with me game upload — including a host who plays along, realtime buzzers or live positions, achievements, player-made sets and a game icon, and when me dev or an upload refuses the package, a game is missing from /home, player actions seem ignored, setState fails with version_conflict, or secret per-player information leaks to other screens.
---

# Building a Mini Engine game

## Overview

A custom game is a trusted, static package: a folder with `manifest.json`, host/player/display pages and `assets/`. You play it locally with `me dev` from the Mini Engine CLI and publish it to a Mini Engine server with `me game upload`. Mini Engine owns rooms, seats, readiness, WebSockets and storage. **Your host page is the referee:** it receives every player action, validates it and publishes the complete next state. Custom games have no server-side code.

## Hard facts (design around them)

| Fact | Consequence |
| --- | --- |
| Custom games are `runtime: "host"`: the host page referees every room. `host_modes` is any non-empty subset of `["playing", "tv", "moderator"]`, `default_host_mode` one of them; the scaffold declares `["playing", "tv"]` with `"playing"` as default. Without `host_modes` the engine assumes `["moderator"]`. `runtime: "server"` and `hostless` exist only for the built-in games; a manifest cannot add them. `playing` needs engine 0.5.1+, `tv` 0.5.2+. | **Party games (board, card, dice, drawing) declare `["playing", "tv"]` with `playing` as default**: the form shows "Iedereen doet mee" (the creator plays like everyone else) and "TV" (the creating device shows the game and does not play). Declare `["moderator"]` ("Ik, als spelleider") only for a neutral leader, such as a quiz master who knows the answers. In every mode the host tab must stay open, or player actions fail with `host_offline`. |
| `playing` gives the creator a real seat: the host credential also has a `player_id`, `room.you.player_id` and `room.host_player_id` are that seat, and it is in `room.players`. The host seat counts as ready (the engine marks it). In `tv` and `moderator` rooms `room.host_player_id` is `null`. Read the mode from `room.config.host_mode`. | In `playing` the host page **is the player's page** plus only what the game needs from the creator (Start, New game, and game-specific steps such as walking through the final drawings): never a console with skip buttons, rule cards or player cards. In `tv` the host page **is the shared screen** plus Start and New game. Never wait for the host's own ready. |
| Only `player` connections can send `action`s; a host who plays along cannot either (`forbidden`). The host changes the room with `setState`, `lifecycle` and `setSettings`; the display only reads the state. | Host buttons call SDK methods directly, never `action()`. The host's own move runs the same rules function as a player's action, inside the host queue, and is published with `setState`. |
| `setState` replaces **all** state and needs `expected_version === room.version`. | Serialize every host mutation in one promise queue (the scaffold has one). |
| `lifecycle('lobby')` wipes `public_state` to `{}`, `host_state` to `null`, `player_states` to `{}` and resets readiness (the host seat stays ready). Start (`'running'`) needs every other player ready. | Multi-round games with running scores play all rounds inside one `running` phase. |
| Visibility: `public_state`, players, settings → everyone. `host_state` → host only. `player_states[id]` → host, and that player as `private_state`. Display gets no private state. | Secrets go in `host_state`/`player_states`; reveal by copying into `public_state`. The host can read every secret (devtools), also when they play along: for a game built on hidden information, say so or default to moderator. |
| Only `assets/**` is served (at `/games/<id>/assets/…`). Pages run in an iframe at `/api/v1/games/<id>/<role>?room=CODE` under CSP `script-src 'self'; connect-src 'self'`. | No inline `<script>`, no `onclick=""` attributes, no CDNs, no external APIs or fonts. Inline `style` is allowed. |
| `me dev` and `me game upload` check the package with the server's rules and refuse an invalid one with the reason. `me dev` reloads the seats on every save; the server only has what you uploaded, and rooms keep the version they started with. | Read the error in the `me dev` overview or terminal, fix and save. To see a change on the server: bump `version`, upload, activate, create a new room. |
| Since 0.5, `client.realtime` sends events (`emit`/`on`) and latest-wins values (`set`/`onValue`) from any role, including the display. They are never stored, versioned or in a snapshot, can be lost under load and have no order relative to snapshots. The engine sets `from` and `ts`. At most 2 KiB per message, 60 per second per connection (bursts of 120), 64 keys per sender. | Use realtime for buzzer presses, reactions and positions, and judge order by `ts`. Anything that counts (points, who won the buzz) is decided by the host and published with `setState`. |
| Since 0.5, a manifest can declare `achievements`. The host awards them with `client.award(playerId, id)`: only while `running` or `finished`, only to seated players with an account, only in rooms created by a logged-in host, never to another seat using the host's account. A host who plays along earns them on its own seat (`host_player_id`, 0.5.1+). In a `tv` room the TV's account may also earn on a phone seat (0.5.2+): the TV is a device, not a player. They are stored as `source: "game"`, shown apart from server-verified ones. | Award from the host queue at the moment the rules decide it. A guest seat answers `not_eligible`: expected, not a bug. Never promise achievements to guests. |
| Since 0.5, a manifest can declare `set_kinds` with a schema; players save sets on their account at `/home/sets` and pick one when they create a room. `api.gameData()` then returns that set instead of `data.json`, and `room.set` (`{id, kind, title}`) is public. | Give `data.json` the shape of the set kind, or branch on `room.set?.kind`, and validate the loaded data once. |

## Workflow

1. **Clarify only what changes the design**: player count, whether it is a party game (`["playing", "tv"]`, the default) or has a leader who does not play (`moderator`), what is secret from whom, round/turn structure and win condition, what the shared display shows, UI language, and whether it needs fast input (a buzzer, positions), achievements or content players make themselves. Otherwise assume, and list assumptions in your final report.
   **Ask once about the look:** "Shall I use MiniEngineUI, the calm style of the Mini Engine demo games, or do you want your own look?" When the user only has an idea, has no visual wishes or does not answer, use MiniEngineUI and say so in your report.
2. **Get the CLI and scaffold** — never hand-copy the template: `me game new <slug>` from the Mini Engine CLI (`npm install -g github:Casb02/mini-engine-cli`, Node 22+), or `npx -p @casb02/mini-engine-sdk create-mini-game <slug>` (slug = lowercase letters/digits/hyphens, ≤48, starts with a letter; the directory must not exist). The CLI also runs `me dev` and uploads; the SDK itself comes from npm, and game pages import the copy the server serves.
3. **Manifest and settings**: see `references/manifest-and-settings.md`, also for `host_modes`, `achievements`, `set_kinds` and the optional `icon` (a square SVG tile in `assets/`). Settings are chosen in the create form; the game shows them read-only.
4. **Design the state before coding**: write down `public_state`, `host_state` and `player_states` shapes plus a `phase` field. Decide what is realtime (shown at once, may be lost) and what is state (decided, kept). Put the rules in pure functions in `assets/logic.js` with `node:test` tests. Recipes, including realtime and achievements: `references/host-runtime-patterns.md`.
5. **Host reducer**: keep the scaffold's queue. For every action check name, payload shape, `room.status`, your phase, and that `action.player_id` is in `room.players`; ignore anything else. Publish the full next state. When the host plays along, its own buttons run the same move for `room.you.player_id` through that queue (the scaffold's `applyVote`).
6. **Role pages**: REQUIRED SUB-SKILL: design-mini-engine-game-ui. With MiniEngineUI also REQUIRED SUB-SKILL: mini-engine-ui (it supplies the look and a copy-in kit; design-mini-engine-game-ui still supplies the device rules). Keep the JSDoc `@typedef`s in `assets/app.js` in sync with your state so the type check means something.
7. **Verify** as in `references/verify-and-troubleshoot.md`, in this order: type check, rules tests, a hand-played game in `me dev`, a scripted multi-seat run with `scripts/play.mjs` (Playwright) against `me dev`, then a test upload played on real phones (and `scripts/play.mjs` against that server). Check achievements on the way: `me dev` prints every award; on the server see the "Achievements" part of that reference for logged-in seats. SDK API details: `references/sdk-api.md`.
8. **Publish** with a dev key from whoever runs the Mini Engine server (`me auth` once): `me game upload <dir>` stores a new immutable release (bump `version` in `manifest.json` first). **The first upload of a new game is live at once**, on `/home` for everyone on that server; later versions only go live with `--activate` (or `me game activate <id> <version>`, which also rolls back). Live rooms keep the release they started with, so import your own modules relatively (`./logic.js`), never via `/games/<id>/assets/…`. Uploads must use `runtime: "host"`; limits are in `references/manifest-and-settings.md`. A new achievement or set kind only works in rooms created after its release is active.

## Done means

- [ ] `me dev` starts without a package error, and after uploading, `/home` on the server lists the game.
- [ ] `npx -p typescript tsc -p jsconfig.json` (in the game directory) reports nothing; rules tests pass.
- [ ] A full game in `me dev`, and once on the server through `/home`: host creates, two players join in **separate** tabs/devices, ready, start, play every round, finish, back to lobby, play again. `scripts/play.mjs` passes.
- [ ] With `playing`: the creator's page looks like a player's phone (same layout, plus Start/New game), the host's own moves count, and the host seat never blocks the start.
- [ ] With `tv`: the host page is the shared screen (QR and code in the lobby, the game large), has Start and New game, and has no seat. With `moderator` too, when the manifest offers it.
- [ ] Turn-based: a player who is offline during their turn is skipped after a while, and phones keep the screen on while playing.
- [ ] With an `icon`: `me dev` accepts it and `/home` on the server shows it.
- [ ] Settings appear as plain text in the game; no control changes them mid-game.
- [ ] The display opens from the host page and shows only public information, readable from across a room.
- [ ] Player and display snapshots fetched during play contain no secret values.
- [ ] Malformed or out-of-phase actions change nothing; reloading the host tab mid-game continues from the snapshot.
- [ ] A player leaving mid-round does not make `setState` fail.
- [ ] With realtime: the round still ends correctly when a realtime message is lost, because the outcome lives in the state.
- [ ] With achievements: `me dev` prints the awards you expect; on the server a run with logged-in seats earns them (check `GET /api/v1/accounts/achievements`), and a guest seat gets none without an error on screen.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Server-side rules | None for custom games: the host page referees, also when it plays along. |
| The host page calls `action()` for its own move | `forbidden`. Run the move for `room.you.player_id` in the host queue and publish it with `setState`. |
| Waiting for the host's ready, or a ready button on the host page | The host seat is always ready. Show ready only to players. |
| Settings controls in the game ("Change rules") | Settings come from the create form; show them as text. Changing rules mid-game is unfair. |
| Scores kept across `lifecycle('lobby')` | Rounds live inside `running`; `'lobby'` means a new game. |
| Secret choice stored in `public_state` "for now" | `host_state` / `player_states` from the start. |
| `player_states` still contains a departed player → `setState` rejected | Rebuild `player_states` from current `room.players` before every publish. |
| Host renders before or without a snapshot; double-publishes on every snapshot | Make snapshot handlers idempotent: compute "is a write needed?" from the snapshot. |
| Treating an action ack as "processed" | An ack means queued at the host; wait for the snapshot. |
| Testing two players in one tab or a duplicated tab | Sessions live in per-tab `sessionStorage`: one fresh tab, private window or device per seat. |
| Expecting the server to show local edits | `me dev` reloads on save; the server only has what you uploaded. Bump `version`, upload with `--activate`, create a new room. |
| Positions or cursors sent with `setState` many times a second | `client.realtime.set` (coalesced, never versioned); `setState` is for rules state. |
| The buzz winner or points only in a realtime event | The host decides from the events' `ts` and publishes the result with `setState`. |
| Trusting a client's timestamp or player id inside realtime `data` | Use the `from` and `ts` the engine sets; treat `data` like action data. `ts` is when the engine received it, so network latency counts: fine for a party buzzer, not a photo finish. |
| `award` for a guest, before start or from a player page | Only the host awards, while `running`/`finished`, to `room.players` with an `account_id` (the host's own seat included when it plays along; in `tv` also a seat with the TV's account). |
