import { readFileSync } from 'node:fs';

/** The bundled SDK declarations, copied into each game so editors type-check `/sdk/mini-engine.js` imports offline. */
export const sdkDeclarations = readFileSync(new URL('../types/mini-engine.d.ts', import.meta.url), 'utf8');

/**
 * Editor/tsc configuration only; the engine never serves it. TypeScript applies `paths` to the rooted
 * specifier `/sdk/mini-engine.js`; inside an engine checkout the first entry resolves to the engine's
 * own vendored copy (web/mini-engine.d.ts), elsewhere the game's bundled copy is used.
 */
export const jsconfig = {
  compilerOptions: {
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
    lib: ['es2022', 'dom'],
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    paths: { '/sdk/mini-engine.js': ['../../web/mini-engine.d.ts', './types/mini-engine.d.ts'] },
  },
  include: ['assets/**/*.js'],
};

/** All files are static engine game assets; no generated npm dependency is required. */
export function gameFiles(slug) {
  const title = slug.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  const manifest = {
    id: slug,
    title,
    description: 'A ready-to-play yes/no vote game. Customize the question and start voting.',
    version: '0.1.0',
    runtime: 'host',
    host_modes: ['moderator'],
    default_host_mode: 'moderator',
    min_players: 1,
    max_players: 24,
    has_display: true,
    default_settings: { prompt: 'Should we play another round?', allow_change: true },
    settings_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', maxLength: 120 },
        allow_change: { type: 'boolean' },
      },
      required: ['prompt', 'allow_change'],
      additionalProperties: false,
    },
  };
  const html = role => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/games/${slug}/assets/style.css">
</head>
<body data-role="${role}">
  <main>
    <p class="eyebrow">${title} · <span id="code"></span></p>
    <h1 id="prompt">Connecting…</h1>
    <p id="status" role="status">Waiting for the room.</p>
    <p id="error" role="alert"></p>
    <section class="results" aria-label="Votes"><div><strong id="yes">0</strong>Yes</div><div><strong id="no">0</strong>No</div></section>
    <section id="player-controls" hidden>
      <button id="ready">I'm ready</button>
      <div class="actions"><button id="vote-yes">Yes</button><button id="vote-no">No</button></div>
      <p id="my-vote"></p>
    </section>
    <section id="host-controls" hidden>
      <div class="actions"><button id="start">Start voting</button><button id="finish">Finish round</button><button id="reset">New round</button></div>
      <p>Keep this host tab open: it runs this game's trusted reducer.</p>
    </section>
    <ul id="players" aria-label="Players"></ul>
  </main>
  <script type="module" src="/games/${slug}/assets/app.js"></script>
</body>
</html>
`;
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'host.html': html('host'),
    'player.html': html('player'),
    'display.html': html('display'),
    'assets/app.js': app,
    'assets/style.css': css,
    'jsconfig.json': `${JSON.stringify(jsconfig, null, 2)}\n`,
    'types/mini-engine.d.ts': sdkDeclarations,
    'README.md': `# ${title}

A trusted **host-runtime** vote game for Mini Engine v0.2. The host tab validates player actions and publishes state; keep it online during play. Guests need no accounts. All roles see the same vote totals; players can optionally change their vote.

## Run in five minutes

1. Put this whole directory at games/${slug}/ in your Mini Engine checkout.
2. Restart the engine from its project root (cargo run). If your server uses another games directory, put it there instead.
3. Open the engine's /home, select **${title}**, and create a moderator room.
4. Join from another browser/device using the room code, then click **I'm ready**.
5. On the host, click **Start voting**. Vote on the player screen; optionally open a display.

The generated HTML imports the SDK served by your engine at /sdk/mini-engine.js. Do not open the HTML files with file:// or a generic static server: the engine supplies room sessions, HTTP and WebSocket routes.

## Make it yours

- Change metadata/defaults and the supported settings schema in manifest.json.
- Change rendering and the serial host reducer in assets/app.js.
- Change the layout in host.html, player.html, display.html and assets/style.css.
- Keep only public assets in assets/; host-only data belongs in data.json and must be loaded through the authenticated game-data route.

## Editor types

assets/app.js is plain JavaScript with JSDoc types, so the browser runs it unchanged. jsconfig.json maps the import specifier /sdk/mini-engine.js to the SDK's type declarations: inside a Mini Engine checkout (games/${slug}/) it uses the engine's own web/mini-engine.d.ts, which always matches the SDK the engine serves; elsewhere it uses the bundled copy in types/mini-engine.d.ts. VS Code and other TypeScript-based editors pick this up automatically: you get completion for MiniEngine, room snapshots and settings, and wrong SDK calls are underlined. To check from a terminal:

    npx -p typescript tsc -p jsconfig.json

jsconfig.json and types/ are editor files: the engine only serves files under assets/ and ignores them. Describe your own state and settings shapes in the @typedef lines at the top of assets/app.js.

The room snapshot is authoritative. A request acknowledgement means the action reached the host queue; it does not confirm durable processing for host-runtime games. The SDK never replays actions automatically. New rounds reset votes; the room's prompt and allow_change settings remain configurable through the workbench.

Game packages are locally trusted code, not sandboxed uploads. Review a package before installing it.
`,
  };
}

const app = String.raw`import { MiniEngine, loadSession } from '/sdk/mini-engine.js';
/** @import { Role, Snapshot } from '/sdk/mini-engine.js' */

// Types come from jsconfig.json + types/mini-engine.d.ts; they are comments, so the browser runs this file as-is.
/** @typedef {{ prompt: string, allow_change: boolean }} Settings Mirrors settings_schema in manifest.json. */
/** @typedef {{ votes?: Record<string, boolean> }} PublicState Every role sees this; the engine starts each round with {}. */
/** @typedef {Snapshot<PublicState, Settings>} Room */

/** @param {string} id */
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const button = id => /** @type {HTMLButtonElement} */ (document.getElementById(id));
const role = /** @type {Role} */ (document.body.dataset.role);
const code = new URLSearchParams(location.search).get('room') || '';
const session = loadSession(code, role);
/** @param {unknown} error */
const showError = error => { $('error').textContent = /** @type {Error} */ (error)?.message || String(error); };

if (!session) {
  showError(new Error('Open this game from the room launcher to restore your session.'));
} else {
  /** @type {MiniEngine<PublicState, Settings>} */
  const client = new MiniEngine(session);
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let busy = false;
  /** @param {() => Promise<unknown>} operation */
  const run = async operation => {
    $('error').textContent = '';
    busy = true;
    if (client.room) render(client.room);
    try { await operation(); } catch (error) { showError(error); }
    finally { busy = false; if (client.room) render(client.room); }
  };
  /** @param {() => Promise<unknown>} operation */
  const enqueue = operation => {
    queue = queue.then(operation).catch(showError);
    return queue;
  };
  /** @param {Room} room */
  const stateOf = room => ({ votes: room.public_state?.votes ?? {} });
  /** @param {Room} room */
  const meIn = room => room.players.find(player => player.id === room.you.player_id);
  /** @param {Record<string, boolean>} votes */
  const publish = votes => {
    if (!client.room) throw new Error('No room snapshot yet.');
    return client.setState({ expected_version: client.room.version, public_state: { votes } });
  };

  /** @param {Room} room */
  function render(room) {
    const state = stateOf(room);
    const votes = room.players.map(player => state.votes[player.id]).filter(value => typeof value === 'boolean');
    const mine = room.you.player_id ? state.votes[room.you.player_id] : undefined;
    const me = meIn(room);
    $('code').textContent = room.code;
    $('prompt').textContent = room.settings.prompt;
    $('status').textContent = !client.connected ? 'Reconnecting…' : room.status === 'lobby'
      ? 'Get ready. The host starts the vote.' : room.status === 'running' ? 'Voting is open.' : 'Voting finished.';
    $('yes').textContent = String(votes.filter(value => value).length);
    $('no').textContent = String(votes.filter(value => !value).length);
    $('player-controls').hidden = role !== 'player';
    $('host-controls').hidden = role !== 'host';
    button('ready').hidden = room.status !== 'lobby';
    button('ready').textContent = me?.ready ? 'Ready ✓' : "I'm ready";
    button('ready').disabled = busy || !client.connected;
    const voteDisabled = busy || !client.connected || !room.host_connected || room.status !== 'running' || (!room.settings.allow_change && typeof mine === 'boolean');
    button('vote-yes').disabled = voteDisabled;
    button('vote-no').disabled = voteDisabled;
    $('my-vote').textContent = typeof mine === 'boolean' ? 'Your vote: ' + (mine ? 'Yes' : 'No') : '';
    button('start').disabled = busy || !client.connected || room.status !== 'lobby' || !room.players.length || room.players.some(player => !player.ready);
    button('finish').disabled = busy || !client.connected || room.status !== 'running';
    button('reset').disabled = busy || !client.connected || room.status !== 'finished';
    $('players').replaceChildren(...room.players.map(player => {
      const item = document.createElement('li');
      item.textContent = player.name + (player.ready ? ' · ready' : '') + (player.connected ? '' : ' · offline');
      return item;
    }));
  }

  if (role === 'host') {
    // Every mutation waits for its snapshot and acknowledgement before reading the next version.
    client.on('snapshot', () => enqueue(async () => {
      const room = client.room;
      if (room?.status === 'lobby' && !room.public_state?.votes) await publish({});
    }));
    client.on('action', action => enqueue(async () => {
      const room = client.room;
      const data = action.data;
      // Validate everything a player sends: payloads are untrusted JSON.
      const yes = data && typeof data === 'object' && !Array.isArray(data) ? data.yes : undefined;
      if (!room || room.status !== 'running' || action.name !== 'vote' || typeof yes !== 'boolean') return;
      if (!room.players.some(player => player.id === action.player_id)) return;
      const state = stateOf(room);
      if (!room.settings.allow_change && typeof state.votes[action.player_id] === 'boolean') return;
      await publish({ ...state.votes, [action.player_id]: yes });
    }));
    button('start').onclick = () => run(() => enqueue(() => client.lifecycle('running')));
    button('finish').onclick = () => run(() => enqueue(() => client.lifecycle('finished')));
    button('reset').onclick = () => run(() => enqueue(() => client.lifecycle('lobby')));
  }
  button('ready').onclick = () => run(() => client.ready(!(client.room && meIn(client.room)?.ready)));
  button('vote-yes').onclick = () => run(() => client.action('vote', { yes: true }));
  button('vote-no').onclick = () => run(() => client.action('vote', { yes: false }));
  client.on('snapshot', render);
  client.on('error', showError);
  client.on('status', status => { if (client.room) render(client.room); else $('status').textContent = status; });
  client.on('closed', reason => { showError(new Error('Room connection closed: ' + reason)); });
  window.addEventListener('pagehide', () => client.close());
  window.addEventListener('pageshow', () => client.resume());
  client.connect();
}
`;

const css = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; background: light-dark(#f6f4ed, #171c24); color: light-dark(#1e293b, #f6f4ed); }
* { box-sizing: border-box; }
body { margin: 0; padding: clamp(1rem, 5vw, 4rem); }
main { max-width: 48rem; margin: auto; }
.eyebrow { font-size: .8rem; letter-spacing: .1em; text-transform: uppercase; opacity: .7; }
h1 { font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.1; overflow-wrap: anywhere; }
.results { display: flex; gap: 1rem; margin: 2rem 0; }
.results div { flex: 1; border: 1px solid #778399; border-radius: 1rem; padding: 1.5rem; }
strong { display: block; font-size: 3.5rem; }
.actions { display: flex; gap: .75rem; flex-wrap: wrap; margin: 1rem 0; }
button { font: inherit; padding: .9rem 1.25rem; border: 0; border-radius: .75rem; background: #3557c7; color: white; cursor: pointer; min-height: 44px; }
button:focus-visible { outline: 3px solid #e7a321; outline-offset: 3px; }
button:disabled { opacity: .45; cursor: default; }
#error { color: light-dark(#a51e1e, #ffb0b0); min-height: 1.5em; }
li { margin: .5rem 0; }
[hidden] { display: none !important; }
`;
