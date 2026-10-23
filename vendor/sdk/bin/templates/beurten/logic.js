// The rules, without screens or network, so tests/logic.test.mjs can check them with node --test.

/** Keep equal to min_players in manifest.json. */
export const MIN_PLAYERS = 2;
/** A player who is offline this long within their own turn is skipped. */
export const OFFLINE_SKIP_MS = 30_000;

/** @typedef {{ kind: 'rolled' | 'bust' | 'held' | 'skipped' | 'won', player: string, value: number }} Event */
/** @typedef {{ phase: 'turn' | 'done', seats: string[], turn: string, die: number | null, pot: number, scores: Record<string, number>, target: number, step: number, event: Event | null, winner: string | null }} Game */
/** @typedef {{ turn: string, since: number | null }} OfflineClock since: when the referee saw the player of this turn go offline. */

/** @param {string[]} playerIds @param {number} target @param {number} [first] @returns {Game} */
export function newGame(playerIds, target, first = 0) {
  const scores = Object.fromEntries(playerIds.map(id => [id, 0]));
  return { phase: 'turn', seats: playerIds, turn: playerIds[first] ?? '', die: null, pot: 0, scores, target, step: 0, event: null, winner: null };
}

/** @param {Game} game @param {string} id */
const nextSeat = (game, id) => game.seats[(game.seats.indexOf(id) + 1) % game.seats.length];

/** A 1 loses the points of this turn and passes it on. Null when it is not this player's turn. @param {Game} game @param {string} playerId @param {number} value @returns {Game | null} */
export function roll(game, playerId, value) {
  if (game.phase !== 'turn' || game.turn !== playerId || !Number.isInteger(value) || value < 1 || value > 6) return null;
  if (value === 1) return { ...game, die: 1, pot: 0, turn: nextSeat(game, playerId), step: game.step + 1, event: { kind: 'bust', player: playerId, value: game.pot } };
  return { ...game, die: value, pot: game.pot + value, step: game.step + 1, event: { kind: 'rolled', player: playerId, value } };
}

/** Banks the points of this turn; reaching the target wins. @param {Game} game @param {string} playerId @returns {Game | null} */
export function hold(game, playerId) {
  if (game.phase !== 'turn' || game.turn !== playerId || game.pot === 0) return null;
  const score = (game.scores[playerId] ?? 0) + game.pot;
  const scores = { ...game.scores, [playerId]: score };
  if (score >= game.target) return { ...game, phase: 'done', scores, pot: 0, step: game.step + 1, winner: playerId, event: { kind: 'won', player: playerId, value: score } };
  return { ...game, scores, pot: 0, die: null, turn: nextSeat(game, playerId), step: game.step + 1, event: { kind: 'held', player: playerId, value: game.pot } };
}

/** The referee skips a player who stayed away too long in their own turn. @param {Game} game @returns {Game | null} */
export function skip(game) {
  if (game.phase !== 'turn') return null;
  return { ...game, pot: 0, die: null, turn: nextSeat(game, game.turn), step: game.step + 1, event: { kind: 'skipped', player: game.turn, value: 0 } };
}

/** Drops players who left the room; their turn passes on. The same object when nobody left. @param {Game} game @param {string[]} present @returns {Game} */
export function sync(game, present) {
  const seats = game.seats.filter(id => present.includes(id));
  if (seats.length === game.seats.length || game.phase === 'done') return game;
  if (seats.length < 2) return { ...game, seats, phase: 'done', winner: seats[0] ?? null, pot: 0, step: game.step + 1 };
  if (seats.includes(game.turn)) return { ...game, seats, step: game.step + 1 };
  const start = game.seats.indexOf(game.turn);
  const turn = [...game.seats.slice(start + 1), ...game.seats.slice(0, start)].find(id => seats.includes(id)) ?? seats[0];
  return { ...game, seats, turn, pot: 0, die: null, step: game.step + 1 };
}

/** Counts offline time within the current turn only, never for the host's own seat. @param {OfflineClock | null} clock @param {Game} game @param {{ id: string, connected: boolean }[]} players @param {string | null} hostSeat @param {number} now @returns {OfflineClock | null} */
export function offlineClock(clock, game, players, hostSeat, now) {
  if (game.phase !== 'turn' || game.turn === hostSeat) return null;
  const player = players.find(entry => entry.id === game.turn);
  if (!player) return null;
  if (player.connected) return { turn: game.turn, since: null };
  const running = clock?.turn === game.turn && clock.since !== null;
  return { turn: game.turn, since: running ? /** @type {number} */ (clock.since) : now };
}

/** @param {OfflineClock | null} clock @param {number} now */
export const offlineDue = (clock, now) => clock != null && clock.since !== null && now - clock.since >= OFFLINE_SKIP_MS;
