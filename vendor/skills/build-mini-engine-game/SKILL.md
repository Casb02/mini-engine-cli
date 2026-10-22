---
name: build-mini-engine-game
description: Use when asked to build, extend or debug a Mini Engine (miniengine✳) party game — a games/<id>/ package with manifest.json, host/player/display pages and the /sdk/mini-engine.js client — including when a game is missing from /demo, the engine refuses to start after adding a game, player actions seem ignored, setState fails with version_conflict, or secret per-player information leaks to other screens.
---

# Building a Mini Engine game

## Overview

A custom game is a trusted, static package in the engine's `games/<id>/`. The engine owns rooms, seats, readiness, WebSockets and storage. **Your host page is the referee:** it receives every player action, validates it and publishes the complete next state. Custom games have no server-side code.

## Hard facts (engine v0.2+ — design around them)

| Fact | Consequence |
| --- | --- |
| Custom games are `runtime: "host"` with `host_modes: ["moderator"]` only. `runtime: "server"`, `playing` and `hostless` exist only for the built-in Rust games (common-dice, jeopardy); a manifest cannot add a server runtime. | The room creator is a moderator **without a player seat** and cannot play along. The host tab must stay open, or player actions fail with `host_offline`. |
| Only `player` connections can send `action`s. The host changes the room with `setState`, `lifecycle` and `setSettings`; the display only reads. | Host buttons call SDK methods directly, never `action()`. |
| `setState` replaces **all** state and needs `expected_version === room.version`. | Serialize every host mutation in one promise queue (the scaffold has one). |
| `lifecycle('lobby')` wipes `public_state` to `{}`, `host_state` to `null`, `player_states` to `{}` and resets readiness. Start (`'running'`) needs every player ready. | Multi-round games with running scores play all rounds inside one `running` phase. |
| Visibility: `public_state`, players, settings → everyone. `host_state` → host only. `player_states[id]` → host, and that player as `private_state`. Display gets no private state. | Secrets go in `host_state`/`player_states`; reveal by copying into `public_state`. The host can read every secret (devtools); say so if it matters. |
| Only `assets/**` is served (at `/games/<id>/assets/…`). Pages run in an iframe at `/api/v1/games/<id>/<role>?room=CODE` under CSP `script-src 'self'; connect-src 'self'`. | No inline `<script>`, no `onclick=""` attributes, no CDNs, no external APIs or fonts. Inline `style` is allowed. |
| The catalog is read once at engine start; one invalid package stops the engine from starting. | Restart the engine after every change under `games/`; read the startup error. |

## Workflow

1. **Clarify only what changes the design**: player count, what is secret from whom, round/turn structure and win condition, what the shared display shows, UI language. Otherwise assume, and list assumptions in your final report.
   **Ask once about the look:** "Shall I use MiniEngineUI, the calm style of the Mini Engine demo games, or do you want your own look?" When the user only has an idea, has no visual wishes or does not answer, use MiniEngineUI and say so in your report.
2. **Find the engine checkout and SDK.** Scaffold — never hand-copy the template:
   `npx -p @casb02/mini-engine-sdk create-mini-game <slug> --directory <engine>/games/<slug>` (or `me game new <slug>` from the Mini Engine CLI when the game will be uploaded to a hosted engine)
   (slug = lowercase letters/digits/hyphens, ≤48, starts with a letter; directory name must equal the slug and must not exist). No engine checkout? Either clone the engine (`git clone git@github.com:Casb02/mini-engine.git`, private, needs GitHub access and Rust via rustup) to run games locally, or build in any folder and upload to a hosted engine with the CLI (`npm install -g github:Casb02/mini-engine-cli`, `me auth`, `me game upload`); the SDK itself comes from npm.
3. **Manifest and settings**: see `references/manifest-and-settings.md`.
4. **Design the state before coding**: write down `public_state`, `host_state` and `player_states` shapes plus a `phase` field. Put the rules in pure functions in `assets/logic.js` with `node:test` tests. Recipes: `references/host-runtime-patterns.md`.
5. **Host reducer**: keep the scaffold's queue. For every action check name, payload shape, `room.status`, your phase, and that `action.player_id` is in `room.players`; ignore anything else. Publish the full next state.
6. **Role pages**: REQUIRED SUB-SKILL: design-mini-engine-game-ui. With MiniEngineUI also REQUIRED SUB-SKILL: mini-engine-ui (it supplies the look and a copy-in kit; design-mini-engine-game-ui still supplies the device rules). Keep the JSDoc `@typedef`s in `assets/app.js` in sync with your state so the type check means something.
7. **Verify** as in `references/verify-and-troubleshoot.md`: type check, rules tests, restart the engine, a hand-played game, and a scripted multi-seat run with `scripts/play.mjs` (Playwright). SDK API details: `references/sdk-api.md`.
8. **Publish (optional, engine v0.3+)**: when the user has a dev key, use the `me` CLI instead of copying files to a server: `me game upload <dir>` stores a new immutable release (bump `version` in `manifest.json` first), `--activate` makes it live, `me game activate <id> <version>` rolls back. Live rooms keep the release they started with, so import your own modules relatively (`./logic.js`), never via `/games/<id>/assets/…`. Uploads must use `runtime: "host"`; limits are the same as on disk.

## Done means

- [ ] Engine restarts cleanly and `GET /api/v1/games` lists the game.
- [ ] `npx -p typescript tsc -p jsconfig.json` (in the game directory) reports nothing; rules tests pass.
- [ ] A full game through `/demo`: host creates, two players join in **separate** tabs/devices, ready, start, play every round, finish, back to lobby, play again.
- [ ] The display opens from the host page and shows only public information, readable from across a room.
- [ ] Player and display snapshots fetched during play contain no secret values.
- [ ] Malformed or out-of-phase actions change nothing; reloading the host tab mid-game continues from the snapshot.
- [ ] A player leaving mid-round does not make `setState` fail.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Planning a "playing host" or server-side rules | Moderator host + host runtime; the moderator referees. |
| Scores kept across `lifecycle('lobby')` | Rounds live inside `running`; `'lobby'` means a new game. |
| Secret choice stored in `public_state` "for now" | `host_state` / `player_states` from the start. |
| `player_states` still contains a departed player → `setState` rejected | Rebuild `player_states` from current `room.players` before every publish. |
| Host renders before or without a snapshot; double-publishes on every snapshot | Make snapshot handlers idempotent: compute "is a write needed?" from the snapshot. |
| Treating an action ack as "processed" | An ack means queued at the host; wait for the snapshot. |
| Testing two players in one tab or a duplicated tab | Sessions live in per-tab `sessionStorage`: one fresh tab, private window or device per seat. |
| Editing files and expecting the running engine to see them | Restart the engine. |
