# MiniEngineUI components

All classes start with `me-`; all tokens with `--me-`. The stylesheet is `assets/ui/mini-engine-ui.css`. Sizes are in `em`, so everything grows on the display page (`body[data-role="display"]` sets a larger base size).

## Page skeleton

```html
<body data-role="player" data-theme="kalk">
  <div class="me-page">
    <header class="me-bar">
      <span class="me-bar-name">Game title <span class="me-role">Player</span></span>
      <div class="me-bar-end">
        <span class="me-code" id="code"></span>
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
  name.textContent = player.name;
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

Join line in the bar (already in `kit/display.html`), or a large invite in the lobby:

```html
<div class="me-invite">
  <span class="me-label">Join at <span id="join-url"></span> with code</span>
  <span class="me-code" id="invite-code"></span>
</div>
```

```js
$('join-url').textContent = location.host + '/demo';
$('invite-code').textContent = room.code;
```

Show the invite large in the lobby and only the bar code once the game runs.

## Host

```html
<details class="me-secret">
  <summary>Answer (only you see this)</summary>
  <p id="answer"></p>
</details>
```

Closed by default, because hosts share or mirror their screen.

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
