// Everyone votes yes or no on the room's question. The host page is the referee: it checks each vote and publishes the totals.
import { $, button, enqueue, mount, openRoom, role, run } from './room.js';
import { MIN_PLAYERS, castVote, tally } from './logic.js';
import { fill, t } from './texts.js';
/** @import { MiniEngine } from '/sdk/mini-engine.js' */

/** @typedef {{ prompt: string, allow_change: boolean }} Settings Mirrors settings_schema in manifest.json. */
/** @typedef {{ votes?: Record<string, boolean> }} PublicState Everyone sees this; each new round starts as {}. */

/** @type {MiniEngine<PublicState, Settings> | null} */
const client = openRoom();
if (client) {
  /** Host only, inside the queue: a player's vote or the host's own. @param {string} playerId @param {unknown} yes */
  const applyVote = async (playerId, yes) => {
    const room = client.room;
    if (!room || room.status !== 'running' || !room.players.some(player => player.id === playerId)) return;
    const votes = castVote(room.public_state.votes ?? {}, playerId, yes, room.settings.allow_change);
    if (votes) await client.setState({ expected_version: room.version, public_state: { votes } });
  };

  if (role === 'host') {
    client.on('action', action => enqueue(async () => {
      const data = action.data && typeof action.data === 'object' && !Array.isArray(action.data) ? action.data : {};
      if (action.name === 'vote') await applyVote(action.player_id, data.yes);
    }));
    button('finish').onclick = () => run(() => enqueue(() => client.lifecycle('finished')));
  }

  /** The host cannot send actions, so it applies its own vote. @param {boolean} yes */
  const vote = yes => run(async () => {
    if (role !== 'host') return client.action('vote', { yes });
    const own = client.room?.you.player_id;
    if (own) await enqueue(() => applyVote(own, yes));
  });
  button('vote-yes').onclick = () => vote(true);
  button('vote-no').onclick = () => vote(false);

  mount(client, (room, page) => {
    const votes = room.public_state.votes ?? {};
    const counts = tally(votes, room.players.map(player => player.id));
    const mine = room.you.player_id ? votes[room.you.player_id] : undefined;
    $('prompt').textContent = room.settings.prompt;
    $('rules').textContent = room.settings.allow_change ? t.changeAllowed : t.changeLocked;
    $('tally').hidden = room.status === 'lobby';
    $('yes').textContent = String(counts.yes);
    $('no').textContent = String(counts.no);
    if (room.status === 'running') $('status').textContent = fill(t.voted, { n: counts.yes + counts.no, total: room.players.length });
    if (room.status === 'finished') $('status').textContent = t.voteClosed;
    if (room.status !== 'running') $('choices').hidden = true;
    const locked = typeof mine === 'boolean' && !room.settings.allow_change;
    for (const [id, yes] of /** @type {const} */ ([['vote-yes', true], ['vote-no', false]])) {
      button(id).disabled = page.busy || !client.connected || !room.host_connected || locked;
      button(id).setAttribute('aria-pressed', String(mine === yes));
    }
    button('finish').hidden = room.status !== 'running';
    button('finish').disabled = page.busy || !client.connected;
  }, { minPlayers: MIN_PLAYERS });
  client.connect();
}
