# Package layout, manifest and settings schema

Source of truth: the engine's `src/catalog.rs` (validation at startup), `src/set_schema.rs` (the set schema dialect) and `docs/GAME-DEVELOPMENT.md`.

## Package layout

```text
games/<id>/
  manifest.json        required; "id" must equal the directory name
  host.html            required
  player.html          required
  display.html         required when has_display is true
  assets/              the ONLY publicly served files: /games/<id>/assets/<path>
    app.js             role logic (scaffold) — import the SDK from /sdk/mini-engine.js
    logic.js           pure rules (recommended)
    style.css
  data.json            optional private JSON; only the host can read it (ApiClient.gameData)
  jsconfig.json        editor/tsc config from the scaffold — not served
  types/mini-engine.d.ts  SDK declarations from the scaffold — not served
  README.md, tests/    allowed; loaded but never served
```

Catalog limits: game id `^[a-z0-9-]{1,48}$` (the scaffolder additionally requires a leading letter and single hyphens); every file ≤ 2 MiB; package ≤ 10 MiB and ≤ 4096 files; nesting ≤ 32 levels; no symlinks; filenames without backslashes; HTML must be UTF-8; `data.json` must be valid JSON. Do **not** run `npm install` inside a game directory — `node_modules` counts against these limits.

Role pages are served from `/api/v1/games/<id>/<role>`, so reference assets with absolute paths: `<link rel="stylesheet" href="/games/<id>/assets/style.css">`, `<script type="module" src="/games/<id>/assets/app.js"></script>`.

## manifest.json

```json
{
  "id": "number-duel",
  "title": "Number Duel",
  "description": "Kies stiekem een getal; wie het dichtst bij 2/3 van het gemiddelde zit, wint.",
  "version": "0.1.0",
  "runtime": "host",
  "host_modes": ["moderator"],
  "default_host_mode": "moderator",
  "supports_late_join": false,
  "min_players": 2,
  "max_players": 24,
  "has_display": true,
  "default_settings": { "rounds": 5, "max_number": 100 },
  "settings_schema": {
    "type": "object",
    "properties": {
      "rounds": { "type": "integer", "minimum": 1, "maximum": 20, "title": "Rondes" },
      "max_number": { "type": "integer", "enum": [10, 100, 1000], "title": "Hoogste getal" }
    },
    "required": ["rounds", "max_number"],
    "additionalProperties": false
  }
}
```

| Field | Rule |
| --- | --- |
| `id` | Equals the directory name. |
| `title` | Non-empty, ≤ 200 chars. Shown in `/home`. |
| `description` | ≤ 4000 chars. |
| `version` | Non-empty, ≤ 100 chars (free text; use semver). |
| `min_players` / `max_players` | `1 ≤ min ≤ max ≤ 100`. A room's capacity is chosen at creation between them (default `min(max_players, 24)`). `min_players` is **not** enforced at start — check it in your host UI if it matters. |
| `has_display` | `true` requires `display.html`. `false` makes rooms with `display_enabled` invalid. |
| `runtime` | `"host"` (default). `"server"` is only for built-in Rust games. |
| `host_modes` / `default_host_mode` | Must be `["moderator"]` / `"moderator"` (the defaults) for `runtime: "host"`. |
| `supports_late_join` | Default `true`. Set `false` unless the host logic handles players appearing during `running`. The room still has to opt in with `allow_late_join`. |
| `default_settings` | Must validate against `settings_schema`. |
| `achievements` | Optional (0.5+), ≤ 50: `[{id, title, description}]`. `id` `^[a-z0-9][a-z0-9_-]{0,47}$`, unique; `title` 1–60 chars; `description` 1–160 chars; no control characters. Public through `GET /api/v1/games`. The host awards them (see `host-runtime-patterns.md`). |
| `set_kinds` | Optional (0.5+), ≤ 4: `[{id, title, description, schema}]`. `id`, `title` and `description` follow the achievement rules; `schema` uses the set schema dialect below. Players save sets of these kinds on their account and pick one for a room. |

The engine reads only the fields above. Anything else in `manifest.json` is ignored without a warning, so a misspelt field (`achievement`, `setKinds`) silently does nothing: check `GET /api/v1/games/<id>` after a restart. An engine older than 0.5 ignores `achievements` and `set_kinds` the same way; the game still loads there, without them.

## settings_schema (a strict JSON Schema subset)

- Top level: exactly `type: "object"`, `properties`, `additionalProperties: false`; optional `required` (unique names of declared properties), `title`, `description`, `default`.
- Property keys allowed: `type`, `enum`, `minimum`, `maximum`, `maxLength`, `title`, `description`, `default`. Anything else (`$ref`, `pattern`, `items`, `minLength`, nested objects, arrays) makes the engine refuse to start: `Unsupported settings schema feature: <key>`.
- `type` ∈ `integer`, `number`, `string`, `boolean`. `minimum`/`maximum` only on numeric types (and `min ≤ max`); `maxLength` only on strings; `enum` non-empty, no duplicates, every value valid for the type.
- `title`/`description` must be strings; `/home` uses them to label the settings form.
- Settings objects are ≤ 8 KiB. `setSettings` replaces the whole object and is validated against the schema; when creating a room, given settings are merged over `default_settings`.

## data.json (private game data)

For answers, word lists or question banks the players must not see. The host loads it once:

```js
import { ApiClient } from '/sdk/mini-engine.js';
const data = await new ApiClient().gameData(session.code, session.token); // host token only
```

Never put such data under `assets/` or in HTML — those are public URLs. Reveal items by copying them into `public_state` at the right moment.

When the room was created with a player's own set (`room.set` is `{id, kind, title}`), `gameData` returns that set's content instead of `data.json`. Give `data.json` the same shape as your set kind, so one code path reads both, and still check the shape once.

## set_kinds and the set schema dialect (0.5+)

A set kind describes content players may make for your game, such as their own question list:

```json
"set_kinds": [{
  "id": "questions",
  "title": "Vragenlijst",
  "description": "Tien tot dertig vragen met één goed antwoord.",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["questions"],
    "properties": {
      "questions": {
        "type": "array", "minItems": 10, "maxItems": 30,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["question", "answer"],
          "properties": {
            "question": { "type": "string", "minLength": 1, "maxLength": 200, "title": "Vraag" },
            "answer": { "type": "string", "minLength": 1, "maxLength": 80, "title": "Antwoord" },
            "level": { "type": "string", "enum": ["makkelijk", "moeilijk"] },
            "points": { "type": "integer", "minimum": 1, "maximum": 10 }
          }
        }
      }
    }
  }
}]
```

The dialect is a small, bounded part of JSON Schema, checked when the game loads (an invalid schema stops the engine or refuses the upload):

| `type` | Allowed keys besides `title` and `description` |
| --- | --- |
| `object` | `properties` (required), `required` (unique names of its own properties), `additionalProperties: false` (required on every object) |
| `array` | `items` (required, one schema), `minItems`, `maxItems` |
| `string` | `minLength`, `maxLength` (characters), `enum` (1–256 unique strings, each within the length bounds) |
| `integer`, `number` | `minimum`, `maximum` |
| `boolean` | none |

- `title` and `description` are strings on any node. Nothing else is allowed: no `$ref`, `pattern`, `default`, `oneOf`, `null` type or tuple `items`.
- Counts (`minItems`, `maxItems`, `minLength`, `maxLength`) are whole numbers of 0 or more; every minimum is ≤ its maximum.
- At most 8 levels deep (the root is level 1) and 256 nodes in total.
- Unlike `settings_schema`, `enum` only works on strings.
- Data: properties outside `required` may be left out but never `null`; unknown properties are refused; integers must be whole numbers. Errors name the place, such as `questions[3].answer: gebruik 1–80 tekens.`
- A saved set is ≤ 64 KiB serialized and is checked against the kind in the game's **active** release, and again when a room is created with it. Rooms keep their own copy.

Players make and edit sets at `/home/sets` (a plain JSON editor for custom games, with the engine's error messages). Keep the schema small enough to fill in by hand, and put `title`s on the fields people type into.
