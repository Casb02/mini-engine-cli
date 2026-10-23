// The rules, without screens or network, so tests/logic.test.mjs can check them with node --test.

/** Keep equal to min_players in manifest.json. */
export const MIN_PLAYERS = 2;
/** After the first press the host waits this long for the others, then sorts by the engine's ts. */
export const COLLECT_MS = 150;
export const WAIT_MS = { min: 2000, max: 5000 };
export const GIVE_UP_MS = 8000;
export const RESULT_MS = 4000;

/** @typedef {{ player_id: string, ts: number }} Press ts: when the engine received the press, in ms. */
/** @typedef {{ phase: 'wait' | 'go' | 'result' | 'done', round: number, rounds: number, scores: Record<string, number>, order: Press[], early: string[], winner: string | null }} Game */

/** @param {string[]} playerIds @param {number} rounds @returns {Game} */
export function newGame(playerIds, rounds) {
  return { phase: 'wait', round: 1, rounds, scores: Object.fromEntries(playerIds.map(id => [id, 0])), order: [], early: [], winner: null };
}

/** @param {Game} game @returns {Game} */
export const go = game => ({ ...game, phase: 'go' });

/** Only a player's first press of a round counts. @param {Press[]} presses @param {string} playerId @param {number} ts */
export const addPress = (presses, playerId, ts) => (presses.some(press => press.player_id === playerId) ? presses : [...presses, { player_id: playerId, ts }]);

/** The earliest press by the engine's clock wins; a press before the signal does not count. @param {Game} game @param {Press[]} presses @param {string[]} early @returns {Game} */
export function decide(game, presses, early) {
  const order = presses.filter(press => !early.includes(press.player_id) && Object.hasOwn(game.scores, press.player_id)).sort((a, b) => a.ts - b.ts);
  const winner = order[0]?.player_id ?? null;
  const scores = winner ? { ...game.scores, [winner]: game.scores[winner] + 1 } : game.scores;
  return { ...game, phase: 'result', order, early, winner, scores };
}

/** @param {Game} game @returns {Game} */
export function nextRound(game) {
  if (game.round >= game.rounds) return { ...game, phase: 'done' };
  return { ...game, phase: 'wait', round: game.round + 1, order: [], early: [], winner: null };
}
