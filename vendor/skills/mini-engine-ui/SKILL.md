---
name: mini-engine-ui
description: Use when building or restyling a Mini Engine (miniengine✳) game and the user chooses MiniEngineUI — the calm, ready-made style of the Mini Engine demo games — or has a game idea but no visual direction. Provides a copy-in kit (CSS, self-hosted fonts, host/player/display pages that fit the scaffold) and the rules for giving a game its own atmosphere inside that shell.
---

# MiniEngineUI

## Overview

MiniEngineUI is the look of Mini Engine's own demo games (Common Dice, Jeopardy), packed as a kit you copy into a game. **A quiet shell, the game's own atmosphere:** every game gets the same calm frame (top bar with the game name and room code, notices, a stage, the player list, plain buttons), and one theme plus one signature element on the stage make it feel like *that* game. Someone with only an idea gets a finished, tasteful game without designing anything.

This skill replaces the "invent your own look" part of design-mini-engine-game-ui. The device rules from that skill (touch targets, display distance, host console, every state, CSP) still apply: REQUIRED SUB-SKILL: design-mini-engine-game-ui.

## The philosophy

1. **One thing per screen.** Each phase has one main action on the player's phone; everything else is smaller or hidden.
2. **Quiet shell, own atmosphere.** The bar, buttons and lists stay plain and identical. The theme and the stage carry the game's mood: felt for dice, a TV studio for a quiz.
3. **Big where it counts.** Room code, scores, the answer buttons, the reveal. Explanations stay short and small.
4. **Phone first** for players, **across the room** for the display, **a console** for the host.
5. **Plain copy.** Sentence case, plain verbs ("Start the round", "I'm ready", "Waiting for the others"), no labels in capitals, no exclamation marks, no jokes in buttons. Write in the user's language and set `<html lang>`.
6. **The accent is scarce.** `--me-accent` marks only what matters *now*: ready, your turn, live. Never as a large fill, never as text on a light background.

## Apply the kit

The kit is in this skill's directory, in `kit/`.

1. Scaffold the game as usual (build-mini-engine-game), then copy `kit/ui/` to `<game>/assets/ui/` (stylesheet, two fonts, their licenses).
2. Copy `kit/host.html`, `kit/player.html` and `kit/display.html` over the game's pages and replace `__SLUG__` with the game id and `__TITLE__` with its title. They keep the scaffold's element ids, so the scaffolded vote game runs styled before you change any JavaScript.
3. Empty `assets/style.css` (the scaffold's styles fight the kit). It becomes the game's own stylesheet: theme overrides and the signature element only. Never edit `assets/ui/mini-engine-ui.css`; override it.
4. Choose the theme with `data-theme` on `<body>`, the same on all three pages unless the user wants otherwise:

   | Theme | Feel | Good for |
   | --- | --- | --- |
   | `kalk` (default) | light, calm, Mini Engine's own colours | word, vote and party games, daytime |
   | `nacht` | dark, calm | anything on a TV in a dim room |
   | `vilt` | green felt, ivory buttons | dice, cards, board and table games |
   | `studio` | deep blue, gold | quizzes, game shows, buzzers |

   A game that needs another mood gets its own theme in `assets/style.css`: see `references/components.md`.
5. Build the real screens from the components in `references/components.md`: `me-focus` columns on phones, `me-console` for the host, `me-surface` as the stage, `me-choices` for answers, `me-scores`, `me-roster`, `me-invite`, `me-secret`.
6. Give the stage **one signature element**: the board, the table, the question card, the timer. Draw it inside a `me-surface` (it takes `--me-stage-surface`) and keep everything around it quiet.
7. Replace the scaffold's player list with the roster markup (presence dot, name, ready label) and fill the display's join line (`.me-join-url`) with `location.host + '/home'` (snippets in the reference).

## Rules

- Keep the kit inside the game (`assets/ui/`). Never load the engine's `/static/*` files: an uploaded release must keep its look when the engine changes.
- `url()` inside CSS stays relative (`fonts/…`, `../img/…`), so it works for uploaded releases too. HTML keeps the scaffold's `/games/<id>/assets/…` paths.
- Two typefaces only: Space Grotesk (titles, numbers, codes) and DM Sans (text, buttons). No extra font, no icon font.
- No Mini Engine logo or wordmark in the game: the bar shows the game's own name.
- Render names and other user text with `textContent`.
- Animate only what happens live (a reveal: add `me-reveal` once), never on first render or reconnect. The kit already removes motion under `prefers-reduced-motion: reduce`.
- Celebrate achievements (engine 0.5+) with one short `me-notice`: on the display for everyone, on a phone only for the player who earned it, gone after a few seconds. Plain words ("Dani earned Drie keer raak"), no confetti, no sound, no exclamation marks. The snippet is in the reference.

## Done means

- [ ] All three pages use the kit, the chosen theme and one signature element; the scaffold's old styles are gone.
- [ ] Screenshots viewed: player at 390×844, host at 1280×800, display at 1920×1080, in lobby, during play and at the end.
- [ ] Display readable from across the room (title, numbers, room code), no scrolling.
- [ ] Network: `assets/ui/fonts/*.woff2` load with status 200; no CSP or 404 errors in the console.
- [ ] Text contrast checked for a custom theme: at least 4.5:1, 7:1 on the display.
