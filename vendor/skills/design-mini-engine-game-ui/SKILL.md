---
name: design-mini-engine-game-ui
description: Use when creating or reviewing the host, player or display pages of a Mini Engine (miniengine✳) game — layout, styling, fonts, animation, phone and TV sizes — or when a game looks like an unstyled template, is hard to use on a phone, unreadable on the shared screen, or blocked by the Content-Security-Policy.
---

# Designing a Mini Engine game UI

## Overview

One game, three devices at three distances. Each game has its **own atmosphere** drawn from its theme (quiz studio, detective noir, garden party…); it does not copy the engine's `/demo` look, wordmark or fonts, and does not load `/static/*` files. The only shared branding is the product name, Mini Engine, where you mention it at all.

Exception: when the user chose **MiniEngineUI**, the look comes from the mini-engine-ui skill and its kit (the calm shell of the demo games, copied into the game). Then skip "Atmosphere without noise" below in favour of that skill; everything else here still applies.

## The three pages

| Page | Device and distance | Design for |
| --- | --- | --- |
| `player.html` | Phone in hand, portrait, 360–430 px wide, thumbs | One clear primary action per phase. Touch targets ≥ 48×48 px with ≥ 8 px spacing; no hover-only affordances; no horizontal scroll; respect `env(safe-area-inset-*)`. Show the player's own secret (`private_state`) privately and plainly. Confirm submissions ("Sent — waiting for the others") and disable the control while pending. |
| `display.html` | TV or laptop across the room, 16:9 (1920×1080 and 1280×720), nobody touching it | Readable from 3–4 m: key numbers and names `clamp()`-sized to several percent of viewport height, body text ≥ ~2.5vh, contrast ≥ 7:1, no scrolling, no controls needed. In the lobby show the room code and how to join (`${location.origin}/demo` + code; the iframe has the engine's origin) large. Reveals are the show: give them space. |
| `host.html` | Moderator's laptop or tablet | A console: phase, who is ready/submitted/offline, the next action as the most prominent button, destructive actions (finish, new game) visually secondary. Label secret information "only you see this" and keep it behind a show/hide toggle (hidden by default), because moderators share or mirror their screen. |

Design every state, not just the happy path: connecting, reconnecting (`client.connected` false), host away (`room.host_connected` false — tell players to wait), lobby with ready status, waiting for others, revealed, finished, error. Render from the latest snapshot every time; a reloaded page must look right immediately.

## Hard constraints (engine CSP and catalog)

- **No inline JavaScript**: no `<script>` bodies, no `onclick="…"`, no import maps. Use `<script type="module" src="/games/<id>/assets/app.js">` and `addEventListener`. Inline `style` attributes and `<style>` are allowed.
- **Everything self-hosted** under `assets/`: no Google Fonts, CDNs, remote images or analytics (`default-src 'self'`; `img-src` also allows `data:`). Reference files by absolute path `/games/<id>/assets/…`, also inside CSS `url()`.
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

## Check before you call it done

- Screenshots at phone width 360–390 px (player), 1920×1080 and 1280×720 (display), 1280×800 (host) — `build-mini-engine-game/scripts/play.mjs` takes them. View them.
- No horizontal scroll on the player page; the display readable when its screenshot is scaled to a quarter.
- Keyboard: every control reachable and visible on focus.
- Browser console free of CSP and 404 errors on all three pages.
