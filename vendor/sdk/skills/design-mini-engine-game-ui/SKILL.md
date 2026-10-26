---
name: design-mini-engine-game-ui
description: Use when creating or reviewing the host, player or display pages of a Mini Engine (miniengine✳) game — layout, styling, fonts, animation, phone and TV sizes, the room code, join QR and game icon — or when a game looks like an unstyled template, is hard to use on a phone, unreadable on the shared screen, or blocked by the Content-Security-Policy.
---

# Designing a Mini Engine game UI

## Overview

One game, three devices at three distances. Each game has its **own atmosphere** drawn from its theme (quiz studio, detective noir, garden party…); it does not copy the look, wordmark or fonts of the engine's `/home` pages, and does not load `/static/*` files. The only shared branding is the product name, Mini Engine, where you mention it at all.

Exception: when the user chose **MiniEngineUI**, the look comes from the mini-engine-ui skill and its kit (the calm shell of the demo games, copied into the game). Then skip "Atmosphere without noise" below in favour of that skill; everything else here still applies.

## The three pages

| Page | Device and distance | Design for |
| --- | --- | --- |
| `player.html` | Phone in hand, portrait, 360–430 px wide, thumbs | One clear primary action per phase. Touch targets ≥ 48×48 px with ≥ 8 px spacing; no hover-only affordances; no horizontal scroll; fits the visible area of a phone browser (see below). Show the player's own secret (`private_state`) privately and plainly. Confirm submissions ("Sent — waiting for the others") and disable the control while pending. |
| `display.html` | TV or laptop across the room, 16:9 (1920×1080 and 1280×720), nobody touching it | Readable from 3–4 m: key numbers and names `clamp()`-sized to several percent of viewport height, body text ≥ ~2.5vh, contrast ≥ 7:1, no scrolling, no controls needed. In the lobby show how to join large: the QR code of the join link beside the room code and "Go to `${location.host}` and enter the code" (host only, no `/home`: the root redirects there; the iframe has the engine's origin). Once the game runs, the QR goes and the code stays small in the bar. Reveals are the show: give them space. |
| `host.html` | The creator's phone, or the TV | Depends on `room.config.host_mode`. **`playing` ("Iedereen doet mee", the default for party games):** exactly the player's page, because the creator is a player like everyone else. Add only "Start het spel" in the lobby (instead of "Ik ben klaar"), "Nieuw spel" afterwards, a quiet "Spel stoppen" link at the bottom and game-specific steps (walking through the final drawings). No console, no skip button, no cards for players, rules or the shared screen. **`tv`:** the shared screen as in `display.html`, plus "Start het spel" and "Nieuw spel". **`moderator` (a quiz master):** a console: phase, who is ready/submitted/offline, the next action as the most prominent button, destructive actions visually secondary. Label secret information "only you see this" and keep it behind a show/hide toggle (hidden by default), because hosts share or mirror their screen. |

In a party game the creator is one of the players: do not mark them as host. Other pages may say who starts ("Hessel start het spel als iedereen klaar is."). `room.host_player_id` is `null` with TV or a quiz master.

Design every state, not just the happy path: connecting, reconnecting (`client.connected` false), host away (`room.host_connected` false — tell players to wait), lobby with ready status, waiting for others, revealed, finished, error. Render from the latest snapshot every time; a reloaded page must look right immediately.

## Phone browsers: the visible area

The game runs in an iframe of the engine's room page, and the room page makes that frame exactly the visible part of the browser window (`100dvh`). On a phone the game therefore sits between the browser's address bar and toolbar, which is much shorter than the screen: about **393×660** on an iPhone 15/16 in Safari with both bars showing, and about **375×548** on an iPhone SE. Design the player page and the creator's page for those sizes, not for the full 390×844 screen.

- Fill the frame: `html, body { height: 100% }` or `height: 100dvh`, then lay out with flex or grid. Never pair a `dvh` height with `min-height: 100vh`: `100vh` is the height with the bars tucked away, so the minimum wins and the bottom of the page slides under the toolbar.
- The primary action and the player's own material (hand, dice, board, input) stay visible without scrolling the page. Long content scrolls in its own panel while the action stays in view. When the height runs short (`@media (max-height: 600px)`), shrink cards, art and margins before hiding anything.
- Keep important controls a little off the bottom edge, and pad edge-pinned elements with `max(12px, env(safe-area-inset-bottom))` (and the other sides likewise). Inside the frame these insets are usually 0, but they count when the page runs full screen or outside the room page. Adding `viewport-fit=cover` to the game does not put the game under the browser's bars: the room page decides that.
- Give every page a `theme-color` per colour scheme (`<meta name="theme-color" content="#…" media="(prefers-color-scheme: dark)">`, and one for light). Since engine 0.6.5 the room page paints the strip around the browser's toolbar in that colour, so it matches the game instead of the engine's own background.

## Room code and joining

| Page | Room code | QR code |
| --- | --- | --- |
| Display | Plain text: big in the lobby invite, small in the bar during play. | Large in the lobby beside the code (about a quarter of the screen height), gone once the game runs. |
| Host, player | In the bar as a button that copies the join link and shows "Copied" for 1.5 s, then the code again. | A quiet bar button "Show QR" next to the code opens a dialog with a large QR, the code and "Close" (Escape and the backdrop close it too). Use it where a permanent QR does not fit; on a phone it lets a friend scan to join. |

- One join link everywhere: `${location.origin}/home/join?room=CODE`. The QR encodes it; the copy button copies it.
- Invite text names only the host: "Go to miniengine.nl and enter the code" with `location.host`, never `/home`.
- QR: dark modules on white with a quiet zone of 4 modules, also in dark themes; never tinted or with a logo on top.
- Vendor the QR library under `assets/` (no CDN). MiniEngineUI ships one with helpers: `mini-engine-ui/kit/ui/invite.js`.
- Write the labels in the game's language ("Gekopieerd", "Toon QR", "Sluiten").

## Settings are shown, not changed

The room's settings are chosen in the create form. Show them in the game as plain text, such as a short "Rules: 5 rounds" line in the lobby and on the display, and offer no controls to change them: changing rules while people play is unfair, and a form re-rendered from every snapshot easily loses the click.

## Game icon

An optional `icon` in the manifest (`assets/<name>.svg`, rules in `build-mini-engine-game/references/manifest-and-settings.md`) is shown at 52 px on `/home` and in the create form. Draw a square `viewBox="0 0 48 48"`, a full tile with its own background (`rx="12"`), one or two simple shapes in the game's colours. No text, no external references, no fonts. It must read at 52 px next to the engine's own marks.

## Hard constraints (engine CSP and catalog)

- **No inline JavaScript**: no `<script>` bodies, no `onclick="…"`, no import maps. Use `<script type="module" src="/games/<id>/assets/app.js">` and `addEventListener`. Inline `style` attributes and `<style>` are allowed.
- **Everything self-hosted** under `assets/`: no Google Fonts, CDNs, remote images or analytics (`default-src 'self'`; `img-src` also allows `data:`). Reference files by absolute path `/games/<id>/assets/…`, also inside CSS `url()`. Pictures from players' own sets (`/media/<id>`, engine 0.8+) are same-origin too: show them with `<img src>` in a fixed box (`max-height` plus `object-fit: contain`) so a tall photo never pushes the answer buttons off a phone screen, and larger on the display.
- **Fonts**: a system stack, or `.woff2` files in `assets/fonts/` with their license file next to them, loaded with `@font-face { font-display: swap; }`. Two families at most.
- Files ≤ 2 MiB each, package ≤ 10 MiB: compress images, subset fonts, vendor libraries minified with their license.
- Render player names and any user text with `textContent` (or escape it); never build HTML from untrusted strings.

## Atmosphere without noise

- Define the theme as CSS custom properties on `:root` (colors, radii, fonts, motion durations) and decide light, dark or both deliberately — displays usually run in dim rooms.
- Pick one signature element (a board, a stage light, a paper texture, a timer ring) and let the rest stay quiet.
- Never rely on color alone: team colors also get names, icons or patterns. Keep focus outlines visible (`:focus-visible`).
- Set `<html lang>` to the UI language the user asked for; keep copy short and in that language.

## Motion

- Animate transitions you observe live (a reveal, a score change); on first render or reconnect show the end state without replaying.
- Animation presents the authoritative snapshot; it never decides outcomes or delays state.
- Wrap non-essential motion in `@media (prefers-reduced-motion: no-preference)`, or remove it under `reduce`: show the final state instantly, no parallax, shaking or flashing.

## Live moments (realtime, engine 0.5+)

`client.realtime` is for what must feel instant: a buzzer press, a reaction, a marker that follows a finger. The page is still drawn from the snapshot; realtime is a layer on top of it.

| Page | Realtime fits as |
| --- | --- |
| Player | Instant feedback on your own tap. The sender does not receive its own event, so show "Pressed" yourself at once, then let the snapshot show the result. When `emit` returns `false`, say plainly that the phone is not connected. |
| Display | The room's live view: the press order with the gap to the first ("Sander +14 ms"), everyone's markers, reactions rising and fading. After a reload, values come back through `onValue`; events do not. |
| Host | A quiet trace of the presses in order, so the host can follow. The decision buttons still act on the state. |

- **State decides, realtime decorates.** Phase, scores, turns and who won the buzz come from the snapshot. When the snapshot with the decision arrives, it replaces the live layer. Never let a realtime message be the only place a result appears: messages can be lost.
- **Draw per frame, not per message.** Keep the latest values and draw in `requestAnimationFrame`. Move markers with a short transition instead of jumps; under `prefers-reduced-motion: reduce`, place them without animation.
- **Keep it calm.** Reactions are small and brief; at most a few on screen at once. Do not show `throttled` to players.
- **Achievements** (`achievement` event, first time only, on every screen): a short notice on the display and on that player's phone, such as "Dani earned Drie keer raak", is enough. No confetti over the game, no sound by default. The event can be missed, so the game must not depend on it.

## Check before you call it done

- Screenshots of the phone pages at the visible browser area, **393×660 and 375×548**, in light and dark, in the lobby, during your own turn and at the end; the display at 1920×1080 and 1280×720; the host at 1280×800 for TV or console, or at phone size when the creator plays along. `build-mini-engine-game/scripts/play.mjs` takes them. View them: nothing the player needs may sit below the bottom edge.
- No horizontal scroll on the player page; the display readable when its screenshot is scaled to a quarter.
- Keyboard: every control reachable and visible on focus.
- Browser console free of CSP and 404 errors on all three pages.
