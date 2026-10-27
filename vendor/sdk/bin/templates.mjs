import { readFileSync } from 'node:fs';
import { shared } from './templates/shared/texts.mjs';
import beurten from './templates/beurten/index.mjs';
import buzzer from './templates/buzzer/index.mjs';
import leeg from './templates/leeg/index.mjs';
import quiz from './templates/quiz/index.mjs';
import stemmen from './templates/stemmen/index.mjs';

/** The bundled SDK declarations, copied into each game so editors type-check `/sdk/mini-engine.js` imports offline. */
export const sdkDeclarations = readFileSync(new URL('../types/mini-engine.d.ts', import.meta.url), 'utf8');

/** Editor and tsc configuration only; the engine never serves it. Inside an engine checkout the first path wins. */
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
  // MiniEngineUI's vendored QR module is untyped; its qr.d.ts is checked instead.
  exclude: ['assets/ui/qr.js'],
};

export const TEMPLATES = { stemmen, quiz, buzzer, beurten, leeg };
export const LANGUAGES = ['nl', 'en'];
export const LOOKS = ['mini-engine-ui', 'plain'];
export const THEMES = ['kalk', 'nacht', 'vilt', 'studio'];
export const HOST_MODES = ['playing', 'tv'];
export const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const SHARED = new URL('./templates/shared/', import.meta.url);
const KIT = new URL('../skills/mini-engine-ui/kit/ui/', import.meta.url);
const KIT_FILES = ['mini-engine-ui.css', 'invite.js', 'qr.js', 'qr.d.ts', 'qr-LICENSE.txt', 'fonts/dm-sans.woff2', 'fonts/space-grotesk.woff2', 'fonts/DM-Sans-OFL.txt', 'fonts/Space-Grotesk-OFL.txt'];

/** @param {'nl' | 'en'} [language] */
export function templateList(language = 'en') {
  return Object.values(TEMPLATES).map(template => ({
    name: template.name,
    title: template.title[language],
    summary: template.summary[language],
    min_players: template.players[0],
    max_players: template.players[1],
    theme: template.theme,
  }));
}

/** `mijn-spel` becomes `Mijn Spel`. @param {string} slug */
export const titleFromSlug = slug => slug.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

/** Defaults: stemmen, English, plain look, playing and tv. @param {string} slug @param {{ template?: string, title?: string, language?: string, look?: string, theme?: string, hostModes?: string[], minPlayers?: number, maxPlayers?: number, display?: boolean }} [options] */
export function resolveOptions(slug, options = {}) {
  if (typeof slug !== 'string' || slug.length > 48 || !SLUG_PATTERN.test(slug)) {
    throw new Error('Slug must be 1–48 lowercase letters, digits and single hyphens, starting with a letter.');
  }
  const name = options.template ?? 'stemmen';
  const template = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : null;
  if (!template) throw new Error(`Unknown template "${name}". Choose one of: ${Object.keys(TEMPLATES).join(', ')}.`);
  const language = options.language ?? 'en';
  if (!LANGUAGES.includes(language)) throw new Error(`Unknown language "${language}". Choose one of: ${LANGUAGES.join(', ')}.`);
  const look = options.look ?? 'plain';
  if (!LOOKS.includes(look)) throw new Error(`Unknown look "${look}". Choose one of: ${LOOKS.join(', ')}.`);
  const theme = options.theme ?? template.theme;
  if (!THEMES.includes(theme)) throw new Error(`Unknown theme "${theme}". Choose one of: ${THEMES.join(', ')}.`);
  const hostModes = options.hostModes ?? ['playing', 'tv'];
  if (!Array.isArray(hostModes) || !hostModes.length || new Set(hostModes).size !== hostModes.length || !hostModes.every(mode => HOST_MODES.includes(mode))) {
    throw new Error('Host modes must be "playing", "tv" or both; the first one is the default.');
  }
  const minPlayers = options.minPlayers ?? template.players[0];
  const maxPlayers = options.maxPlayers ?? Math.max(template.players[1], minPlayers);
  if (![minPlayers, maxPlayers].every(Number.isInteger) || minPlayers < 1 || minPlayers > maxPlayers || maxPlayers > 100) {
    throw new Error('Players must be whole numbers with 1 ≤ min ≤ max ≤ 100.');
  }
  const title = (options.title ?? '').trim() || titleFromSlug(slug);
  if ([...title].length > 80 || /\p{Cc}/u.test(title)) throw new Error('Title must be at most 80 characters, without line breaks.');
  return { slug, template: template.name, title, language, look, theme, hostModes, minPlayers, maxPlayers, display: options.display ?? template.display };
}

const escapeHtml = text => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const quote = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const indent = (text, spaces) => text.trim().split('\n').map(line => (line ? ' '.repeat(spaces) + line : line)).join('\n');

function mergeTexts(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = typeof value === 'object' ? { ...base[key], ...value } : value;
  return out;
}

function textsModule(texts, language) {
  const lines = Object.entries(texts).map(([key, value]) => {
    if (typeof value === 'string') return `  ${key}: ${quote(value)},`;
    const inner = Object.entries(value).map(([name, text]) => `    ${name}: ${quote(text)},`).join('\n');
    return `  ${key}: /** @type {Record<string, string>} */ ({\n${inner}\n  }),`;
  });
  const intro = language === 'nl'
    ? '// Alle woorden van het spel. fill() vult de {plekken} in: fill(t.needPlayers, { n: 2 }).'
    : '// Every word of the game. fill() fills in the {slots}: fill(t.needPlayers, { n: 2 }).';
  return `${intro}
export const t = {
${lines.join('\n')}
};

/** @param {string} text @param {Record<string, string | number>} values */
export const fill = (text, values) => text.replace(/\\{(\\w+)\\}/g, (slot, name) => (name in values ? String(values[name]) : slot));
`;
}

/** Lines ending in //@ui or //@plain belong to one look only. */
function forLook(source, look) {
  const keep = look === 'mini-engine-ui' ? '//@ui' : '//@plain';
  return source
    .split('\n')
    .filter(line => !/ \/\/@(ui|plain)$/.test(line) || line.endsWith(` ${keep}`))
    .map(line => line.replace(/ \/\/@(ui|plain)$/, ''))
    .join('\n');
}

function page(role, o, x, stage) {
  const ui = o.look === 'mini-engine-ui';
  const base = `/games/${o.slug}/assets`;
  const title = escapeHtml(o.title);
  const lobby = `<div class="me-actions">
  <button type="button" id="ready" class="me-button is-primary is-wide" hidden>${x.ready}</button>
  <button type="button" id="start" class="me-button is-primary" hidden>${x.start}</button>
  <button type="button" id="again" class="me-button is-primary" hidden>${x.again}</button>
</div>
<ul id="players" class="me-roster" aria-label="${x.players}" hidden></ul>`;
  const head = `<!doctype html>
<html lang="${o.language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
${ui ? `  <link rel="stylesheet" href="${base}/ui/mini-engine-ui.css">\n` : ''}  <link rel="stylesheet" href="${base}/style.css">
</head>`;
  const script = `  <script type="module" src="${base}/app.js"></script>
</body>
</html>
`;
  if (!ui) {
    return `${head}
<body data-role="${role}">
  <main class="page">
    <header class="bar"><span>${title}</span><span id="code" class="bar-code"></span></header>
    <p id="error" class="me-notice is-error" role="alert"></p>
    <p id="away" class="me-notice" role="status"></p>
    <p id="achievement" class="me-notice" role="status"></p>
    <section id="invite" class="me-invite" hidden><span id="invite-label" class="me-label"></span><span id="invite-code" class="me-code"></span></section>
${indent(stage, 4)}
${indent(lobby, 4)}
  </main>
${script}`;
  }
  const code = role === 'display'
    ? '<span class="me-code" id="code"></span>'
    : `<button type="button" class="me-code" id="code"></button><button type="button" class="me-bar-button" id="show-qr">${x.showQr}</button>`;
  return `${head}
<body data-role="${role}" data-theme="${o.theme}">
  <div class="me-page">
    <header class="me-bar">
      <span class="me-bar-name">${title}</span>
      <div class="me-bar-end">${code}</div>
    </header>
    <div class="me-notices">
      <p id="error" class="me-notice is-error" role="alert"></p>
      <p id="away" class="me-notice" role="status"></p>
      <p id="achievement" class="me-notice me-reveal" role="status"></p>
    </div>
    <main class="me-stage">
      <div class="me-focus">
        <section id="invite" class="me-invite" hidden>
          <div id="invite-qr" class="me-qr"></div>
          <div class="me-invite-text"><span id="invite-label" class="me-label"></span><span id="invite-code" class="me-code"></span></div>
        </section>
${indent(stage, 8)}
${indent(lobby, 8)}
      </div>
    </main>
  </div>
${script}`;
}

function manifestFor(o, template, texts) {
  const own = template.manifest(o, texts);
  const manifest = {
    id: o.slug,
    title: o.title,
    description: own.description,
    version: '0.1.0',
    runtime: 'host',
    host_modes: o.hostModes,
    default_host_mode: o.hostModes[0],
    icon: 'assets/icon.svg',
    supports_late_join: template.lateJoin,
    min_players: o.minPlayers,
    max_players: o.maxPlayers,
    has_display: o.display,
    default_settings: own.default_settings,
    settings_schema: own.settings_schema,
  };
  if (own.achievements) manifest.achievements = own.achievements;
  if (own.set_kinds) manifest.set_kinds = own.set_kinds;
  return manifest;
}

function readme(o, template) {
  const nl = o.language === 'nl';
  const ui = o.look === 'mini-engine-ui';
  const own = template.readme[o.language](o);
  const pages = ['host.html', 'player.html', ...(o.display ? ['display.html'] : [])].map(name => `\`${name}\``).join(nl ? ', ' : ', ');
  const both = o.hostModes.length === 2;
  const mode = o.hostModes[0] === 'playing'
    ? nl
      ? `Je speelt zelf mee: *Iedereen doet mee* is de standaard, en je eigen plek staat meteen klaar.${both ? ' Kies op de server *TV* om de pagina van de host het gedeelde scherm te maken; iedereen speelt dan op de telefoon.' : ''}`
      : `You play along: *Iedereen doet mee* (everyone plays) is the default, and your own seat is ready at once.${both ? ' Pick *TV* on the server to make the host page the shared screen; everyone then plays on their phone.' : ''}`
    : nl
      ? `*TV* is de standaard: de pagina van de host is het gedeelde scherm, en iedereen speelt op de telefoon.${both ? ' Met *Iedereen doet mee* speelt de maker zelf mee.' : ''}`
      : `*TV* is the default: the host page is the shared screen, and everyone plays on their phone.${both ? ' With *Iedereen doet mee* the creator plays along.' : ''}`;
  const rows = nl
    ? [
        ['`manifest.json`', `Naam, spelers en instellingen${own.manifestExtra ?? ''}`],
        ['`assets/logic.js`', 'De spelregels, zonder scherm of netwerk'],
        ['`assets/app.js`', 'Wat elke pagina toont, en de scheidsrechter op de hostpagina'],
        ['`assets/room.js`', 'De vaste onderdelen: verbinding, kamercode, klaar zijn en starten'],
        ['`assets/texts.js`', 'Alle woorden van het spel'],
        ['`assets/style.css`', ui ? 'De eigen opmaak, bovenop MiniEngineUI in `assets/ui/`' : 'De opmaak'],
        ['`assets/icon.svg`', 'Het icoon op de startpagina van de server'],
        [pages, 'De pagina’s per rol'],
        ...(own.files ?? []),
        ['`tests/logic.test.mjs`', 'Tests voor de spelregels'],
      ]
    : [
        ['`manifest.json`', `Name, players and settings${own.manifestExtra ?? ''}`],
        ['`assets/logic.js`', 'The rules, without screens or network'],
        ['`assets/app.js`', 'What each page shows, and the referee on the host page'],
        ['`assets/room.js`', 'The fixed parts: connection, room code, ready and start'],
        ['`assets/texts.js`', 'Every word of the game'],
        ['`assets/style.css`', ui ? 'The game’s own styles, on top of MiniEngineUI in `assets/ui/`' : 'The styles'],
        ['`assets/icon.svg`', 'The icon on the server’s home page'],
        [pages, 'The page for each role'],
        ...(own.files ?? []),
        ['`tests/logic.test.mjs`', 'Tests for the rules'],
      ];
  const table = rows.map(([file, what]) => `| ${file} | ${what} |`).join('\n');
  if (nl) {
    return `# ${o.title}

${own.about}

Een spel voor Mini Engine 0.5.2 of nieuwer, gemaakt met het sjabloon \`${o.template}\`. De pagina van de host is de scheidsrechter: die controleert elke zet en publiceert de stand. Houd dat tabblad open tijdens het spelen.

## Spelen op je eigen computer

    me dev

\`me dev\` uit de Mini Engine CLI opent de host en twee spelers naast elkaar. ${mode} Sla je een bestand op, dan laden de pagina’s opnieuw en blijft de kamer bestaan.

Open de HTML-bestanden niet los in de browser: de pagina’s hebben een kamer nodig en \`/sdk/mini-engine.js\`, die \`me dev\` en de server leveren.

## Wat waar staat

| Bestand | Wat |
| --- | --- |
${table}

## Aanpassen

${own.customize}

Controleren:

    node --test tests/*.test.mjs
    npx -p typescript tsc -p jsconfig.json

## Publiceren

Met een dev key van wie de server beheert: \`me auth\`, dan \`me game upload\`. De eerste upload van een nieuwe game staat meteen live, voor iedereen op die server. Wil je hem eerst alleen zelf of met vrienden spelen, upload dan met \`me game upload --private\` en nodig ze uit met \`me game invite ${o.slug} <gebruikersnaam>\` (vanaf Mini Engine 0.9). Verhoog daarna \`version\` in \`manifest.json\` en upload met \`me game upload --activate\`.

\`jsconfig.json\` en \`types/\` zijn alleen voor je editor. \`.meignore\` houdt ze buiten de upload, en \`tests/\` gaat nooit mee.
`;
  }
  return `# ${o.title}

${own.about}

A game for Mini Engine 0.5.2 or later, made from the \`${o.template}\` template. The host page is the referee: it checks every move and publishes the state. Keep that tab open while you play.

## Play it on your own computer

    me dev

\`me dev\` from the Mini Engine CLI opens the host and two players side by side. ${mode} Saving a file reloads the pages and keeps the room.

Do not open the HTML files on their own: the pages need a room and \`/sdk/mini-engine.js\`, which \`me dev\` and the server provide.

## What is where

| File | What |
| --- | --- |
${table}

## Make it yours

${own.customize}

Check it:

    node --test tests/*.test.mjs
    npx -p typescript tsc -p jsconfig.json

## Publish

With a dev key from whoever runs the server: \`me auth\`, then \`me game upload\`. The first upload of a new game is live at once, for everyone on that server. To play it on your own or with friends first, upload with \`me game upload --private\` and invite them with \`me game invite ${o.slug} <username>\` (Mini Engine 0.9+). After that, raise \`version\` in \`manifest.json\` and upload with \`me game upload --activate\`.

\`jsconfig.json\` and \`types/\` are for your editor only. \`.meignore\` keeps them out of the upload, and \`tests/\` is never uploaded.
`;
}

/** Fonts are bytes, everything else text. @param {string} slug @param {Parameters<typeof resolveOptions>[1]} [options] @returns {Record<string, string | Uint8Array>} */
export function gameFiles(slug, options = {}) {
  const o = resolveOptions(slug, options);
  const template = TEMPLATES[o.template];
  const texts = mergeTexts(shared[o.language], template.texts[o.language]);
  const x = Object.fromEntries(Object.entries(texts).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, escapeHtml(value)]));
  const read = name => readFileSync(new URL(name, template.dir), 'utf8');
  const ui = o.look === 'mini-engine-ui';
  const css = ui
    ? `/* ${o.language === 'nl' ? 'De eigen opmaak van dit spel; MiniEngineUI in assets/ui/ doet de rest. Het thema staat in data-theme op <body>.' : 'This game’s own styles; MiniEngineUI in assets/ui/ does the rest. The theme is data-theme on <body>.'} */
body[data-view="screen"] .me-focus { max-width: 72rem; }
.me-actions:not(:has(> :not([hidden]))) { display: none; }
${template.css}`
    : `${readFileSync(new URL('plain.css', SHARED), 'utf8')}${template.css}`;
  const files = {
    'manifest.json': `${JSON.stringify(manifestFor(o, template, texts), null, 2)}\n`,
    'host.html': page('host', o, x, template.stage(o, x)),
    'player.html': page('player', o, x, template.stage(o, x)),
    ...(o.display ? { 'display.html': page('display', o, x, template.stage(o, x)) } : {}),
    'assets/app.js': read('app.js'),
    'assets/logic.js': read('logic.js').replace(/^export const MIN_PLAYERS = \d+;/m, `export const MIN_PLAYERS = ${o.minPlayers};`),
    'assets/room.js': forLook(readFileSync(new URL('room.js', SHARED), 'utf8'), o.look),
    'assets/texts.js': textsModule(texts, o.language),
    'assets/style.css': css,
    'assets/icon.svg': template.icon,
    'tests/logic.test.mjs': read('logic.test.mjs'),
    'jsconfig.json': `${JSON.stringify(jsconfig, null, 2)}\n`,
    'types/mini-engine.d.ts': sdkDeclarations,
    'README.md': readme(o, template),
    '.meignore': o.language === 'nl'
      ? '# Wat me game upload overslaat, naast verborgen bestanden, node_modules en tests/.\n# Alleen voor je editor:\njsconfig.json\ntypes/\n'
      : '# What me game upload skips, besides hidden files, node_modules and tests/.\n# Only for your editor:\njsconfig.json\ntypes/\n',
  };
  const data = template.data?.(o);
  if (data) files['data.json'] = `${JSON.stringify(data, null, 2)}\n`;
  if (ui) for (const name of KIT_FILES) files[`assets/ui/${name}`] = readFileSync(new URL(name, KIT));
  return files;
}
