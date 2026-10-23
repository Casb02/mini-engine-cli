export default {
  name: 'buzzer',
  dir: new URL('./', import.meta.url),
  title: { nl: 'Buzzer', en: 'Buzzer' },
  summary: {
    nl: 'Wie drukt het snelst na het signaal? Realtime knoppen; de host beslist eerlijk op de klok van de server.',
    en: 'Who presses first after the signal? Realtime buttons; the host decides fairly on the server’s clock.',
  },
  players: [2, 12],
  theme: 'nacht',
  display: false,
  lateJoin: false,
  texts: {
    nl: {
      headline: 'Wie drukt het snelst?',
      rules: '{rounds} rondes. Druk zodra de knop groen wordt; te vroeg telt niet.',
      progress: 'Ronde {n} van {total}',
      wait: 'Wacht',
      press: 'Druk',
      pressed: 'Gedrukt',
      tooEarly: 'Te vroeg',
      waitTitle: 'Wacht op groen',
      goTitle: 'Nu',
      waitSeat: 'Druk zodra de knop groen wordt.',
      waitScreen: 'Zo meteen wordt de knop groen.',
      goNote: 'Druk zo snel als je kunt.',
      pressedNote: 'Gedrukt. Even wachten op de rest.',
      earlyNote: 'Te vroeg gedrukt. Deze ronde telt niet voor jou.',
      fastest: '{name} was het snelst',
      nobody: 'Niemand drukte',
      youWon: 'Jij was het snelst.',
      earlyList: 'Te vroeg: {names}',
      final: 'Eindstand',
      best: 'Meeste punten: {names}',
      orderLabel: 'Volgorde',
      standings: 'Stand',
    },
    en: {
      headline: 'Who presses first?',
      rules: '{rounds} rounds. Press as soon as the button turns green; too early does not count.',
      progress: 'Round {n} of {total}',
      wait: 'Wait',
      press: 'Press',
      pressed: 'Pressed',
      tooEarly: 'Too early',
      waitTitle: 'Wait for green',
      goTitle: 'Now',
      waitSeat: 'Press as soon as the button turns green.',
      waitScreen: 'The button turns green in a moment.',
      goNote: 'Press as fast as you can.',
      pressedNote: 'Pressed. Waiting for the others.',
      earlyNote: 'You pressed too early. This round does not count for you.',
      fastest: '{name} was fastest',
      nobody: 'Nobody pressed',
      youWon: 'You were fastest.',
      earlyList: 'Too early: {names}',
      final: 'Final board',
      best: 'Most points: {names}',
      orderLabel: 'Order',
      standings: 'Standings',
    },
  },
  manifest(o) {
    const nl = o.language === 'nl';
    return {
      description: nl
        ? 'Iedereen houdt de vinger klaar. Wie na het signaal als eerste drukt, krijgt een punt.'
        : 'Everyone keeps a finger ready. Whoever presses first after the signal gets a point.',
      default_settings: { rounds: 5 },
      settings_schema: {
        type: 'object',
        properties: { rounds: { type: 'integer', minimum: 1, maximum: 20, title: nl ? 'Rondes' : 'Rounds' } },
        required: ['rounds'],
        additionalProperties: false,
      },
    };
  },
  stage: (o, x) => `
<p id="progress" class="me-label"></p>
<h1 id="headline" class="me-title">${x.headline}</h1>
<p id="status" class="me-status" role="status">${x.connecting}</p>
<div data-for="seat" hidden><button type="button" id="buzz" class="buzz" hidden>${x.wait}</button></div>
<ol id="order" class="me-scores" aria-label="${x.orderLabel}" hidden></ol>
<p id="rules" class="me-muted"></p>
<ol id="scores" class="me-scores" aria-label="${x.standings}" hidden></ol>
`,
  css: `.buzz { display: block; width: min(100%, 20rem); aspect-ratio: 1; margin: 0 auto; border: 0; border-radius: 50%; background: var(--me-bad); color: #fff; font: inherit; font-size: 1.8rem; font-weight: 700; cursor: pointer; box-shadow: inset 0 -10px 0 rgba(0, 0, 0, .2); touch-action: manipulation; }
.buzz.is-go { background: var(--me-good); }
.buzz:disabled { opacity: .45; cursor: default; }
.buzz:not(:disabled):active { transform: scale(.97); }
body[data-view="screen"] #headline { font-size: clamp(3rem, 12vw, 9rem); }
`,
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#141b17"/><circle cx="24" cy="25" r="13" fill="#6fcf8f"/><circle cx="24" cy="22" r="10" fill="#9fe0b5"/></svg>\n',
  readme: {
    nl: () => ({
      about: 'Iedereen houdt de vinger klaar. Na een paar seconden wordt de knop groen; wie dan als eerste drukt, krijgt een punt. Wie te vroeg drukt, telt die ronde niet mee.',
      customize: [
        '- Een druk is een realtime bericht (`client.realtime.emit`). De server zet er de afzender (`from`) en het tijdstip (`ts`) bij, zodat alle telefoons op één klok worden vergeleken. Netwerkvertraging telt mee: goed genoeg voor een feestje.',
        '- De host wacht na de eerste druk nog 150 ms op de rest, sorteert op `ts` en publiceert de uitslag met `setState`. Een verloren bericht telt als niet gedrukt.',
        '- Wil je een quizbuzzer? Laat de host de knoppen openen als een vraag is voorgelezen, en geef de snelste het woord.',
        '- De regels staan in `assets/logic.js`, de scheidsrechter met de klok in `assets/app.js`.',
      ].join('\n'),
    }),
    en: () => ({
      about: 'Everyone keeps a finger ready. After a few seconds the button turns green; whoever presses first gets a point. Pressing too early sits out that round.',
      customize: [
        '- A press is a realtime message (`client.realtime.emit`). The server adds the sender (`from`) and the time (`ts`), so all phones are compared on one clock. Network delay counts: good enough for a party.',
        '- After the first press the host waits 150 ms for the others, sorts by `ts` and publishes the result with `setState`. A lost message counts as no press.',
        '- Want a quiz buzzer? Let the host open the buttons once a question has been read out, and give the fastest the floor.',
        '- The rules are in `assets/logic.js`, the referee with the clock in `assets/app.js`.',
      ].join('\n'),
    }),
  },
};
