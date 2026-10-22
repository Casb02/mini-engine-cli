const $ = selector => document.querySelector(selector);
const seatsElement = $('#seats');
const cards = new Map();
const statusText = { lobby: 'in de lobby', running: 'bezig', finished: 'afgelopen' };
let generation = null;
let reloads = 0;

function notice(text) {
  $('#notice').hidden = !text;
  $('#notice').textContent = text ?? '';
}

function seatUrl(seat, bump) {
  const query = bump === undefined ? '' : `?r=${bump}`;
  return `${location.protocol}//${location.hostname}:${seat.port}${seat.path}${query}#${seat.hash}`;
}

function createCard(seat) {
  const card = document.createElement('section');
  card.className = `seat seat-${seat.role}`;
  const header = document.createElement('header');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const presence = document.createElement('span');
  presence.className = 'sr-only';
  const title = document.createElement('h2');
  const port = document.createElement('span');
  port.className = 'port';
  const open = document.createElement('a');
  open.className = 'quiet';
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Openen';
  const reload = document.createElement('button');
  reload.className = 'quiet';
  reload.type = 'button';
  reload.textContent = 'Herladen';
  const screen = document.createElement('div');
  screen.className = 'screen';
  header.append(dot, presence, title, port, open, reload);
  card.append(header, screen);
  const entry = { card, dot, presence, title, port, open, reload, screen, key: null, seat };
  reload.addEventListener('click', () => load(entry));
  return entry;
}

function load(entry) {
  const { seat } = entry;
  if (!seat.path) return;
  reloads += 1;
  let frame = entry.screen.querySelector('iframe');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.allow = 'fullscreen; autoplay; clipboard-write';
    entry.screen.replaceChildren(frame);
  }
  frame.title = seat.label;
  frame.src = seatUrl(seat, reloads);
}

function update(entry, seat, reloadAll) {
  entry.seat = seat;
  entry.title.textContent = seat.label;
  entry.port.textContent = `poort ${seat.port}`;
  entry.dot.classList.toggle('on', seat.connected);
  entry.presence.textContent = seat.connected ? 'Verbonden' : 'Niet verbonden';
  entry.dot.title = seat.connected ? 'Verbonden' : 'Niet verbonden';
  entry.reload.hidden = !seat.path;
  entry.open.hidden = !seat.path;
  if (!seat.path) {
    entry.key = null;
    const text = document.createElement('p');
    text.className = 'empty';
    text.textContent = seat.error ?? 'Geen kamer.';
    entry.screen.replaceChildren(text);
    return;
  }
  entry.open.href = seatUrl(seat);
  const key = `${seat.path}#${seat.hash}`;
  if (key !== entry.key || reloadAll) {
    entry.key = key;
    load(entry);
  }
}

function render(state) {
  const { game, room } = state;
  document.title = `${game.title} · me dev`;
  $('#title').textContent = game.title;
  const parts = [`versie ${game.version}`, room ? `kamer ${room.code}, ${statusText[room.status] ?? room.status}` : 'geen kamer'];
  if (state.set) parts.push(`set ${state.set.title}`);
  $('#meta').textContent = parts.join(' · ');
  $('#problem').hidden = !state.problem;
  $('#problem-text').textContent = state.problem ?? '';
  $('#add-player').disabled = !room;
  if (!room) notice('De kamer is gesloten. Maak een nieuwe kamer om verder te testen.');
  else if ($('#notice').dataset.kind !== 'error') notice(null);
  const reloadAll = generation !== null && state.generation !== generation;
  generation = state.generation;
  const seen = new Set();
  let previous = null;
  for (const seat of state.seats) {
    seen.add(seat.id);
    let entry = cards.get(seat.id);
    if (!entry) {
      entry = createCard(seat);
      cards.set(seat.id, entry);
      seatsElement.insertBefore(entry.card, previous ? previous.card.nextSibling : seatsElement.firstChild);
    }
    update(entry, seat, reloadAll);
    previous = entry;
  }
  for (const [id, entry] of cards) {
    if (!seen.has(id)) {
      entry.card.remove();
      cards.delete(id);
    }
  }
}

async function post(path, button) {
  button.disabled = true;
  $('#notice').dataset.kind = '';
  try {
    const response = await fetch(path, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? 'Dat lukte niet.');
    render(body);
  } catch (error) {
    $('#notice').dataset.kind = 'error';
    notice(error.message);
  } finally {
    button.disabled = false;
  }
}

$('#add-player').addEventListener('click', event => post('/__me/players', event.currentTarget));
$('#new-room').addEventListener('click', event => post('/__me/room', event.currentTarget));

const events = new EventSource('/__me/events');
events.addEventListener('state', event => render(JSON.parse(event.data)));
events.addEventListener('open', () => {
  if ($('#notice').dataset.kind === 'offline') {
    $('#notice').dataset.kind = '';
    notice(null);
  }
});
events.addEventListener('error', () => {
  $('#notice').dataset.kind = 'offline';
  notice('Geen verbinding met me dev. Draait het nog?');
});
