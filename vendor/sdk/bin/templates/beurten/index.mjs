export default {
  name: 'beurten',
  dir: new URL('./', import.meta.url),
  title: { nl: 'Beurten', en: 'Turns' },
  summary: {
    nl: 'Om de beurt dobbelen; de host gooit, houdt de beurten bij en slaat wie te lang weg is over.',
    en: 'Take turns rolling a die; the host rolls, keeps the turns and skips whoever is away too long.',
  },
  players: [2, 8],
  theme: 'vilt',
  display: false,
  lateJoin: false,
  texts: {
    nl: {
      headline: 'Gooi of stop',
      rules: 'Gooi zo vaak je wilt en tel de ogen op. Gooi je een 1, dan ben je de punten van die beurt kwijt. Wie het eerst {target} punten heeft, wint.',
      yourTurn: 'Jouw beurt',
      theirTurn: '{name} is aan de beurt',
      winner: '{name} wint',
      pot: 'Deze beurt: {n} punten',
      roll: 'Gooi',
      hold: 'Stop en tel',
      rolled: '{name} gooide {value}.',
      bust: '{name} gooide een 1 en is {value} punten kwijt.',
      held: '{name} stopte en zette {value} punten vast.',
      skipped: '{name} was te lang weg en is overgeslagen.',
      won: '{name} heeft {value} punten.',
      dieLabel: 'Dobbelsteen',
      standings: 'Stand',
    },
    en: {
      headline: 'Roll or stop',
      rules: 'Roll as often as you like and add up the pips. Roll a 1 and you lose that turn’s points. First to {target} points wins.',
      yourTurn: 'Your turn',
      theirTurn: '{name}’s turn',
      winner: '{name} wins',
      pot: 'This turn: {n} points',
      roll: 'Roll',
      hold: 'Stop and bank',
      rolled: '{name} rolled {value}.',
      bust: '{name} rolled a 1 and lost {value} points.',
      held: '{name} stopped and banked {value} points.',
      skipped: '{name} was away too long and was skipped.',
      won: '{name} reached {value} points.',
      dieLabel: 'Die',
      standings: 'Standings',
    },
  },
  manifest(o) {
    const nl = o.language === 'nl';
    return {
      description: nl
        ? 'Om de beurt gooien: zo vaak je durft, maar een 1 kost je de punten van die beurt. Wie het eerst het doel haalt, wint.'
        : 'Take turns rolling: as often as you dare, but a 1 costs you that turn’s points. First to reach the target wins.',
      default_settings: { target: 30 },
      settings_schema: {
        type: 'object',
        properties: { target: { type: 'integer', minimum: 10, maximum: 100, title: nl ? 'Punten om te winnen' : 'Points to win' } },
        required: ['target'],
        additionalProperties: false,
      },
    };
  },
  stage: (o, x) => `
<h1 id="headline" class="me-title">${x.headline}</h1>
<p id="status" class="me-status" role="status">${x.connecting}</p>
<section id="table" class="me-surface table" hidden>
  <span id="die" class="die" role="img" aria-label="${x.dieLabel}">–</span>
  <span id="pot" class="me-label"></span>
</section>
<div class="me-actions" data-for="seat" hidden><button type="button" id="roll" class="me-button is-primary" hidden>${x.roll}</button><button type="button" id="hold" class="me-button" hidden>${x.hold}</button></div>
<p id="rules" class="me-muted"></p>
<ol id="scores" class="me-scores" aria-label="${x.standings}" hidden></ol>
`,
  css: `.table { display: grid; justify-items: center; gap: .75rem; }
.die { display: grid; place-items: center; width: 6rem; aspect-ratio: 1; border-radius: 1.2rem; background: #f1ead9; color: #13231c; font-size: 3.2rem; font-weight: 700; box-shadow: 0 10px 24px -12px rgba(0, 0, 0, .6); }
body[data-view="screen"] .die { width: 10rem; font-size: 5.5rem; }
`,
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#1f4a3a"/><rect x="12" y="12" width="24" height="24" rx="6" fill="#f1ead9"/><circle cx="19" cy="19" r="2.6" fill="#13231c"/><circle cx="24" cy="24" r="2.6" fill="#13231c"/><circle cx="29" cy="29" r="2.6" fill="#13231c"/></svg>\n',
  readme: {
    nl: () => ({
      about: 'Om de beurt dobbelen. Gooi zo vaak je durft en tel de ogen op; stop op tijd om ze vast te zetten, want een 1 kost je de punten van die beurt. Wie het eerst het doel haalt, wint.',
      customize: [
        '- De beurten en scores staan in `assets/logic.js`: `roll`, `hold`, `skip` en `sync` (voor spelers die weggaan).',
        '- De host gooit de dobbelsteen, zodat niemand kan valsspelen, en past elke zet toe in één wachtrij (`enqueue` in `assets/room.js`).',
        '- Is een speler tijdens de eigen beurt 30 seconden offline, bijvoorbeeld omdat de telefoon op slot ging, dan slaat de host die beurt over (`offlineClock` en `OFFLINE_SKIP_MS`). De eigen plek van de host telt nooit mee.',
        '- Het doel kies je bij het maken van de kamer (`settings_schema` in `manifest.json`).',
      ].join('\n'),
    }),
    en: () => ({
      about: 'Take turns rolling a die. Roll as often as you dare and add up the pips; stop in time to bank them, because a 1 costs you that turn’s points. First to reach the target wins.',
      customize: [
        '- Turns and scores are in `assets/logic.js`: `roll`, `hold`, `skip` and `sync` (for players who leave).',
        '- The host rolls the die, so nobody can cheat, and applies every move in one queue (`enqueue` in `assets/room.js`).',
        '- When a player is offline for 30 seconds during their own turn, for instance because the phone locked, the host skips that turn (`offlineClock` and `OFFLINE_SKIP_MS`). The host’s own seat never counts.',
        '- The target is picked when the room is created (`settings_schema` in `manifest.json`).',
      ].join('\n'),
    }),
  },
};
