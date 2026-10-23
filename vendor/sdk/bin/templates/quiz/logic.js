// The rules, without screens or network, so tests/logic.test.mjs can check them with node --test.

/** Keep equal to min_players in manifest.json. */
export const MIN_PLAYERS = 1;
/** How long everyone sees the right answer before the next question. */
export const REVEAL_MS = 5000;

/** @typedef {{ text: string, answers: string[], correct: number }} Question */
/** @typedef {{ phase: 'question' | 'reveal' | 'done', index: number, total: number, question: string, answers: string[], deadline: number, answered: Record<string, boolean>, scores: Record<string, number>, correct: number | null, picks: Record<string, number> }} Quiz Public: everyone sees it. */
/** @typedef {{ questions: Question[], picks: Record<string, number> }} Secret Only the host sees it. */

/** A line reads "question | right answer | wrong answer | …". @param {unknown} line @returns {{ text: string, answers: string[] } | null} */
export function parseLine(line) {
  if (typeof line !== 'string') return null;
  const [text, ...rest] = line.split('|').map(part => part.trim());
  const answers = rest.filter(Boolean);
  if (!text || answers.length < 2 || answers.length > 6) return null;
  return { text, answers };
}

/** @template T @param {T[]} list @param {() => number} random */
function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Picks `count` questions in a random order, each with its answers shuffled. @param {unknown[]} lines @param {number} count @param {() => number} random @returns {Question[]} */
export function pickQuestions(lines, count, random) {
  const parsed = lines.map(parseLine).filter(question => question !== null);
  return shuffle(parsed, random).slice(0, count).map(({ text, answers }) => {
    const order = shuffle(answers.map((_, index) => index), random);
    return { text, answers: order.map(index => answers[index]), correct: order.indexOf(0) };
  });
}

/** @param {Quiz} quiz @param {Secret} secret @param {number} index @param {number} deadline @returns {Quiz} */
function ask(quiz, secret, index, deadline) {
  const { text, answers } = secret.questions[index];
  return { ...quiz, phase: 'question', index, question: text, answers, deadline, answered: {}, correct: null, picks: {} };
}

/** @param {string[]} playerIds @param {Question[]} questions @param {number} deadline @returns {{ quiz: Quiz, secret: Secret }} */
export function newQuiz(playerIds, questions, deadline) {
  const secret = { questions, picks: {} };
  const scores = Object.fromEntries(playerIds.map(id => [id, 0]));
  const blank = { phase: /** @type {const} */ ('question'), index: 0, total: questions.length, question: '', answers: [], deadline, answered: {}, scores, correct: null, picks: {} };
  return { quiz: ask(blank, secret, 0, deadline), secret };
}

/** Null when the answer does not count: wrong phase, unknown player, a second answer or no such choice. @param {Quiz} quiz @param {Secret} secret @param {string} playerId @param {unknown} choice */
export function answer(quiz, secret, playerId, choice) {
  if (quiz.phase !== 'question' || !Object.hasOwn(quiz.scores, playerId) || quiz.answered[playerId]) return null;
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= quiz.answers.length) return null;
  return {
    quiz: { ...quiz, answered: { ...quiz.answered, [playerId]: true } },
    secret: { ...secret, picks: { ...secret.picks, [playerId]: choice } },
  };
}

/** @param {Quiz} quiz @param {string[]} playerIds */
export const allAnswered = (quiz, playerIds) => playerIds.every(id => quiz.answered[id] || !Object.hasOwn(quiz.scores, id));

/** Shows the right answer and gives a point for each right pick. @param {Quiz} quiz @param {Secret} secret @returns {Quiz} */
export function reveal(quiz, secret) {
  const correct = secret.questions[quiz.index].correct;
  const scores = { ...quiz.scores };
  for (const [id, pick] of Object.entries(secret.picks)) if (pick === correct && Object.hasOwn(scores, id)) scores[id] += 1;
  return { ...quiz, phase: 'reveal', correct, picks: secret.picks, scores };
}

/** The next question, or the end after the last one. @param {Quiz} quiz @param {Secret} secret @param {number} deadline */
export function advance(quiz, secret, deadline) {
  const next = { ...secret, picks: {} };
  if (quiz.index + 1 >= quiz.total) return { quiz: { ...quiz, phase: /** @type {const} */ ('done') }, secret: next };
  return { quiz: ask(quiz, next, quiz.index + 1, deadline), secret: next };
}

/** Players who answered every question right. @param {Quiz} quiz */
export const perfect = quiz => Object.keys(quiz.scores).filter(id => quiz.total >= 3 && quiz.scores[id] === quiz.total);
