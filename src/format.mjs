export function maskToken(token) {
  if (!token) return '(geen)';
  const prefix = /^[a-z]+_/.exec(token)?.[0] ?? '';
  return token.length >= 12 ? `${prefix}…${token.slice(-4)}` : `${prefix}…`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1).replace('.', ',')} ${units[unit]}`;
}

const pad = number => String(number).padStart(2, '0');

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '-';
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function table(headers, rows) {
  const cells = [headers, ...rows].map(row => row.map(cell => String(cell ?? '-')));
  const widths = headers.map((_, column) => Math.max(...cells.map(row => [...row[column]].length)));
  return cells
    .map(row => row.map((cell, column) => (column === row.length - 1 ? cell : cell + ' '.repeat(widths[column] - [...cell].length))).join('  ').trimEnd())
    .join('\n');
}

export const yesNo = value => (value ? 'ja' : 'nee');

export function gameStatus(game) {
  if (game.blocked) return 'geblokkeerd';
  return game.enabled ? 'aan' : 'uit';
}

export function tildePath(path, home) {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}
