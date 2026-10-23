// The rules, without screens or network, so tests/logic.test.mjs can check them with node --test.

/** Keep equal to min_players in manifest.json. */
export const MIN_PLAYERS = 1;

/** @typedef {{ taps: Record<string, number> }} Game */

/** @param {string[]} playerIds @returns {Game} */
export function newGame(playerIds) {
  return { taps: Object.fromEntries(playerIds.map(id => [id, 0])) };
}

/** An example move to replace with your own. Null when it is not allowed. @param {Game} game @param {string} playerId @returns {Game | null} */
export function tap(game, playerId) {
  if (!Object.hasOwn(game.taps, playerId)) return null;
  return { ...game, taps: { ...game.taps, [playerId]: game.taps[playerId] + 1 } };
}
