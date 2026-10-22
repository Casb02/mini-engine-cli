const MAX_DEPTH = 128;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function stringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return stringify(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort(compare)) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stringify(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

export const jsonBytes = value => Buffer.byteLength(stringify(value));

export const jsonEqual = (a, b) => stringify(a) === stringify(b);

function tooDeep(root) {
  const stack = [[root, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (depth > MAX_DEPTH) return true;
    for (const child of Array.isArray(value) ? value : Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}

export function parseJson(text) {
  const value = JSON.parse(text);
  if (tooDeep(value)) throw new SyntaxError('recursion limit exceeded');
  return value;
}

export const sortedKeys = object => Object.keys(object).sort(compare);
