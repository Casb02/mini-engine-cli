<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-donker.png">
  <img alt="Miniengine✱ CLI" src=".github/assets/banner-licht.png" width="100%">
</picture>

# Mini Engine CLI

Met de Mini Engine CLI upload en beheer je je eigen partygames op een Mini Engine-server: een game maken vanuit het SDK-sjabloon, nieuwe versies uploaden, wisselen tussen versies en de game aan- of uitzetten. De eigenaar van de server beheert er ook de dev keys mee.

De commando's heten `me` en `miniengine` (hetzelfde programma). Werkt met Mini Engine 0.3 of nieuwer.

## Installeren

Je hebt Node.js 22 of nieuwer nodig. De CLI heeft geen andere afhankelijkheden.

```sh
npm install -g github:Casb02/mini-engine-cli
```

Of vanuit een checkout van deze repository:

```sh
npm install -g .
```

Controleer met `me --version`.

## Snel aan de slag

Je hebt een dev key nodig. Die krijg je van de eigenaar van de server (zie [Beheer](#beheer)). Daarna:

```sh
me setup
```

`me setup` vraagt de server-URL, je dev key, of de AI-skills voor Claude Code geïnstalleerd moeten worden en of je meteen een eerste game wilt maken. Elke stap kun je overslaan. Liever stap voor stap:

```sh
me auth --server https://games.example.nl   # dev key plakken
me game new ja-of-nee                         # maakt ./ja-of-nee
cd ja-of-nee
me game upload                                # eerste versie, meteen actief
```

Pas daarna de game aan, verhoog `version` in `manifest.json` en upload opnieuw:

```sh
me game upload --activate
```

## Commando's

Elk commando heeft `--help`, bijvoorbeeld `me game upload --help`.

### Inloggen

| Commando | Doet |
| --- | --- |
| `me auth [--server URL] [--token KEY]` | Vraagt je dev key (onzichtbare invoer), controleert hem bij de server en slaat hem op. Zonder terminal leest hij één regel van stdin. |
| `me auth status` | Laat zien met welke account, server en sleutel je werkt. |
| `me auth logout` | Haalt de dev key uit je configuratie. De sleutel zelf blijft geldig tot de beheerder hem intrekt. |

### Games

| Commando | Doet |
| --- | --- |
| `me game list` | Je games met actieve versie, status (aan, uit of geblokkeerd) en aantal versies. |
| `me game new <slug> [--dir MAP]` | Maakt een werkende stemgame vanuit het SDK-sjabloon in `./<slug>`. |
| `me game upload [map] [--activate] [--dry-run]` | Pakt de map in en uploadt hem als nieuwe versie. |
| `me game versions <id>` | Alle versies met grootte, hash en of een lopende room ze gebruikt. |
| `me game activate <id> <versie>` | Maakt een versie actief. Zo zet je ook een oudere versie terug. |
| `me game enable <id>` / `me game disable <id>` | Toont of verbergt de game. Lopende rooms spelen door. |
| `me game delete-version <id> <versie>` | Verwijdert één oude versie. |
| `me game prune <id> [--keep N] [--yes] [--dry-run]` | Verwijdert alle versies behalve de actieve en de nieuwste N (standaard 3). Versies die een lopende room gebruikt, blijven staan. |
| `me game delete <id> [--yes]` | Verwijdert de hele game met alle versies. |

`me game prune` en `me game delete` vragen om bevestiging. Zonder terminal (in een script) is `--yes` verplicht.

### Lokaal testen

| Commando | Wat |
| --- | --- |
| `me dev [map]` | Start een lokale, nagebootste engine voor je game en opent een overzicht met de spelleider, het scherm en de spelers naast elkaar. |
| `me dev --players 4 --set bord.json` | Met vier spelers, en met `bord.json` als eigen set in plaats van `data.json`. |

### AI-skills

De CLI bevat de skills uit de Mini Engine SDK voor Claude Code: `build-mini-engine-game`, `design-mini-engine-game-ui` en `mini-engine-ui` (MiniEngineUI, de rustige stijl van de demospellen als kant-en-klare kit).

| Commando | Doet |
| --- | --- |
| `me skill list` | Toont de meegeleverde skills. |
| `me skill install [naam…] [--project \| --path MAP] [--force]` | Installeert in `~/.claude/skills`, met `--project` in `./.claude/skills`, of in een eigen map. Een bestaande skill met andere inhoud wordt alleen met `--force` overschreven. |

### Eerste keer

| Commando | Doet |
| --- | --- |
| `me setup` | Server, dev key, skills en een eerste game, met vragen. |
| `me setup --server URL --token KEY --no-skills --game SLUG` | Hetzelfde zonder vragen. `--yes` kiest overal de standaard. |

### Beheer

Voor de eigenaar van de server. Hiervoor heb je het admintoken nodig: de waarde van `MINI_ENGINE_ADMIN_TOKEN` waarmee de engine draait.

| Commando | Doet |
| --- | --- |
| `me admin login [--token TOKEN]` / `me admin logout` | Admintoken controleren en opslaan, of vergeten. |
| `me admin token create <gebruikersnaam> [--label TEKST] [--expires DAGEN]` | Maakt een dev key voor een bestaand account. De sleutel wordt één keer getoond. |
| `me admin token list` | Alle dev keys met laatste gebruik en status. |
| `me admin token revoke <id>` | Trekt een dev key in. Hij werkt direct niet meer. |
| `me admin account verify <gebruikersnaam>` | Bevestigt het e-mailadres van een account handmatig. Een dev key kan alleen voor een account met een bevestigd adres. |
| `me admin games` | Alle geüploade games met eigenaar. |
| `me admin game block <id>` / `unblock <id>` | Noodstop: de engine serveert niets meer van de game, ook niet aan lopende rooms, en de eigenaar kan hem niet zelf weer aanzetten. `unblock` heft dat op. |

Een ontwikkelaar aan de slag helpen:

```sh
me admin login
me admin token create sander --label laptop --expires 90
# geef de sleutel via een veilig kanaal door; sander draait daarna: me auth
```

## Lokaal testen met me dev

Je hebt geen engine nodig om je game te testen:

```sh
cd mijn-spel
me dev
```

`me dev` controleert eerst `manifest.json` zoals `me game upload` dat doet en start dan een kleine server die de engine nabootst voor games met `runtime: "host"`: kamers, spelers en klaar zijn, state met versies, acties naar de spelleider, realtime, achievements en game-data (of een eigen set met `--set`). In de browser zie je de spelleider, het tv-scherm en de spelers naast elkaar. Elke stoel draait op een eigen poort, dus elke speler heeft een eigen sessie, net als op een eigen telefoon. Met **Speler toevoegen** schuift er iemand aan, met **Nieuwe kamer** begin je opnieuw.

Pas je iets aan in de map, dan laden de stoelen opnieuw en blijft de kamer bestaan. Een fout in het manifest zie je in het overzicht en in de terminal. Gekregen achievements verschijnen in de terminal. Alles staat alleen in het geheugen; stoppen doe je met Ctrl+C.

`me dev` is een nabootsing. Hij volgt het protocol van de engine en de tests van de CLI draaien hem met dezelfde stappen als de echte engine, maar test je game voor een avond met vrienden ook een keer op een echte server, bijvoorbeeld met `me game upload` en een testversie.

## Uploaden

`me game upload` leest `id` en `version` uit `manifest.json`. Elke upload is een nieuwe versie, dus verhoog `version` (letters, cijfers en `. + _ -`, maximaal 64 tekens).

Niet meegestuurd worden:

- bestanden en mappen die met een punt beginnen (`.git`, `.env`, `.DS_Store`)
- `node_modules`, op elke diepte
- de map `tests/` in de hoofdmap van de game
- patronen uit `.meignore`

`.meignore` heeft één patroon per regel. `*` past binnen één map, `**` over mappen heen, een `/` aan het eind betekent alleen mappen, en een patroon met een `/` erin geldt vanaf de hoofdmap. Regels die met `#` beginnen zijn commentaar. `me game new` zet `jsconfig.json` en `types/` er alvast in, omdat die alleen voor je editor zijn.

```
*.psd
ontwerp/
assets/**/*.wav
```

Symlinks worden geweigerd. Voordat er iets verstuurd wordt, controleert de CLI de limieten van de server: maximaal 4096 bestanden, 2 MiB per bestand, 10 MiB in totaal, paden tot 255 bytes en 32 niveaus diep. Ook controleert hij dat de game `runtime: "host"` met `host_modes: ["moderator"]` gebruikt en dat `host.html` en `player.html` (en `display.html` als `has_display` aan staat) bestaan. Met `--dry-run` zie je wat er mee zou gaan.

De eerste versie van een nieuwe game wordt meteen actief. Latere versies worden alleen actief met `--activate` of `me game activate`. Een room houdt de versie waarmee hij begon, ook als je intussen een andere versie activeert; zo'n versie staat in `me game versions` als in gebruik en kan pas weg als de room klaar is. Per account kun je 10 games hebben en per game 10 versies bewaren; ruim oude versies op met `me game prune`.

## Configuratie

De CLI bewaart zijn instellingen in `~/.config/miniengine/config.json` (of `$XDG_CONFIG_HOME/miniengine/config.json`):

```json
{ "server": "https://games.example.nl", "token": "med_…", "admin_token": "…" }
```

Het bestand krijgt rechten `0600` en de map `0700`. Omgevingsvariabelen gaan voor het bestand:

| Variabele | Waarvoor |
| --- | --- |
| `MINIENGINE_SERVER` | Server-URL (standaard `https://miniengine.nl`; lokaal `http://localhost:3000`) |
| `MINIENGINE_TOKEN` | Dev key |
| `MINIENGINE_ADMIN_TOKEN` | Admintoken |

`--server URL` gaat weer voor de omgeving en geldt voor één commando. Bij `me auth`, `me admin login` en `me setup` wordt de server ook opgeslagen.

## Scripts

Elk commando kent `--json`. De uitvoer is dan één JSON-object op stdout, ook bij fouten:

```json
{ "error": { "code": "version_exists", "message": "Deze versie bestaat al.", "status": 409 } }
```

Exitcodes: `0` gelukt, `1` fout van de server of de CLI, `2` verkeerd gebruik (onbekend commando, ontbrekend argument, bevestiging nodig), `130` afgebroken.

```sh
export MINIENGINE_SERVER=https://games.example.nl
printf %s "$MINIENGINE_DEV_KEY" | me auth
me game upload ./ja-of-nee --activate --json
```

## Beveiliging

- Een dev key (`med_` gevolgd door 64 tekens) is een geheim: wie hem heeft, kan namens jou games uploaden, wijzigen en verwijderen. Zet hem niet in een repository en deel hem niet in een chat. `--token` komt in je shellgeschiedenis; plakken via `me auth` of stdin voorkomt dat.
- De CLI toont sleutels nooit volledig, alleen als `med_…abcd`. De enige uitzondering is `me admin token create`, dat de nieuwe sleutel één keer toont.
- Geüploade games draaien op hetzelfde domein als de engine, met hetzelfde vertrouwen als de ingebouwde games. Geef dev keys daarom alleen aan ontwikkelaars die je zelf uitnodigt en vertrouwt. Een game afschermen van onbekende makers (eigen domein per game) staat nog op de planning.
- Lekt een sleutel, trek hem dan in met `me admin token revoke <id>`. `me auth logout` haalt hem alleen van je eigen computer.
- Het admintoken geeft volledige controle over alle dev keys en games. Gebruik `me admin login` alleen op je eigen machine.

## Ontwikkeling

```sh
npm test                 # controleert vendor/ en draait de tests (node --test)
npm run sync-vendor      # haalt sjablonen en skills opnieuw uit ../mini-engine-sdk
```

`vendor/` bevat een kopie van het gamesjabloon (`bin/templates.mjs` en `types/mini-engine.d.ts`) en de skills uit de Mini Engine SDK. Pas die bestanden niet met de hand aan: `scripts/sync-vendor.mjs` kopieert ze uit een SDK-checkout (`--sdk PAD` of `MINI_ENGINE_SDK`) en legt hashes en SDK-versie vast in `vendor/VENDOR.json`. `npm test` faalt als `vendor/` daarvan afwijkt.

De tests draaien tegen een nagebouwde server. Tegen een echte engine:

```sh
MINIENGINE_E2E_SERVER=http://127.0.0.1:3200 \
MINIENGINE_E2E_ADMIN_TOKEN=… \
npm run e2e
```

Dat script registreert een testaccount, maakt een dev key, logt in, maakt en uploadt een game, speelt de versies, rooms, aan/uit, blokkeren, opruimen en verwijderen door en trekt de sleutel weer in. Gebruik het alleen tegen een testserver.
