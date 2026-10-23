const questions = {
  nl: [
    'Wat is de hoofdstad van Australië? | Canberra | Sydney | Melbourne | Perth',
    'Hoeveel poten heeft een spin? | Acht | Zes | Tien | Twaalf',
    'Welke planeet staat het dichtst bij de zon? | Mercurius | Venus | Mars | Aarde',
    'Hoeveel minuten heeft een etmaal? | 1440 | 1240 | 1600 | 960',
    'Welk metaal is vloeibaar bij kamertemperatuur? | Kwik | Lood | Tin | Zink',
    'In welk land ligt de stad Porto? | Portugal | Spanje | Italië | Brazilië',
    'Wat is het grootste zoogdier? | Blauwe vinvis | Olifant | Giraf | Potvis',
    'Hoeveel spelers van één team staan er bij voetbal op het veld? | Elf | Tien | Negen | Twaalf',
    'Welke kleur krijg je als je blauw en geel mengt? | Groen | Paars | Oranje | Bruin',
    'Hoeveel zijden heeft een zeshoek? | Zes | Vijf | Acht | Zeven',
    'Welke rivier stroomt door Keulen? | Rijn | Maas | Donau | Elbe',
    'Hoeveel dagen heeft een schrikkeljaar? | 366 | 365 | 364 | 367',
  ],
  en: [
    'What is the capital of Australia? | Canberra | Sydney | Melbourne | Perth',
    'How many legs does a spider have? | Eight | Six | Ten | Twelve',
    'Which planet is closest to the sun? | Mercury | Venus | Mars | Earth',
    'How many minutes are there in a day? | 1440 | 1240 | 1600 | 960',
    'Which metal is liquid at room temperature? | Mercury | Lead | Tin | Zinc',
    'In which country is the city of Porto? | Portugal | Spain | Italy | Brazil',
    'What is the largest mammal? | Blue whale | Elephant | Giraffe | Sperm whale',
    'How many players of one team are on the pitch in football? | Eleven | Ten | Nine | Twelve',
    'Which colour do you get when you mix blue and yellow? | Green | Purple | Orange | Brown',
    'How many sides does a hexagon have? | Six | Five | Eight | Seven',
    'Which river flows through Cologne? | Rhine | Meuse | Danube | Elbe',
    'How many days does a leap year have? | 366 | 365 | 364 | 367',
  ],
};

export default {
  name: 'quiz',
  dir: new URL('./', import.meta.url),
  title: { nl: 'Quiz', en: 'Quiz' },
  summary: {
    nl: 'Meerkeuzevragen op tijd, punten en een eindstand; spelers maken eigen vragenlijsten.',
    en: 'Multiple-choice questions on a timer, points and a final board; players make their own question lists.',
  },
  players: [1, 16],
  theme: 'studio',
  display: false,
  lateJoin: false,
  texts: {
    nl: {
      headline: 'Quiz',
      rules: '{count} vragen, {seconds} seconden per vraag.',
      progress: 'Vraag {n} van {total}',
      secondsLeft: 'nog {s} s',
      pickAnswer: 'Kies een antwoord.',
      waitOthers: 'Antwoord verstuurd. Wacht op de anderen.',
      answeredCount: '{n} van de {total} hebben geantwoord.',
      right: 'Goed.',
      wrong: 'Fout. Het goede antwoord is {answer}.',
      noAnswer: 'Geen antwoord. Het goede antwoord is {answer}.',
      answerWas: 'Het goede antwoord is {answer}.',
      final: 'Eindstand',
      best: 'Meeste punten: {names}',
      yourScore: 'Je had {n} van de {total} goed.',
      noQuestions: 'Er staan geen bruikbare vragen in deze set.',
      standings: 'Stand',
    },
    en: {
      headline: 'Quiz',
      rules: '{count} questions, {seconds} seconds per question.',
      progress: 'Question {n} of {total}',
      secondsLeft: '{s} s left',
      pickAnswer: 'Pick an answer.',
      waitOthers: 'Answer sent. Waiting for the others.',
      answeredCount: '{n} of {total} have answered.',
      right: 'Right.',
      wrong: 'Wrong. The right answer is {answer}.',
      noAnswer: 'No answer. The right answer is {answer}.',
      answerWas: 'The right answer is {answer}.',
      final: 'Final board',
      best: 'Most points: {names}',
      yourScore: 'You got {n} of {total} right.',
      noQuestions: 'This set has no usable questions.',
      standings: 'Standings',
    },
  },
  manifest(o) {
    const nl = o.language === 'nl';
    return {
      description: nl
        ? 'Meerkeuzevragen op tijd. Wie de meeste goed heeft, wint. Speel met de vragen van het spel of met een eigen vragenlijst.'
        : 'Multiple-choice questions against the clock. Most right answers wins. Play with the game’s questions or your own list.',
      default_settings: { count: 8, seconds: 20 },
      settings_schema: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 3, maximum: 30, title: nl ? 'Aantal vragen' : 'Number of questions' },
          seconds: { type: 'integer', minimum: 5, maximum: 120, title: nl ? 'Seconden per vraag' : 'Seconds per question' },
        },
        required: ['count', 'seconds'],
        additionalProperties: false,
      },
      achievements: [
        nl
          ? { id: 'perfect', title: 'Alles goed', description: 'Beantwoord elke vraag van een quiz goed.' }
          : { id: 'perfect', title: 'Perfect score', description: 'Answer every question of a quiz right.' },
      ],
      set_kinds: [
        {
          id: 'questions',
          title: nl ? 'Eigen vragen' : 'Own questions',
          description: nl
            ? 'Eén vraag per regel: de vraag, het goede antwoord en daarna de foute, gescheiden door |.'
            : 'One question per line: the question, the right answer, then the wrong ones, separated by |.',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['questions'],
            properties: {
              questions: {
                type: 'array',
                title: nl ? 'Vragen' : 'Questions',
                description: nl ? 'Bijvoorbeeld: Hoeveel poten heeft een spin? | Acht | Zes | Tien' : 'For example: How many legs does a spider have? | Eight | Six | Ten',
                minItems: 3,
                maxItems: 100,
                items: { type: 'string', title: nl ? 'Vraag' : 'Question', minLength: 5, maxLength: 300 },
              },
            },
          },
        },
      ],
    };
  },
  data: o => ({ questions: questions[o.language] }),
  stage: (o, x) => `
<p id="progress" class="me-label"></p>
<h1 id="question" class="me-title">${x.headline}</h1>
<p id="status" class="me-status" role="status">${x.connecting}</p>
<div id="answers" class="me-choices" hidden></div>
<p id="rules" class="me-muted"></p>
<ol id="scores" class="me-scores" aria-label="${x.standings}" hidden></ol>
`,
  css: `.me-choice[aria-pressed="true"]:disabled, .me-choice.is-correct, .me-choice.is-wrong { opacity: 1; }
.me-choices .me-choice.is-correct { border: 3px solid var(--me-good); }
.me-choices .me-choice.is-wrong { border: 3px solid var(--me-bad); }
body[data-view="screen"] .me-choice:disabled { opacity: 1; }
body[data-view="screen"] .me-choice { font-size: 1.6em; }
`,
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#0c1230"/><path d="M17.5 18a6.5 6.5 0 1 1 9.5 5.8c-1.9 1-3 2.3-3 4.4" fill="none" stroke="#e8c35a" stroke-width="4.5" stroke-linecap="round"/><circle cx="24" cy="35" r="2.6" fill="#e8c35a"/></svg>\n',
  readme: {
    nl: () => ({
      about: 'Meerkeuzevragen op tijd. Wie het goede antwoord kiest, krijgt een punt; na de laatste vraag volgt de eindstand. Spelers kunnen op de server een eigen vragenlijst maken en die kiezen bij het maken van een kamer.',
      manifestExtra: ', de soort eigen set (`set_kinds`) en een achievement',
      files: [['`data.json`', 'De vragen van het spel; alleen de host leest ze']],
      customize: [
        '- Eigen vragen: één per regel in `data.json`, als `vraag | goed antwoord | fout | fout`. Twee tot zes antwoorden; de host schudt ze.',
        '- Spelers maken een eigen vragenlijst op `/home/sets` van de server, in hetzelfde formaat. Lokaal proberen: `me dev --set mijn-vragen.json`.',
        '- Aantal vragen en seconden per vraag kies je bij het maken van de kamer (`settings_schema` in `manifest.json`).',
        '- De regels staan in `assets/logic.js`, de scheidsrechter met de klok in `assets/app.js`.',
        '- Met *Iedereen doet mee* heeft het tabblad van de maker de antwoorden in het geheugen. Kies *TV* voor een eerlijke quiz.',
      ].join('\n'),
    }),
    en: () => ({
      about: 'Multiple-choice questions against the clock. A right answer earns a point; after the last question comes the final board. Players can make their own question list on the server and pick it when they create a room.',
      manifestExtra: ', the kind of own set (`set_kinds`) and an achievement',
      files: [['`data.json`', 'The game’s questions; only the host reads them']],
      customize: [
        '- Your own questions: one per line in `data.json`, as `question | right answer | wrong | wrong`. Two to six answers; the host shuffles them.',
        '- Players make their own question list at `/home/sets` on the server, in the same format. Try one locally: `me dev --set my-questions.json`.',
        '- The number of questions and seconds per question are picked when the room is created (`settings_schema` in `manifest.json`).',
        '- The rules are in `assets/logic.js`, the referee with the clock in `assets/app.js`.',
        '- With *Iedereen doet mee* the creator’s tab holds the answers in memory. Pick *TV* for a fair quiz.',
      ].join('\n'),
    }),
  },
};
