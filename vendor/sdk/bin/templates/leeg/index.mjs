export default {
  name: 'leeg',
  dir: new URL('./', import.meta.url),
  title: { nl: 'Leeg', en: 'Empty' },
  summary: {
    nl: 'Een kaal begin: lobby, start, één voorbeeldzet en een einde.',
    en: 'A bare start: lobby, start, one example move and an end.',
  },
  players: [1, 8],
  theme: 'kalk',
  display: false,
  lateJoin: false,
  texts: {
    nl: {
      headline: 'Hier komt je spel',
      over: 'Afgelopen',
      running: 'Tik op de knop. Dit is een voorbeeld; vervang het door je eigen spel.',
      tapped: 'Je tikte {n} keer.',
      tap: 'Tik',
      finish: 'Stop het spel',
    },
    en: {
      headline: 'Your game goes here',
      over: 'Game over',
      running: 'Tap the button. This is an example; replace it with your own game.',
      tapped: 'You tapped {n} times.',
      tap: 'Tap',
      finish: 'End the game',
    },
  },
  manifest(o) {
    return {
      description: o.language === 'nl' ? 'Een nieuw spel voor Mini Engine.' : 'A new game for Mini Engine.',
      default_settings: {},
      settings_schema: { type: 'object', properties: {}, additionalProperties: false },
    };
  },
  stage: (o, x) => `
<h1 id="headline" class="me-title">${x.headline}</h1>
<p id="status" class="me-status" role="status">${x.connecting}</p>
<div data-for="seat" hidden><button type="button" id="tap" class="me-button is-primary is-wide" hidden>${x.tap}</button></div>
<ol id="scores" class="me-scores" hidden></ol>
<div class="me-actions" data-for="host" hidden><button type="button" id="finish" class="me-button" hidden>${x.finish}</button></div>
`,
  css: '',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#eef0ec"/><circle cx="24" cy="24" r="10" fill="none" stroke="#6f7a72" stroke-width="4"/></svg>\n',
  readme: {
    nl: () => ({
      about: 'Een kaal begin voor je eigen spel: een lobby, een start, één voorbeeldzet (tikken) en een einde. Elke speler tikt op een knop en de host telt mee.',
      customize: [
        '- Bedenk eerst de state: wat ziet iedereen (`public_state`), wat alleen de host (`host_state`) en wat elke speler apart (`player_states`).',
        '- Vervang `newGame` en `tap` in `assets/logic.js` door je eigen regels, met tests in `tests/logic.test.mjs`.',
        '- In `assets/app.js` publiceert de host de eerste state als het spel start, en past hij elke zet toe met `setState`.',
        '- Instellingen voor het formulier zet je in `settings_schema` in `manifest.json`.',
      ].join('\n'),
    }),
    en: () => ({
      about: 'A bare start for your own game: a lobby, a start, one example move (tapping) and an end. Every player taps a button and the host keeps count.',
      customize: [
        '- Design the state first: what everyone sees (`public_state`), what only the host sees (`host_state`) and what each player sees alone (`player_states`).',
        '- Replace `newGame` and `tap` in `assets/logic.js` with your own rules, with tests in `tests/logic.test.mjs`.',
        '- In `assets/app.js` the host publishes the first state when the game starts, and applies every move with `setState`.',
        '- Settings for the create form go in `settings_schema` in `manifest.json`.',
      ].join('\n'),
    }),
  },
};
