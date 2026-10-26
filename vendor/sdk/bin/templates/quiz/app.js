// Multiple-choice questions against the clock, with a final board. The host page is the referee and the only page that knows the answers.
import { ApiClient } from '/sdk/mini-engine.js';
import { $, button, drawScores, enqueue, mount, openRoom, role, run, showError } from './room.js';
import { MIN_PLAYERS, REVEAL_MS, advance, allAnswered, answer, newQuiz, perfect, pickQuestions, reveal } from './logic.js';
import { fill, t } from './texts.js';
/** @import { MiniEngine, Snapshot } from '/sdk/mini-engine.js' */
/** @import { Quiz, Secret } from './logic.js' */

/** @typedef {{ count: number, seconds: number }} Settings Mirrors settings_schema in manifest.json. */
/** @typedef {Partial<Quiz>} PublicState Everyone sees this; each new game starts as {}. */
/** @typedef {Snapshot<PublicState, Settings, { pick: number } | null>} Room private_state holds each player's own answer. */

/** @type {MiniEngine<PublicState, Settings, { pick: number } | null> | null} */
const client = openRoom();
if (client) {
  /** @param {Room} room */
  const quizOf = room => (room.public_state.phase ? /** @type {Quiz} */ (room.public_state) : null);
  /** @param {Room} room */
  const secretOf = room => /** @type {Secret | null} */ (room.host_state ?? null);

  /** Host only. player_states is rebuilt from the players in the room, so a player who left never blocks setState. @param {Room} room @param {Quiz} quiz @param {Secret} secret */
  const publish = (room, quiz, secret) => client.setState({
    expected_version: room.version,
    public_state: quiz,
    host_state: secret,
    player_states: Object.fromEntries(room.players.filter(player => Object.hasOwn(secret.picks, player.id)).map(player => [player.id, { pick: secret.picks[player.id] }])),
  });

  /** Host only, inside the queue: a player's answer or the host's own. @param {string} playerId @param {unknown} choice */
  const applyAnswer = async (playerId, choice) => {
    const room = client.room;
    const quiz = room && quizOf(room);
    const secret = room && secretOf(room);
    if (!room || !quiz || !secret || room.status !== 'running' || !room.players.some(player => player.id === playerId)) return;
    const next = answer(quiz, secret, playerId, choice);
    if (!next) return;
    const everyone = allAnswered(next.quiz, room.players.map(player => player.id));
    await publish(room, everyone ? reveal(next.quiz, next.secret) : next.quiz, next.secret);
  };

  if (role === 'host') {
    let timer = 0;
    let planned = '';
    /** Time runs on the host: it reveals at the deadline and moves on after REVEAL_MS. @param {Quiz} quiz */
    const plan = quiz => {
      const key = `${quiz.phase}:${quiz.index}`;
      if (key === planned) return;
      planned = key;
      clearTimeout(timer);
      if (quiz.phase === 'done') return;
      const wait = quiz.phase === 'question' ? quiz.deadline - Date.now() : REVEAL_MS;
      timer = window.setTimeout(() => enqueue(() => step(key)), Math.max(0, wait));
    };
    /** @param {string} key */
    const step = async key => {
      const room = client.room;
      const quiz = room && quizOf(room);
      const secret = room && secretOf(room);
      if (!room || !quiz || !secret || room.status !== 'running' || `${quiz.phase}:${quiz.index}` !== key) return;
      if (quiz.phase === 'question') return publish(room, reveal(quiz, secret), secret);
      const next = advance(quiz, secret, Date.now() + room.settings.seconds * 1000);
      await publish(room, next.quiz, next.secret);
      if (next.quiz.phase !== 'done') return;
      await client.lifecycle('finished');
      for (const id of perfect(next.quiz)) {
        // Guests and rooms made without logging in cannot earn achievements; the game goes on.
        if (room.players.find(player => player.id === id)?.account_id) client.award(id, 'perfect').catch(() => {});
      }
    };

    client.on('snapshot', () => enqueue(async () => {
      const room = client.room;
      if (!room || room.status !== 'running') return;
      const quiz = quizOf(room);
      if (quiz) return plan(quiz);
      // data.json, or the player's own set the room was made with.
      const data = /** @type {{ questions?: unknown } | null} */ (await new ApiClient().gameData(room.code, client.token));
      const now = client.room;
      if (!now || now.status !== 'running' || quizOf(now)) return;
      const questions = pickQuestions(Array.isArray(data?.questions) ? data.questions : [], now.settings.count, Math.random);
      if (!questions.length) {
        showError(new Error(t.noQuestions));
        return client.lifecycle('lobby');
      }
      const start = newQuiz(now.players.map(player => player.id), questions, Date.now() + now.settings.seconds * 1000);
      await publish(now, start.quiz, start.secret);
    }));
    client.on('action', action => enqueue(async () => {
      const data = action.data && typeof action.data === 'object' && !Array.isArray(action.data) ? action.data : {};
      if (action.name === 'answer') await applyAnswer(action.player_id, data.choice);
    }));
  }

  /** @param {number} choice */
  const send = choice => run(async () => {
    if (role !== 'host') return client.action('answer', { choice });
    const own = client.room?.you.player_id;
    if (own) await enqueue(() => applyAnswer(own, choice));
  });

  /** @param {Room} room */
  const ownPick = room => {
    const me = room.you.player_id;
    if (!me) return undefined;
    return role === 'host' ? secretOf(room)?.picks[me] : room.private_state?.pick;
  };
  /** @param {Quiz} quiz */
  const progress = quiz => {
    const seconds = Math.max(0, Math.ceil((quiz.deadline - Date.now()) / 1000));
    const where = fill(t.progress, { n: quiz.index + 1, total: quiz.total });
    return quiz.phase === 'question' ? `${where} · ${fill(t.secondsLeft, { s: seconds })}` : where;
  };

  /** An image field is `/media/…` (same origin) or a package path `assets/…`, resolved from this module in assets/. @param {string} image */
  const imageSrc = image => (image.startsWith('assets/') ? new URL(image.slice('assets/'.length), import.meta.url).href : image);
  const picture = /** @type {HTMLImageElement} */ ($('picture'));

  let shown = -1;
  mount(client, (room, page) => {
    const quiz = quizOf(room);
    $('rules').textContent = fill(t.rules, { count: room.settings.count, seconds: room.settings.seconds });
    $('rules').hidden = room.status !== 'lobby';
    $('answers').hidden = !quiz || quiz.phase === 'done';
    $('scores').hidden = !quiz || quiz.phase === 'question';
    const image = quiz && quiz.phase !== 'done' && quiz.image ? imageSrc(quiz.image) : '';
    picture.hidden = !image;
    if (image && picture.getAttribute('src') !== image) picture.src = image;
    if (!quiz) {
      $('question').textContent = t.headline;
      $('progress').textContent = '';
      return;
    }
    const me = room.you.player_id ?? '';
    const pick = quiz.phase === 'reveal' ? quiz.picks[me] : ownPick(room);
    const right = quiz.correct === null ? '' : quiz.answers[quiz.correct];
    $('question').textContent = quiz.phase === 'done' ? t.final : quiz.question;
    $('progress').textContent = quiz.phase === 'done' ? '' : progress(quiz);

    const list = $('answers');
    if (shown !== quiz.index || list.children.length !== quiz.answers.length) {
      shown = quiz.index;
      list.replaceChildren(...quiz.answers.map((text, index) => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'me-choice';
        choice.textContent = text;
        choice.onclick = () => send(index);
        return choice;
      }));
    }
    const open = !page.screen && quiz.phase === 'question' && pick === undefined && !quiz.answered[me];
    list.querySelectorAll('button').forEach((choice, index) => {
      choice.disabled = !open || page.busy || !client.connected || !room.host_connected;
      choice.setAttribute('aria-pressed', String(pick === index));
      choice.classList.toggle('is-correct', quiz.phase === 'reveal' && quiz.correct === index);
      choice.classList.toggle('is-wrong', quiz.phase === 'reveal' && pick === index && quiz.correct !== index);
    });

    const answered = Object.keys(quiz.answered).length;
    const best = Math.max(0, ...room.players.map(player => quiz.scores[player.id] ?? 0));
    const names = room.players.filter(player => (quiz.scores[player.id] ?? 0) === best).map(player => player.name).join(', ');
    $('status').textContent =
      quiz.phase === 'question' ? (page.screen ? fill(t.answeredCount, { n: answered, total: room.players.length }) : quiz.answered[me] ? t.waitOthers : t.pickAnswer)
      : quiz.phase === 'reveal' ? (page.screen ? fill(t.answerWas, { answer: right }) : pick === quiz.correct ? t.right : fill(pick === undefined ? t.noAnswer : t.wrong, { answer: right }))
      : page.screen || !me ? fill(t.best, { names }) : fill(t.yourScore, { n: quiz.scores[me] ?? 0, total: quiz.total });
    drawScores($('scores'), room.players, quiz.scores, { you: room.you.player_id, sorted: quiz.phase === 'done' });
  }, { minPlayers: MIN_PLAYERS });

  setInterval(() => {
    const quiz = client.room && quizOf(client.room);
    if (quiz?.phase === 'question') $('progress').textContent = progress(quiz);
  }, 500);
  client.connect();
}
