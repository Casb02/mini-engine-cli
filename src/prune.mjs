const time = value => (typeof value === 'number' ? value : Date.parse(value ?? '') || 0);

export function newestFirst(versions) {
  return versions
    .map((release, index) => ({ release, index }))
    .sort((a, b) => time(b.release.created_at) - time(a.release.created_at) || b.index - a.index)
    .map(({ release }) => release);
}

export function selectPrune(game, keep) {
  const ordered = newestFirst(game.versions ?? []);
  const newest = new Set(ordered.slice(0, keep).map(release => release.version));
  const result = { keep: [], delete: [], in_use: [] };
  for (const release of ordered) {
    if (release.active || release.version === game.active_version || newest.has(release.version)) result.keep.push(release);
    else if (release.in_use) result.in_use.push(release);
    else result.delete.push(release);
  }
  return result;
}
