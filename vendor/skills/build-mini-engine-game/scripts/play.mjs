// Drives one real room through the engine with Playwright: host, players and display in isolated browser contexts.
// Copy to games/<id>/tests/play.mjs, replace the game-specific block, then run from the engine checkout
// while the engine is running (npm ci once in the engine for Playwright):  node games/<id>/tests/play.mjs [baseUrl] [screenshotDir]
// The steps below match the scaffolded vote game.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const shots = process.argv[3] ?? '.';
await mkdir(shots, { recursive: true });
const gameId = new URL('..', import.meta.url).pathname.split('/').filter(Boolean).at(-1);
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
try {
  const host = await post('/api/v1/rooms', { game_id: gameId, config: { host_mode: 'moderator', display_enabled: true } });
  const players = [await post(`/api/v1/rooms/${host.code}/join`, { name: 'Dani' }), await post(`/api/v1/rooms/${host.code}/join`, { name: 'Sander' })];
  const hostSeat = await seat(host, { width: 1280, height: 800 });
  const [dani, sander] = await Promise.all(players.map(player => seat(player)));
  const displayContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const display = await displayContext.newPage();
  await display.goto(`${base}/room/${host.code}/display#${encodeURIComponent(host.display_token)}`);

  // ---- game-specific steps: replace with your own buttons and assertions ----
  for (const player of [dani, sander]) await player.game.locator('#ready').click();
  await hostSeat.game.locator('#start:not([disabled])').click();
  await dani.game.locator('#vote-yes:not([disabled])').click();
  await sander.game.locator('#vote-no:not([disabled])').click();
  await display.frameLocator('iframe').locator('#yes', { hasText: '1' }).waitFor();

  // Privacy: nothing secret may appear in a player's or the display's snapshot.
  const daniView = await snapshot(host.code, players[0].token);
  assert.equal(daniView.host_state, undefined);
  assert.equal(daniView.player_states, undefined);
  await display.screenshot({ path: join(shots, `display-${gameId}.png`) });
  await dani.page.screenshot({ path: join(shots, `player-${gameId}.png`) });
  console.log('play-through passed', host.code);
} finally {
  await browser.close();
}
