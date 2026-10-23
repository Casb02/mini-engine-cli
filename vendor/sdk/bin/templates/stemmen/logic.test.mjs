import test from 'node:test';
import assert from 'node:assert/strict';
import { castVote, tally } from '../assets/logic.js';

test('a vote counts once, and changes only when the room allows it', () => {
  const votes = castVote({}, 'dani', true, false);
  assert.deepEqual(votes, { dani: true });
  assert.equal(castVote(votes ?? {}, 'dani', false, false), null);
  assert.deepEqual(castVote(votes ?? {}, 'dani', false, true), { dani: false });
  assert.equal(castVote({}, 'dani', 'ja', true), null);
});

test('the tally only counts players who are still in the room', () => {
  assert.deepEqual(tally({ dani: true, sander: false, kevin: true }, ['dani', 'sander', 'pim']), { yes: 1, no: 1, open: 1 });
});
