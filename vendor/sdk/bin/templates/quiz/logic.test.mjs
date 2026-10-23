import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, allAnswered, answer, newQuiz, parseLine, perfect, pickQuestions, reveal } from '../assets/logic.js';

const lines = [
  'Hoeveel poten heeft een spin? | Acht | Zes | Tien',
  'Welke kleur krijg je met blauw en geel? | Groen | Paars',
  'Hoeveel zijden heeft een zeshoek? | Zes | Vijf | Acht | Zeven',
];
const first = () => 0;

test('a line needs a question and two to six answers', () => {
  assert.deepEqual(parseLine(' Waar? | Hier | Daar '), { text: 'Waar?', answers: ['Hier', 'Daar'] });
  assert.equal(parseLine('Alleen een vraag | Ja'), null);
  assert.equal(parseLine(42), null);
});

test('picked questions keep track of the right answer after shuffling', () => {
  const questions = pickQuestions([...lines, 'kapot'], 10, Math.random);
  assert.equal(questions.length, 3);
  for (const question of questions) assert.ok(['Acht', 'Groen', 'Zes'].includes(question.answers[question.correct]));
});

test('a full quiz: answers, reveal, scores and the end', () => {
  let { quiz, secret } = newQuiz(['dani', 'sander'], pickQuestions(lines, 3, first), 1000);
  const right = secret.questions[0].correct;
  assert.equal(quiz.correct, null, 'the answer stays secret');
  ({ quiz, secret } = answer(quiz, secret, 'dani', right) ?? assert.fail());
  assert.equal(answer(quiz, secret, 'dani', right), null, 'one answer per question');
  assert.equal(answer(quiz, secret, 'pim', right), null, 'only players in the quiz');
  assert.equal(allAnswered(quiz, ['dani', 'sander']), false);
  ({ quiz, secret } = answer(quiz, secret, 'sander', (right + 1) % quiz.answers.length) ?? assert.fail());
  assert.equal(allAnswered(quiz, ['dani', 'sander']), true);
  quiz = reveal(quiz, secret);
  assert.deepEqual(quiz.scores, { dani: 1, sander: 0 });
  for (let round = 1; round < 3; round += 1) {
    ({ quiz, secret } = advance(quiz, secret, 2000));
    assert.equal(quiz.phase, 'question');
    ({ quiz, secret } = answer(quiz, secret, 'dani', secret.questions[quiz.index].correct) ?? assert.fail());
    quiz = reveal(quiz, secret);
  }
  assert.equal(advance(quiz, secret, 3000).quiz.phase, 'done');
  assert.deepEqual(perfect(quiz), ['dani']);
});
