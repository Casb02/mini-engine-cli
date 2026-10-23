import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, tap } from '../assets/logic.js';

test('a new game gives every player a count of zero', () => {
  assert.deepEqual(newGame(['dani', 'sander']), { taps: { dani: 0, sander: 0 } });
});

test('a tap counts for players in the game only', () => {
  const game = newGame(['dani']);
  assert.deepEqual(tap(game, 'dani'), { taps: { dani: 1 } });
  assert.equal(tap(game, 'pim'), null);
});
