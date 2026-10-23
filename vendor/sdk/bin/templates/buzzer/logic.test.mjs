import test from 'node:test';
import assert from 'node:assert/strict';
import { addPress, decide, go, newGame, nextRound } from '../assets/logic.js';

test('the earliest press by the engine clock wins, whatever order the host heard them in', () => {
  let presses = addPress([], 'sander', 1014);
  presses = addPress(presses, 'dani', 1000);
  presses = addPress(presses, 'dani', 990);
  assert.equal(presses.length, 2, 'only the first press of a player counts');
  const game = decide(go(newGame(['dani', 'sander'], 3)), presses, []);
  assert.equal(game.winner, 'dani');
  assert.deepEqual(game.order.map(press => press.player_id), ['dani', 'sander']);
  assert.deepEqual(game.scores, { dani: 1, sander: 0 });
});

test('a press before the signal does not count', () => {
  const game = decide(go(newGame(['dani', 'sander'], 3)), [{ player_id: 'dani', ts: 900 }, { player_id: 'sander', ts: 1000 }], ['dani']);
  assert.equal(game.winner, 'sander');
  assert.deepEqual(game.early, ['dani']);
});

test('nobody pressing gives nobody a point, and the last round ends the game', () => {
  let game = decide(go(newGame(['dani'], 2)), [], []);
  assert.equal(game.winner, null);
  game = nextRound(game);
  assert.equal(game.round, 2);
  assert.equal(game.phase, 'wait');
  assert.equal(nextRound(decide(go(game), [], [])).phase, 'done');
});
