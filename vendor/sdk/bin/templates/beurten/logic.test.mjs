import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFLINE_SKIP_MS, hold, newGame, offlineClock, offlineDue, roll, skip, sync } from '../assets/logic.js';

test('turns: roll, bank, and a 1 loses the points of the turn', () => {
  let game = newGame(['dani', 'sander'], 20);
  assert.equal(roll(game, 'sander', 4), null, 'only the player whose turn it is');
  game = roll(game, 'dani', 5) ?? assert.fail();
  game = roll(game, 'dani', 6) ?? assert.fail();
  assert.equal(game.pot, 11);
  game = hold(game, 'dani') ?? assert.fail();
  assert.deepEqual(game.scores, { dani: 11, sander: 0 });
  assert.equal(game.turn, 'sander');
  game = roll(game, 'sander', 3) ?? assert.fail();
  game = roll(game, 'sander', 1) ?? assert.fail();
  assert.equal(game.pot, 0);
  assert.equal(game.turn, 'dani');
  assert.equal(game.event?.kind, 'bust');
});

test('reaching the target wins', () => {
  let game = newGame(['dani', 'sander'], 10);
  game = roll(game, 'dani', 6) ?? assert.fail();
  game = roll(game, 'dani', 6) ?? assert.fail();
  game = hold(game, 'dani') ?? assert.fail();
  assert.equal(game.phase, 'done');
  assert.equal(game.winner, 'dani');
  assert.equal(roll(game, 'sander', 3), null);
});

test('a player who stays offline in their own turn is skipped after a while', () => {
  const game = newGame(['dani', 'sander'], 20);
  const away = [{ id: 'dani', connected: false }, { id: 'sander', connected: true }];
  const clock = offlineClock(null, game, away, null, 1000);
  assert.deepEqual(clock, { turn: 'dani', since: 1000 });
  assert.equal(offlineDue(offlineClock(clock, game, away, null, 5000), 5000), false);
  assert.equal(offlineDue(clock, 1000 + OFFLINE_SKIP_MS), true);
  assert.equal(offlineClock(null, game, away, 'dani', 1000), null, 'never the host’s own seat');
  assert.equal(skip(game)?.turn, 'sander');
});

test('a player who leaves passes the turn on, and the last one left wins', () => {
  const game = newGame(['dani', 'sander', 'kevin'], 20);
  assert.equal(sync(game, ['dani', 'sander', 'kevin']), game);
  const two = sync(game, ['sander', 'kevin']);
  assert.equal(two.turn, 'sander');
  assert.deepEqual(two.seats, ['sander', 'kevin']);
  const one = sync(two, ['kevin']);
  assert.equal(one.phase, 'done');
  assert.equal(one.winner, 'kevin');
});
