export default {
  name: 'stemmen',
  dir: new URL('./', import.meta.url),
  title: { nl: 'Stemmen', en: 'Vote' },
  summary: {
    nl: 'Iedereen stemt ja of nee op één vraag; elk scherm toont de stand.',
    en: 'Everyone votes yes or no on one question; every screen shows the count.',
  },
  players: [1, 24],
  theme: 'kalk',
  display: true,
  lateJoin: true,
  texts: {
    nl: {
      yes: 'Ja',
      no: 'Nee',
      votes: 'Stemmen',
      finish: 'Sluit de stemming',
      changeAllowed: 'Je mag je stem wijzigen zolang de stemming open is.',
      changeLocked: 'Je stem staat vast zodra je stemt.',
      voted: '{n} van de {total} hebben gestemd.',
      voteClosed: 'De stemming is gesloten.',
    },
    en: {
      yes: 'Yes',
      no: 'No',
      votes: 'Votes',
      finish: 'Close the vote',
      changeAllowed: 'You can change your vote while the vote is open.',
      changeLocked: 'Your vote is final once you vote.',
      voted: '{n} of {total} have voted.',
      voteClosed: 'The vote is closed.',
    },
  },
  manifest(o) {
    const nl = o.language === 'nl';
    return {
      description: nl ? 'Iedereen stemt ja of nee op één vraag. Kies de vraag bij het maken van de kamer.' : 'Everyone votes yes or no on one question. Pick the question when you create the room.',
      default_settings: { prompt: nl ? 'Spelen we nog een ronde?' : 'Shall we play another round?', allow_change: true },
      settings_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 120, title: nl ? 'Vraag' : 'Question' },
          allow_change: { type: 'boolean', title: nl ? 'Stem wijzigen mag' : 'Votes can change' },
        },
        required: ['prompt', 'allow_change'],
        additionalProperties: false,
      },
    };
  },
  stage: (o, x) => `
<h1 id="prompt" class="me-title"></h1>
<p id="status" class="me-status" role="status">${x.connecting}</p>
<section id="tally" class="me-tally" aria-label="${x.votes}" hidden>
  <div class="me-card"><strong id="yes" class="me-big">0</strong><span class="me-label">${x.yes}</span></div>
  <div class="me-card"><strong id="no" class="me-big">0</strong><span class="me-label">${x.no}</span></div>
</section>
<div id="choices" class="me-choices" data-for="seat" hidden><button type="button" id="vote-yes" class="me-choice" aria-pressed="false">${x.yes}</button><button type="button" id="vote-no" class="me-choice" aria-pressed="false">${x.no}</button></div>
<p id="rules" class="me-muted"></p>
<div class="me-actions" data-for="host" hidden><button type="button" id="finish" class="me-button is-primary" hidden>${x.finish}</button></div>
`,
  css: `body[data-view="screen"] .me-tally .me-big { font-size: clamp(6rem, 18vw, 14rem); }
`,
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#1e2823"/><path d="M14 25l7 7 13-15" fill="none" stroke="#f2c230" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>\n',
  readme: {
    nl: () => ({
      about: 'Iedereen stemt ja of nee op de vraag van de kamer. Elk scherm toont hoeveel ja en nee er zijn; het gedeelde scherm toont ze groot.',
      customize: [
        '- De vraag en of stemmen wijzigen mag, kies je bij het maken van de kamer. De standaard staat in `default_settings` in `manifest.json`.',
        '- De regels (`castVote` en `tally`) staan in `assets/logic.js`; de scheidsrechter (`applyVote`) in `assets/app.js`.',
        '- Ander uiterlijk: `host.html`, `player.html`, `display.html` en `assets/style.css`.',
      ].join('\n'),
    }),
    en: () => ({
      about: 'Everyone votes yes or no on the room’s question. Every screen shows how many said yes and no; the shared screen shows them large.',
      customize: [
        '- The question and whether votes can change are picked when the room is created. The defaults are `default_settings` in `manifest.json`.',
        '- The rules (`castVote` and `tally`) are in `assets/logic.js`; the referee (`applyVote`) is in `assets/app.js`.',
        '- Another look: `host.html`, `player.html`, `display.html` and `assets/style.css`.',
      ].join('\n'),
    }),
  },
};
