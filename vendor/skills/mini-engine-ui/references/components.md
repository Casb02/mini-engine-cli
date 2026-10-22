# MiniEngineUI components

All classes start with `me-`; all tokens with `--me-`. The stylesheet is `assets/ui/mini-engine-ui.css`. Sizes are in `em`, so everything grows on the display page (`body[data-role="display"]` sets a larger base size).

## Page skeleton

```html
<body data-role="player" data-theme="kalk">
  <div class="me-page">
    <header class="me-bar">
      <span class="me-bar-name">Game title <span class="me-role">Player</span></span>
      <div class="me-bar-end">
        <button type="button" class="me-code" id="code"></button>
        <button type="button" class="me-bar-button" id="show-qr">Show QR</button>
        <span class="me-connection" id="connection" data-status="connecting"><span class="me-connection-text">Connecting…</span></span>
      </div>
    </header>
    <div class="me-notices">
      <p id="error" class="me-notice is-error" role="alert"></p>
      <p id="host-away" class="me-notice" hidden>The host is away for a moment. The game continues when they are back.</p>
    </div>
    <main class="me-stage">…</main>
  </div>
</body>
```

- `.me-notice:empty` is hidden, so an empty error paragraph takes no space.
- On phones (≤ 720 px) the role label and the connection text hide; the dot stays.
- `.me-bar-button` with `.me-count` is a bar button with a number (for example "Players 4") if you add a drawer or panel.
- On the display the code is a plain `<span class="me-code" id="code">` and there is no "Show QR" button: the lobby invite carries the QR.

## Room code and QR

`assets/ui/invite.js` (from `kit/ui/invite.js`, no dependencies besides `./qr.js`):

| Export | Does |
| --- | --- |
| `joinUrl(code)` | `${location.origin}/home/join?room=CODE`: the one join link, for the QR and the copy button. |
| `qrSvg(text)` | An SVG string, dark on white with a quiet zone of 4 modules. It holds no user text, so it may go into `innerHTML`. |
| `bindCopyCode(button, code, labels?)` | Writes the code into the button; a click copies the join link and shows `labels.copied` for 1.5 s. When copying fails the code stays. |
| `bindQrDialog(button, code, labels?)` | A click opens a `me-dialog` with a large `me-qr`, the code and a close button. Escape and the backdrop close it. |

Labels default to English (`copied: 'Copied'`, `close: 'Close'`, `scan: 'Scan to join'`, plus the titles `copy` and `showQr`); pass the game's language.

Host and player, once at start (`code` is the scaffold's room code from `?room=`):

```js
import { bindCopyCode, bindQrDialog, joinUrl, qrSvg } from './ui/invite.js';

if (role !== 'display') {
  bindCopyCode($('code'), code, { copied: 'Gekopieerd', copy: 'Kopieer de link om mee te doen' });
  bindQrDialog($('show-qr'), code, { close: 'Sluiten', scan: 'Scan om mee te doen', showQr: 'Toon een QR-code om mee te doen' });
}
```

`bindCopyCode` owns the button's text: in `render(room)` write `$('code').textContent = room.code` only on the display. Translate the bar button's own text too ("Toon QR").

Connection and host status, in `render(room)` and on the client's `status` event:

```js
const connection = $('connection');
client.on('status', status => {
  connection.dataset.status = status; // connecting | connected | reconnecting | disconnected
  connection.querySelector('.me-connection-text').textContent =
    { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', disconnected: 'Offline' }[status];
});
// in render(room):
$('host-away').hidden = role === 'host' || room.host_connected;
```

## Layouts on the stage

| Class | Use |
| --- | --- |
| `me-focus` | Phone column, max 34rem, centred. One main action per phase. |
| `me-wide` | Wide column (max 1320 px) for host and display. |
| `me-console` | Host: main column plus a side column (players, settings). Stacks below 900 px. Combine with `me-wide`. |
| `me-stack` | Vertical stack with a 16 px gap. |
| `me-surface` | The stage panel: rounded, lifted, filled with `--me-stage-surface` (felt in `vilt`, a studio gradient in `studio`). Put the signature element here. |
| `me-card` | A plain panel on the page background. |

## Text

| Class | Use |
| --- | --- |
| `me-title` on `h1` | The question, the phase title, the winner. Larger on the display. |
| `me-lede` | One explaining sentence under a title. |
| `me-status` | The status line ("Waiting for the others"). Use `role="status"`. |
| `me-big` | A number that matters: score, total, countdown. Tabular figures. |
| `me-label` | Small caption under a big number. |
| `me-muted` | Secondary text. |

## Buttons

```html
<button class="me-button is-primary is-wide">Start the round</button>
<button class="me-button">Skip</button>
<button class="me-button is-danger">End the game</button>
<button class="me-button is-ready">Ready</button>   <!-- quiet button with an accent dot: you are ready -->
<button class="me-text-button">Change name</button>
<div class="me-actions">…several buttons in a row…</div>
```

One `is-primary` per screen: the next thing to do. Destructive actions are never primary. Disable a button while its request is pending.

Answer buttons on the phone:

```html
<div class="me-choices">
  <button class="me-choice" aria-pressed="false">Paris</button>
  <button class="me-choice" aria-pressed="true">Lyon</button>
</div>
```

`aria-pressed="true"` marks the player's own pick with a firm border. The grid fits two or more per row and stays at least 88 px tall.

## Players

```html
<ul id="players" class="me-roster" aria-label="Players"></ul>
```

```js
$('players').replaceChildren(...room.players.map(player => {
  const item = document.createElement('li');
  const presence = document.createElement('span');
  presence.className = 'me-presence' + (player.connected ? ' is-online' : '');
  const name = document.createElement('span');
  name.className = 'me-name';
  name.textContent = player.id === room.host_player_id ? `${player.name} · host` : player.name;
  const ready = document.createElement('span');
  ready.className = 'me-ready' + (player.ready ? ' is-ready' : '');
  ready.textContent = player.ready ? 'Ready' : room.status === 'lobby' ? 'Not ready' : '';
  item.append(presence, name, ready);
  return item;
}));
```

Scores:

```html
<ol class="me-scores">
  <li class="is-turn"><span class="me-name">Dani</span><span class="me-score">12</span></li>
  <li><span class="me-name">Sander</span><span class="me-score">9</span></li>
</ol>
```

`is-turn` puts an accent bar on the player whose turn it is. Sort by score at the end only; during play keep a stable order.

## Display

Join line in the bar and the lobby invite with QR (both already in `kit/display.html`):

```html
<section id="invite" class="me-invite" hidden>
  <div id="invite-qr" class="me-qr"></div>
  <div class="me-invite-text">
    <span class="me-label">Go to <span class="me-join-url"></span> and enter the code</span>
    <span class="me-code" id="invite-code"></span>
  </div>
</section>
```

```js
if (role === 'display') {
  document.querySelectorAll('.me-join-url').forEach(slot => { slot.textContent = location.host; });
  $('invite-qr').innerHTML = qrSvg(joinUrl(code));
  $('invite-code').textContent = code;
}
// in render(room):
if (role === 'display') $('invite').hidden = room.status !== 'lobby';
```

The bar and the invite use the same `me-join-url` class, so this one line fills both. Name only the host (`location.host`): the root redirects to `/home`. Players scan the QR, or open that address and type the code.

Show the invite large in the lobby (the QR is about a quarter of the screen height) and only the bar code once the game runs. Leave out `#invite-qr` for an invite without QR.

## Achievements

Engine 0.5+. The first time someone earns an achievement, every page receives the client's `achievement` event. Add a status notice next to the error notice:

```html
<div class="me-notices">
  <p id="error" class="me-notice is-error" role="alert"></p>
  <p id="achievement" class="me-notice me-reveal" role="status"></p>
</div>
```

```js
/** @type {ReturnType<typeof setTimeout> | undefined} */
let achievementTimer;
client.on('achievement', ({ player_id, achievement }) => {
  const mine = player_id === client.room?.you.player_id;
  if (role === 'player' && !mine) return;
  const name = client.room?.players.find(player => player.id === player_id)?.name ?? 'A player';
  $('achievement').textContent = mine ? `You earned ${achievement.title}. ${achievement.description}` : `${name} earned ${achievement.title}`;
  clearTimeout(achievementTimer);
  achievementTimer = setTimeout(() => { $('achievement').textContent = ''; }, 6000);
});
```

The notice is hidden while empty and slides in once when it gets text (`me-reveal`; no motion under reduced motion). The display shows everyone's, a phone only its own. Keep it to one line: the title, on a phone also the description. The event can be missed, so nothing in the game may depend on it.

`room.host_player_id` is the seat of a host who plays along (`null` with TV or a quiz master). That seat always counts as ready. In a party game do not label it as host: the creator is one of the players.

## Host

```html
<details class="me-secret">
  <summary>Answer (only you see this)</summary>
  <p id="answer"></p>
</details>
```

Closed by default, because hosts share or mirror their screen.

## Settings

Settings are chosen in the create form. Show them as one quiet line, never as controls:

```html
<p id="rules" class="me-muted"></p>
```

```js
$('rules').textContent = `Rules: ${room.settings.rounds} rounds`;
```

## Forms

`label`, `input`, `select` and `textarea` are styled: 48 px tall, surface background, line border. Put the label above the field.

## Motion

Add `me-reveal` to an element the moment something is revealed live (a card turns, a score lands); remove it before the next reveal. Do not add it on the first render or after a reconnect. Under `prefers-reduced-motion: reduce` the kit shows the end state at once.

## Your own theme

Add it to the game's `assets/style.css` and set `data-theme="<name>"` on the three pages:

```css
body[data-theme="garden"] {
  --me-bg: #10201a;
  --me-backdrop: radial-gradient(120% 70% at 50% 0%, #1b3328 0%, #10201a 60%);
  --me-surface: #172a22;
  --me-ink: #f2efe6;
  --me-muted: #a3b2a8;
  --me-line: rgba(242, 239, 230, 0.13);
  --me-primary: #f2efe6;
  --me-primary-ink: #10201a;
  --me-focus: #f2efe6;
  --me-accent: #f2c230;
  --me-good: #7fd39a;
  --me-bad: #f08a76;
  --me-online: #7fd39a;
  --me-stage-surface: linear-gradient(180deg, #24513c 0%, #1a3d2d 100%);
  color-scheme: dark;
}
```

| Token | Role |
| --- | --- |
| `--me-bg`, `--me-backdrop` | Page colour and an optional soft gradient on top. |
| `--me-surface` | Cards, choices, inputs. |
| `--me-ink`, `--me-muted`, `--me-line` | Text, secondary text, hairlines. |
| `--me-primary`, `--me-primary-ink` | The one main button and its text. |
| `--me-focus` | Keyboard focus ring. |
| `--me-accent` | Scarce signal: ready, your turn, live. |
| `--me-good`, `--me-bad` | Right/wrong, errors. |
| `--me-online` | Presence dot. |
| `--me-stage-surface` | Fill of `me-surface`, the stage. |

Keep text contrast at least 4.5:1 (7:1 on the display) and the primary button readable. Change tokens, not the kit's rules.
