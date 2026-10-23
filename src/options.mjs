import { usageError } from './errors.mjs';

export const templates = () => import('../vendor/sdk/bin/templates.mjs');

const LOOKS = { 'mini-engine-ui': 'mini-engine-ui', miniengineui: 'mini-engine-ui', ui: 'mini-engine-ui', plain: 'plain', eenvoudig: 'plain' };
const LANGUAGES = { nl: 'nl', nederlands: 'nl', dutch: 'nl', en: 'en', english: 'en', engels: 'en' };
export const THEMES = ['kalk', 'nacht', 'vilt', 'studio'];
export const MODES = ['playing', 'tv'];

export function parseTemplate(value, names) {
  const name = value.trim().toLowerCase();
  if (!names.includes(name)) throw usageError(`Onbekend sjabloon: ${value}`, `Kies uit: ${names.join(', ')}.`);
  return name;
}

export function parsePlayers(value) {
  const match = /^\s*(\d{1,3})\s*(?:[-–]\s*(\d{1,3}))?\s*$/.exec(value);
  const min = Number(match?.[1]);
  const max = Number(match?.[2] ?? match?.[1]);
  if (!match || min < 1 || min > max || max > 100) throw usageError('Spelers zijn MIN-MAX, bijvoorbeeld 2-8, van 1 tot 100.');
  return { minPlayers: min, maxPlayers: max };
}

export function parseModes(value) {
  const modes = value.split(',').map(mode => mode.trim().toLowerCase()).filter(Boolean);
  if (!modes.length || new Set(modes).size !== modes.length || !modes.every(mode => MODES.includes(mode))) {
    throw usageError('Kies playing, tv of playing,tv. De eerste is de standaard.', 'playing is Iedereen doet mee, tv is TV.');
  }
  return modes;
}

export function parseLook(value) {
  const look = LOOKS[value.trim().toLowerCase()];
  if (!look) throw usageError(`Onbekend uiterlijk: ${value}`, 'Kies mini-engine-ui of plain.');
  return look;
}

export function parseTheme(value) {
  const theme = value.trim().toLowerCase();
  if (!THEMES.includes(theme)) throw usageError(`Onbekend thema: ${value}`, `Kies uit: ${THEMES.join(', ')}.`);
  return theme;
}

export function parseLanguage(value) {
  const language = LANGUAGES[value.trim().toLowerCase()];
  if (!language) throw usageError(`Onbekende taal: ${value}`, 'Kies nl of en.');
  return language;
}

export function checkTitle(value) {
  const title = value.trim();
  if (!title || [...title].length > 80 || /\p{Cc}/u.test(title)) throw usageError('Een titel heeft 1 tot 80 tekens, zonder regeleinden.');
  return title;
}

/** The game options from flags; only what was given. */
export async function gameOptionsFromFlags(flags) {
  const { templateList } = await templates();
  const options = {};
  if (flags.template !== undefined) options.template = parseTemplate(flags.template, templateList().map(template => template.name));
  if (flags.title !== undefined) options.title = checkTitle(flags.title);
  if (flags.players !== undefined) Object.assign(options, parsePlayers(flags.players));
  if (flags.modes !== undefined) options.hostModes = parseModes(flags.modes);
  if (flags.look !== undefined) options.look = parseLook(flags.look);
  if (flags.theme !== undefined) options.theme = parseTheme(flags.theme);
  if (flags.lang !== undefined) options.language = parseLanguage(flags.lang);
  return options;
}

export const gameOptionFlags = {
  template: { type: 'string' },
  title: { type: 'string' },
  players: { type: 'string' },
  modes: { type: 'string' },
  look: { type: 'string' },
  theme: { type: 'string' },
  lang: { type: 'string' },
};
