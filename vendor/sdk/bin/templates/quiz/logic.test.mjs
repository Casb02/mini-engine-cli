import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, allAnswered, answer, imageOf, newQuiz, parseQuestion, perfect, pickQuestions, reveal } from '../assets/logic.js';

const lines = [
  { question: 'Hoeveel poten heeft een spin? | Acht | Zes | Tien', image: '/media/0123456789abcdef0123456789abcdef' },
  { question: 'Welke kleur krijg je met blauw en geel? | Groen | Paars' },
  { question: 'Hoeveel zijden heeft een zeshoek? | Zes | Vijf | Acht | Zeven', image: 'assets/vragen/zeshoek.png' },
];
const first = () => 0;
/** The picture of the line a question came from, or null. @param {string} text */
const imageFor = text => lines.find(line => line.question.startsWith(`${text} |`))?.image ?? null;

test('a question needs two to six answers and may have a picture', () => {
  assert.deepEqual(parseQuestion({ question: ' Waar? | Hier | Daar ' }), { text: 'Waar?', answers: ['Hier', 'Daar'], image: null });
  assert.equal(parseQuestion({ question: 'Alleen een vraag | Ja' }), null);
  assert.equal(parseQuestion('Waar? | Hier | Daar'), null);
  assert.equal(parseQuestion(42), null);
  assert.equal(parseQuestion({ question: 'Wie? | Ik | Jij', image: '/media/kat.jpg' })?.image, '/media/kat.jpg');
});

test('only images from a set or the package are shown', () => {
  for (const image of ['/media/0123456789abcdef0123456789abcdef', '/media/kat.jpg', 'assets/vragen/1.png']) assert.equal(imageOf(image), image);
  for (const image of ['', 'assets/../manifest.json', '/media/..', 'https://example.com/kat.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 42]) assert.equal(imageOf(image), null);
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
  const shownImages = [quiz.image];
  assert.equal(quiz.image, imageFor(quiz.question), 'a question shows its own picture or none');
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
    assert.equal(quiz.image, imageFor(quiz.question), 'a question shows its own picture or none');
    shownImages.push(quiz.image);
    ({ quiz, secret } = answer(quiz, secret, 'dani', secret.questions[quiz.index].correct) ?? assert.fail());
    quiz = reveal(quiz, secret);
  }
  assert.deepEqual(shownImages.sort(), ['/media/0123456789abcdef0123456789abcdef', 'assets/vragen/zeshoek.png', null].sort());
  assert.equal(advance(quiz, secret, 3000).quiz.phase, 'done');
  assert.deepEqual(perfect(quiz), ['dani']);
});
