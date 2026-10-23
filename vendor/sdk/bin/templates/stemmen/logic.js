// The rules, without screens or network, so tests/logic.test.mjs can check them with node --test.

/** Keep equal to min_players in manifest.json. */
export const MIN_PLAYERS = 1;

/** Null when the vote is not allowed. @param {Record<string, boolean>} votes @param {string} playerId @param {unknown} yes @param {boolean} allowChange @returns {Record<string, boolean> | null} */
export function castVote(votes, playerId, yes, allowChange) {
  if (typeof yes !== 'boolean') return null;
  if (Object.hasOwn(votes, playerId) && (!allowChange || votes[playerId] === yes)) return null;
  return { ...votes, [playerId]: yes };
}

/** Counts only the players who are still in the room. @param {Record<string, boolean>} votes @param {string[]} playerIds */
export function tally(votes, playerIds) {
  let yes = 0;
  let no = 0;
  for (const id of playerIds) {
    if (votes[id] === true) yes += 1;
    else if (votes[id] === false) no += 1;
  }
  return { yes, no, open: playerIds.length - yes - no };
}
