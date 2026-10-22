# Package layout, manifest and settings schema

Source of truth: the engine's `src/catalog.rs` (validation at startup) and `docs/GAME-DEVELOPMENT.md`.

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
| `title` | Non-empty, ≤ 200 chars. Shown in `/demo`. |
| `description` | ≤ 4000 chars. |
| `version` | Non-empty, ≤ 100 chars (free text; use semver). |
| `min_players` / `max_players` | `1 ≤ min ≤ max ≤ 100`. A room's capacity is chosen at creation between them (default `min(max_players, 24)`). `min_players` is **not** enforced at start — check it in your host UI if it matters. |
| `has_display` | `true` requires `display.html`. `false` makes rooms with `display_enabled` invalid. |
| `runtime` | `"host"` (default). `"server"` is only for built-in Rust games. |
| `host_modes` / `default_host_mode` | Must be `["moderator"]` / `"moderator"` (the defaults) for `runtime: "host"`. |
| `supports_late_join` | Default `true`. Set `false` unless the host logic handles players appearing during `running`. The room still has to opt in with `allow_late_join`. |
| `default_settings` | Must validate against `settings_schema`. |

Unknown manifest fields are ignored, but do not invent ones — nothing reads them.

## settings_schema (a strict JSON Schema subset)

- Top level: exactly `type: "object"`, `properties`, `additionalProperties: false`; optional `required` (unique names of declared properties), `title`, `description`, `default`.
- Property keys allowed: `type`, `enum`, `minimum`, `maximum`, `maxLength`, `title`, `description`, `default`. Anything else (`$ref`, `pattern`, `items`, `minLength`, nested objects, arrays) makes the engine refuse to start: `Unsupported settings schema feature: <key>`.
- `type` ∈ `integer`, `number`, `string`, `boolean`. `minimum`/`maximum` only on numeric types (and `min ≤ max`); `maxLength` only on strings; `enum` non-empty, no duplicates, every value valid for the type.
- `title`/`description` must be strings; `/demo` uses them to label the settings form.
- Settings objects are ≤ 8 KiB. `setSettings` replaces the whole object and is validated against the schema; when creating a room, given settings are merged over `default_settings`.

## data.json (private game data)

For answers, word lists or question banks the players must not see. The host loads it once:

```js
import { ApiClient } from '/sdk/mini-engine.js';
const data = await new ApiClient().gameData(session.code, session.token); // host token only
```

Never put such data under `assets/` or in HTML — those are public URLs. Reveal items by copying them into `public_state` at the right moment.
