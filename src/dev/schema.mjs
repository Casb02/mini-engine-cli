import { bad, EngineError } from './errors.mjs';
import { isObject, jsonBytes, jsonEqual, sortedKeys, stringify } from './json.mjs';

const SCHEMA_KEYS = ['type', 'properties', 'required', 'additionalProperties', 'title', 'description', 'default'];
const PROPERTY_KEYS = ['type', 'enum', 'minimum', 'maximum', 'maxLength', 'title', 'description', 'default'];
export const MAX_ACHIEVEMENTS = 50;
export const MAX_SET_KINDS = 4;
export const MAX_SETTING_CHOICES = 64;
export const MAX_SET_BYTES = 64 * 1024;
const SET_MAX_DEPTH = 8;
const SET_MAX_NODES = 256;
const SET_MAX_ENUM = 256;
const ANNOTATIONS = ['type', 'title', 'description'];
const DASH = '–';

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const isCount = value => Number.isInteger(value) && value >= 0;
export const charCount = text => [...text].length;
export const isControl = char => {
  const code = char.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};
export const hasControl = text => [...text].some(isControl);

function allowKeys(object, allowed) {
  const key = sortedKeys(object).find(name => !allowed.includes(name));
  if (key !== undefined) throw bad(`Unsupported settings schema feature: ${key}`);
}

function annotations(object) {
  for (const key of ['title', 'description']) {
    if (key in object && typeof object[key] !== 'string') throw bad('Schema titles and descriptions must be strings.');
  }
}

export function validateSettingsSchema(schema) {
  if (!isObject(schema)) throw bad('Settings schema must be an object.');
  allowKeys(schema, SCHEMA_KEYS);
  annotations(schema);
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    throw bad('Settings schema must have type object and additionalProperties false.');
  }
  const properties = schema.properties;
  if (!isObject(properties)) throw bad('Settings schema properties must be an object.');
  if ('required' in schema) {
    if (!Array.isArray(schema.required)) throw bad('Required settings must be an array.');
    const seen = new Set();
    for (const name of schema.required) {
      if (typeof name !== 'string') throw bad('Required setting names must be strings.');
      if (!Object.hasOwn(properties, name) || seen.has(name)) throw bad('Required setting must name a unique declared property.');
      seen.add(name);
    }
  }
  for (const name of sortedKeys(properties)) {
    const property = properties[name];
    if (!isObject(property)) throw bad('Setting property schema must be an object.');
    allowKeys(property, PROPERTY_KEYS);
    annotations(property);
    const kind = typeof property.type === 'string' ? property.type : '';
    if (!['integer', 'number', 'string', 'boolean'].includes(kind)) throw bad('Unsupported setting property type.');
    for (const key of ['minimum', 'maximum']) {
      if (key in property && (!['integer', 'number'].includes(kind) || !isNumber(property[key]))) {
        throw bad('Numeric setting bounds require a number type and numeric value.');
      }
    }
    if (isNumber(property.minimum) && isNumber(property.maximum) && property.minimum > property.maximum) {
      throw bad('Setting minimum exceeds maximum.');
    }
    if ('maxLength' in property && (kind !== 'string' || !isCount(property.maxLength))) {
      throw bad('maxLength requires a string type and a nonnegative integer.');
    }
    if ('enum' in property) {
      const choices = property.enum;
      if (!Array.isArray(choices) || !choices.length) throw bad('Setting enum must be a nonempty array.');
      if (choices.length > MAX_SETTING_CHOICES) throw bad(`Een enum in de instellingen heeft hoogstens ${MAX_SETTING_CHOICES} waarden.`);
      const seen = new Set();
      for (const choice of choices) {
        validateProperty(property, choice);
        const key = stringify(choice);
        if (seen.has(key)) throw bad('Setting enum must not contain duplicate values.');
        seen.add(key);
      }
    }
    if ('default' in property) validateProperty(property, property.default);
  }
  if ('default' in schema) validateSettings(schema, schema.default);
}

export function validateSettings(schema, settings) {
  if (!isObject(settings)) throw bad('Settings must be a JSON object.');
  const properties = schema?.properties;
  if (!isObject(properties)) throw bad('Invalid settings schema.');
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string' && !Object.hasOwn(settings, name)) throw bad(`Missing required setting: ${name}`);
    }
  }
  for (const name of sortedKeys(settings)) {
    if (!Object.hasOwn(properties, name)) throw bad(`Unknown setting: ${name}`);
    validateProperty(properties[name], settings[name]);
  }
}

function validateProperty(schema, value) {
  const kind = typeof schema?.type === 'string' ? schema.type : '';
  const validType =
    kind === 'integer' ? Number.isInteger(value)
    : kind === 'number' ? isNumber(value)
    : kind === 'string' ? typeof value === 'string'
    : kind === 'boolean' ? typeof value === 'boolean'
    : false;
  if (!validType) throw bad('Setting has an invalid value type.');
  if (Array.isArray(schema.enum) && !schema.enum.some(choice => jsonEqual(choice, value))) {
    throw bad('Setting value is not in its allowed enum.');
  }
  if (isNumber(value) && ((isNumber(schema.minimum) && value < schema.minimum) || (isNumber(schema.maximum) && value > schema.maximum))) {
    throw bad('Setting value is outside its allowed range.');
  }
  if (typeof value === 'string' && isCount(schema.maxLength) && charCount(value) > schema.maxLength) {
    throw bad('Setting string exceeds its maximum length.');
  }
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const manifestText = (value, max) => typeof value === 'string' && value.trim() !== '' && charCount(value) <= max && !hasControl(value);

export function validateAchievements(achievements) {
  if (achievements.length > MAX_ACHIEVEMENTS) throw bad('Een game declareert maximaal 50 achievements.');
  const seen = new Set();
  for (const achievement of achievements) {
    if (!SLUG.test(achievement.id) || seen.has(achievement.id)) {
      throw bad(`Geef elke achievement een uniek id van 1${DASH}48 kleine letters, cijfers, _ of -, dat begint met een letter of cijfer.`);
    }
    seen.add(achievement.id);
    if (!manifestText(achievement.title, 60) || !manifestText(achievement.description, 160)) {
      throw bad(`Achievement ${achievement.id}: gebruik een titel van 1${DASH}60 tekens en een beschrijving van 1${DASH}160 tekens.`);
    }
  }
}

export function validateSetKinds(kinds) {
  if (kinds.length > MAX_SET_KINDS) throw bad('Een game declareert maximaal 4 soorten sets.');
  const seen = new Set();
  for (const kind of kinds) {
    if (!SLUG.test(kind.id) || seen.has(kind.id)) {
      throw bad(`Geef elke soort set een uniek id van 1${DASH}48 kleine letters, cijfers, _ of -, dat begint met een letter of cijfer.`);
    }
    seen.add(kind.id);
    if (!manifestText(kind.title, 60) || !manifestText(kind.description, 160)) {
      throw bad(`Set-soort ${kind.id}: gebruik een titel van 1${DASH}60 tekens en een beschrijving van 1${DASH}160 tekens.`);
    }
    try {
      validateSetSchema(kind.schema);
    } catch (error) {
      throw bad(`Set-soort ${kind.id}: ${error.message}`);
    }
  }
}

const at = (path, message) => bad(`${path}: ${message}`);

export function validateSetSchema(schema) {
  const nodes = { count: 0 };
  checkSchema(schema, 1, nodes, 'schema');
}

function checkSchema(schema, depth, nodes, path) {
  if (depth > SET_MAX_DEPTH) throw at(path, `een set-schema is hoogstens ${SET_MAX_DEPTH} niveaus diep.`);
  nodes.count += 1;
  if (nodes.count > SET_MAX_NODES) throw at(path, `een set-schema heeft hoogstens ${SET_MAX_NODES} onderdelen.`);
  if (!isObject(schema)) throw at(path, 'elk onderdeel van een set-schema is een object.');
  const kind = typeof schema.type === 'string' ? schema.type : '';
  const extra = {
    object: ['properties', 'required', 'additionalProperties'],
    array: ['items', 'minItems', 'maxItems'],
    string: ['minLength', 'maxLength', 'enum', 'format'],
    integer: ['minimum', 'maximum'],
    number: ['minimum', 'maximum'],
    boolean: [],
  }[kind];
  if (!extra) throw at(path, 'type moet object, array, string, integer, number of boolean zijn.');
  const unsupported = sortedKeys(schema).find(key => !ANNOTATIONS.includes(key) && !extra.includes(key));
  if (unsupported !== undefined) throw at(path, `${unsupported} wordt niet ondersteund bij type ${kind}.`);
  for (const key of ['title', 'description']) {
    if (key in schema && typeof schema[key] !== 'string') throw at(path, `${key} moet tekst zijn.`);
  }
  if (kind === 'object') return checkObject(schema, depth, nodes, path);
  if (kind === 'array') {
    countBounds(schema, 'minItems', 'maxItems', path);
    if (!('items' in schema)) throw at(path, 'een array heeft items nodig.');
    return checkSchema(schema.items, depth + 1, nodes, `${path}.items`);
  }
  if (kind === 'string') {
    if ('format' in schema) {
      if (schema.format !== 'image') throw at(path, 'format kan alleen "image" zijn.');
      const extra = ['minLength', 'maxLength', 'enum'].find(key => key in schema);
      if (extra !== undefined) throw at(path, `${extra} kan niet samen met format "image".`);
      return;
    }
    countBounds(schema, 'minLength', 'maxLength', path);
    if ('enum' in schema) {
      const choices = schema.enum;
      if (!Array.isArray(choices) || !choices.length) throw at(path, 'enum moet een niet-lege lijst zijn.');
      if (choices.length > SET_MAX_ENUM) throw at(path, `enum heeft hoogstens ${SET_MAX_ENUM} waarden.`);
      const seen = new Set();
      for (const choice of choices) {
        if (typeof choice !== 'string' || seen.has(choice)) throw at(path, 'enum bevat alleen unieke teksten.');
        seen.add(choice);
        checkLength(schema, choice, path);
      }
    }
    return;
  }
  if (kind === 'integer' || kind === 'number') {
    for (const key of ['minimum', 'maximum']) {
      if (key in schema && !isNumber(schema[key])) throw at(path, `${key} moet een getal zijn.`);
    }
    if (isNumber(schema.minimum) && isNumber(schema.maximum) && schema.minimum > schema.maximum) {
      throw at(path, 'minimum is groter dan maximum.');
    }
  }
}

function checkObject(schema, depth, nodes, path) {
  if (schema.additionalProperties !== false) throw at(path, 'een object heeft additionalProperties: false nodig.');
  const properties = schema.properties;
  if (!isObject(properties)) throw at(path, 'properties moet een object zijn.');
  if ('required' in schema) {
    if (!Array.isArray(schema.required)) throw at(path, 'required moet een lijst zijn.');
    const seen = new Set();
    for (const name of schema.required) {
      if (typeof name !== 'string' || !Object.hasOwn(properties, name) || seen.has(name)) {
        throw at(path, 'required noemt alleen eigen properties, elk één keer.');
      }
      seen.add(name);
    }
  }
  for (const name of sortedKeys(properties)) checkSchema(properties[name], depth + 1, nodes, `${path}.properties.${name}`);
}

function countBounds(schema, min, max, path) {
  for (const key of [min, max]) {
    if (key in schema && !isCount(schema[key])) throw at(path, `${key} moet een geheel getal van 0 of meer zijn.`);
  }
  if (isCount(schema[min]) && isCount(schema[max]) && schema[min] > schema[max]) throw at(path, `${min} is groter dan ${max}.`);
}

const label = path => path || 'data';

function range(low, high, unit) {
  if (low !== undefined && high !== undefined) return low === high ? `precies ${low} ${unit}` : `${low}${DASH}${high} ${unit}`;
  if (low !== undefined) return `minstens ${low} ${unit}`;
  if (high !== undefined) return `hoogstens ${high} ${unit}`;
  return unit;
}

const count = (schema, key) => (isCount(schema?.[key]) ? schema[key] : undefined);

function checkLength(schema, text, path) {
  const low = count(schema, 'minLength');
  const high = count(schema, 'maxLength');
  const length = charCount(text);
  if ((low !== undefined && length < low) || (high !== undefined && length > high)) {
    throw at(label(path), `gebruik ${range(low, high, 'tekens')}.`);
  }
}

// An image field holds a URL. In an account set that is /media/<id> of the account's own upload.
export const MEDIA_URL = /^\/media\/[0-9a-f]{32}$/;
export const noImage = (value, path) => {
  if (value === '') throw at(path, 'kies een afbeelding.');
};
const accountImage = (value, path) => {
  noImage(value, path);
  if (!MEDIA_URL.test(value)) throw at(path, 'verwacht een afbeelding: /media/ met het id van een eigen upload.');
};

/** `image(value, path)` checks the value of every image field; the default is the rule for account sets. */
export function validateSetData(schema, value, path = '', image = accountImage) {
  const wrong = expected => at(label(path), `verwacht ${expected}.`);
  const kind = typeof schema?.type === 'string' ? schema.type : '';
  if (kind === 'object') {
    if (!isObject(value)) throw wrong('een object');
    const child = name => (path ? `${path}.${name}` : name);
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === 'string' && !Object.hasOwn(value, name)) throw at(child(name), 'dit veld ontbreekt.');
    }
    for (const name of sortedKeys(value)) {
      const rule = isObject(schema.properties) && Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
      if (rule === undefined) throw at(child(name), 'dit veld is niet toegestaan.');
      validateSetData(rule, value[name], child(name), image);
    }
    return;
  }
  if (kind === 'array') {
    if (!Array.isArray(value)) throw wrong('een lijst');
    const low = count(schema, 'minItems');
    const high = count(schema, 'maxItems');
    if ((low !== undefined && value.length < low) || (high !== undefined && value.length > high)) {
      throw at(label(path), `gebruik ${range(low, high, 'items')}.`);
    }
    value.forEach((item, index) => validateSetData(schema.items, item, `${path}[${index}]`, image));
    return;
  }
  if (kind === 'string') {
    if (typeof value !== 'string') throw wrong(schema.format === 'image' ? 'een afbeelding' : 'tekst');
    if (schema.format === 'image') return image(value, label(path));
    checkLength(schema, value, path);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw at(label(path), 'kies een van de toegestane waarden.');
    return;
  }
  if (kind === 'integer' || kind === 'number') {
    if (!isNumber(value) || (kind === 'integer' && !Number.isInteger(value))) throw wrong(kind === 'integer' ? 'een geheel getal' : 'een getal');
    const low = isNumber(schema.minimum) ? schema.minimum : undefined;
    const high = isNumber(schema.maximum) ? schema.maximum : undefined;
    if ((low !== undefined && value < low) || (high !== undefined && value > high)) {
      const message =
        low !== undefined && high !== undefined ? `kies een getal van ${low} tot en met ${high}.`
        : low !== undefined ? `kies een getal van minstens ${low}.`
        : `kies een getal van hoogstens ${high}.`;
      throw at(label(path), message);
    }
    return;
  }
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw wrong('true of false');
    return;
  }
  throw bad('Ongeldig set-schema.');
}

export function validateSetContent(metadata, kind, data, image) {
  const declared = metadata.set_kinds.find(item => item.id === kind);
  if (!declared) throw bad('Dit spel kent deze soort set niet.');
  if (jsonBytes(data) > MAX_SET_BYTES) throw new EngineError(413, 'set_too_large', 'Een set mag maximaal 64 KiB zijn.');
  validateSetData(declared.schema, data, '', image);
}

/** Whether a set schema has an image field (format "image") anywhere. */
export const hasImageFields = schema =>
  isObject(schema) && (schema.format === 'image' || (isObject(schema.properties) && Object.values(schema.properties).some(hasImageFields)) || hasImageFields(schema.items));

/** An image in a game's own data.json is a file in the package: a relative path under assets/ without `..`. */
export const isPackagePath = value =>
  value.startsWith('assets/') && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/**
 * Problems with the image fields of data.json, for the set kinds whose shape it has. data.json need not be a set,
 * so a data.json that fits no set kind has none.
 */
export function dataImageProblems(setKinds, data, hasFile) {
  if (data === null || data === undefined) return [];
  for (const kind of setKinds) {
    try {
      validateSetData(kind.schema, data, '', () => {});
    } catch {
      continue;
    }
    const problems = [];
    validateSetData(kind.schema, data, '', (value, path) => {
      if (!isPackagePath(value)) problems.push(`${path}: gebruik een pad naar een bestand in de game, zoals assets/plaatje.png.`);
      else if (!hasFile(value)) problems.push(`${path}: ${value} staat niet in de game.`);
    });
    return problems;
  }
  return [];
}
