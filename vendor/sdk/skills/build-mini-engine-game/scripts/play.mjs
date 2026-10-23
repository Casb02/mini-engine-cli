// Plays one room with Playwright against `me dev` or a server; usage in references/verify-and-troubleshoot.md.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] ?? 'http://127.0.0.1:3170').replace(/\/$/, '');
const shots = process.argv[3] ?? fileURLToPath(new URL('.', import.meta.url));
await mkdir(shots, { recursive: true });
const gameId = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8')).id;
const post = async (path, body, token) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const snapshot = async (code, token) => (await fetch(`${base}/api/v1/rooms/${code}`, { headers: { authorization: `Bearer ${token}` } })).json();

const browser = await chromium.launch();
/** Open a seat the way the room launcher does: credentials in that tab's sessionStorage, game in the shell's iframe. */
async function seat(session, { width = 390, height = 844 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [`mini-engine:${session.code}:${session.role}`, JSON.stringify(session)]);
  const page = await context.newPage();
  page.on('pageerror', error => console.error(`[${session.role}] ${error.message}`));
  page.on('console', message => message.type() === 'error' && console.error(`[${session.role}] ${message.text()}`));
  await page.goto(`${base}/room/${session.code}/${session.role}`);
  return { page, game: page.frameLocator('iframe') };
}
// Achievements only reach logged-in seats: see verify-and-troubleshoot.md, "Achievements".
try {
  // Everyone plays, the host too (the scaffold's default); use host_mode 'tv' and drop `name` to test the TV, whose host page is the shared screen.
  const host = await post('/api/v1/rooms', { game_id: gameId, name: 'Hessel', config: { host_mode: 'playing', display_enabled: true } });
  const players = [await post(`/api/v1/rooms/${host.code}/join`, { name: 'Dani' }), await post(`/api/v1/rooms/${host.code}/join`, { name: 'Sander' })];
  const hostSeat = await seat(host, { width: 1280, height: 800 });
  const [dani, sander] = await Promise.all(players.map(player => seat(player)));
  const display = await seat({ code: host.code, token: host.display_token, role: 'display', player_id: null }, { width: 1920, height: 1080 });

  // ---- game-specific steps: replace with your own buttons and assertions ----
  for (const player of [dani, sander]) await player.game.locator('#ready').click();
  await hostSeat.game.locator('#start:not([disabled])').click();
  await hostSeat.game.locator('#vote-yes:not([disabled])').click();
  await dani.game.locator('#vote-yes:not([disabled])').click();
  await sander.game.locator('#vote-no:not([disabled])').click();
  await display.game.locator('#yes', { hasText: '2' }).waitFor();
  assert.equal((await snapshot(host.code, host.token)).host_player_id, host.player_id);

  // Privacy: nothing secret may appear in a player's or the display's snapshot.
  const daniView = await snapshot(host.code, players[0].token);
  assert.equal(daniView.host_state, undefined);
  assert.equal(daniView.player_states, undefined);
  await display.page.screenshot({ path: join(shots, `display-${gameId}.png`) });
  await dani.page.screenshot({ path: join(shots, `player-${gameId}.png`) });
  console.log('play-through passed', host.code);
} finally {
  await browser.close();
}
