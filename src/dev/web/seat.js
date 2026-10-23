import { http, loadSession, saveSession } from '/sdk/mini-engine.js';

const root = document.querySelector('#seat');
const roles = { host: 'spelleider', player: 'speler', display: 'scherm' };

function show(title, text) {
  const heading = document.createElement('h1');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = text;
  root.className = 'message';
  root.replaceChildren(heading, body);
}

try {
  const match = location.pathname.match(/^\/room\/([A-Za-z0-9]{6})\/(host|player|display)\/?$/);
  if (!match) throw new Error('Deze stoellink klopt niet.');
  const code = match[1].toUpperCase();
  const role = match[2];
  if (location.hash.length > 1) {
    const credential = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    saveSession({ ...credential, code, role });
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!loadSession(code, role)) {
    show('Geen sessie op deze stoel.', 'Open deze stoel vanuit het overzicht van me dev.');
  } else {
    const info = await http(`/api/v1/rooms/${code}/info`);
    document.title = `${code} · ${roles[role]}`;
    const frame = document.createElement('iframe');
    frame.allowFullscreen = true;
    frame.allow = 'fullscreen; autoplay; clipboard-write; screen-wake-lock';
    frame.title = `${info.game_id} · ${roles[role]}`;
    frame.src = `/api/v1/games/${encodeURIComponent(info.game_id)}/${role}?room=${code}`;
    root.className = 'frame';
    root.replaceChildren(frame);
  }
} catch (error) {
  show('Deze kamer bestaat niet meer.', error.message);
}
