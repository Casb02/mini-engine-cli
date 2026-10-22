import assert from 'node:assert/strict';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { configPath, loadConfig, normalizeServer, resolveSettings, saveConfig, updateConfig } from '../src/config.mjs';
import { formatBytes, maskToken, table, terminalSafe } from '../src/format.mjs';
import { checkManifest, collectFiles, compileIgnore, isIgnored, packGame, parseIgnore } from '../src/pack.mjs';
import { selectPrune } from '../src/prune.mjs';
import { scaffoldGame } from '../src/scaffold.mjs';
import { tempHome } from './helpers/run.mjs';

const KEY = `med_${'ab12'.repeat(16)}`;
let home;
let cleanup;
before(async () => ({ home, cleanup } = await tempHome()));
after(() => cleanup());

const write = async (root, path, content = 'x') => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
};

const manifest = (overrides = {}) =>
  JSON.stringify({ id: 'demo', title: 'Demo', version: '1.0.0', runtime: 'host', host_modes: ['moderator'], default_host_mode: 'moderator', has_display: false, ...overrides });

async function gameDir(name, extra = {}) {
  const root = join(home, name);
  await write(root, 'manifest.json', manifest());
  await write(root, 'host.html', '<p>host</p>');
  await write(root, 'player.html', '<p>player</p>');
  for (const [path, content] of Object.entries(extra)) await write(root, path, content);
  return root;
}

describe('config', () => {
  test('uses XDG_CONFIG_HOME when set, otherwise ~/.config', () => {
    assert.equal(configPath({ HOME: '/h' }), '/h/.config/miniengine/config.json');
    assert.equal(configPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), '/x/miniengine/config.json');
  });

  test('writes the file 0600 in a 0700 directory and keeps other keys', async () => {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'cfg') };
    await saveConfig(env, { server: 'http://a', admin_token: 'x'.repeat(40) });
    await updateConfig(env, { token: KEY });
    const path = configPath(env);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'cfg', 'miniengine'))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { server: 'http://a', token: KEY, admin_token: 'x'.repeat(40) });
    await updateConfig(env, { token: null });
    assert.deepEqual(await loadConfig(env), { server: 'http://a', admin_token: 'x'.repeat(40) });
  });

  test('tightens permissions of an existing, too open config', async () => {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'open') };
    await write(join(home, 'open', 'miniengine'), 'config.json', '{}');
    await updateConfig(env, { token: KEY });
    assert.equal((await stat(configPath(env))).mode & 0o777, 0o600);
  });

  test('environment overrides the config file, flags override both', async () => {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'prio') };
    await saveConfig(env, { server: 'http://config:1', token: KEY, admin_token: 'a'.repeat(40) });
    let settings = await resolveSettings(env);
    assert.equal(settings.server, 'http://config:1');
    assert.equal(settings.tokenSource, 'config');
    settings = await resolveSettings({ ...env, MINIENGINE_SERVER: 'http://env:2/', MINIENGINE_TOKEN: 'med_env', MINIENGINE_ADMIN_TOKEN: 'b'.repeat(40) });
    assert.equal(settings.server, 'http://env:2');
    assert.equal(settings.token, 'med_env');
    assert.equal(settings.adminToken, 'b'.repeat(40));
    settings = await resolveSettings({ ...env, MINIENGINE_SERVER: 'http://env:2' }, { server: 'https://flag.example' });
    assert.equal(settings.server, 'https://flag.example');
    assert.equal((await resolveSettings({ HOME: join(home, 'none') })).server, 'https://miniengine.nl');
  });

  test('rejects malformed config and server URLs', async () => {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'bad') };
    await write(join(home, 'bad', 'miniengine'), 'config.json', '[1]');
    await assert.rejects(loadConfig(env), /geen geldige configuratie/);
    assert.throws(() => normalizeServer('ftp://x'), /http:\/\//);
    assert.throws(() => normalizeServer('niet een url'), /Ongeldige server-URL/);
    assert.equal(normalizeServer(' https://games.example.nl/sub/ '), 'https://games.example.nl/sub');
  });
});

describe('format', () => {
  test('strips terminal control sequences from server text', () => {
    assert.equal(terminalSafe('Quiz\u001b[2J\u001b]0;pwned\u0007 Night\r\u009b31m'), 'Quiz[2J]0;pwned Night31m');
    assert.equal(terminalSafe('regel 1\nregel 2\tkolom'), 'regel 1\nregel 2\tkolom');
    assert.doesNotMatch(table(['id'], [['evil\u001b[31m']]), /\u001b/);
  });
  test('masks tokens to prefix and last four characters', () => {
    assert.equal(maskToken(KEY), 'med_…ab12');
    assert.equal(maskToken('e2e-admin-token-0123456789abcdef0123456789'), '…6789');
    assert.equal(maskToken('short'), '…');
    assert.equal(maskToken(''), '(geen)');
  });

  test('formats sizes in binary units with a decimal comma', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1,5 KiB');
    assert.equal(formatBytes(10 * 1024 * 1024), '10,0 MiB');
  });
});

describe('ignore rules', () => {
  test('supports *, **, anchored and directory-only patterns', () => {
    const rules = parseIgnore('# commentaar\n\n*.psd\nassets/raw/\n/build\ndocs/**/*.md\n**/tmp\n');
    assert.equal(isIgnored(rules, 'logo.psd', false), true);
    assert.equal(isIgnored(rules, 'assets/img/logo.psd', false), true);
    assert.equal(isIgnored(rules, 'assets/raw', true), true);
    assert.equal(isIgnored(rules, 'assets/raw', false), false);
    assert.equal(isIgnored(rules, 'build', true), true);
    assert.equal(isIgnored(rules, 'assets/build', true), false);
    assert.equal(isIgnored(rules, 'docs/a.md', false), true);
    assert.equal(isIgnored(rules, 'docs/x/y/a.md', false), true);
    assert.equal(isIgnored(rules, 'assets/a.md', false), false);
    assert.equal(isIgnored(rules, 'a/b/tmp', true), true);
    assert.equal(compileIgnore('# x'), null);
    assert.throws(() => compileIgnore('!keep.txt'), /niet ondersteund/);
  });

  test('skips dotfiles, node_modules, top-level tests/ and .meignore patterns', async () => {
    const root = await gameDir('skip', {
      '.env': 'secret',
      '.git/config': 'x',
      'assets/.DS_Store': 'x',
      'node_modules/pkg/index.js': 'x',
      'assets/node_modules/a.js': 'x',
      'tests/rules.test.mjs': 'x',
      'assets/tests/data.json': '{}',
      'notes/todo.txt': 'x',
      'assets/big.psd': 'x',
      'assets/app.js': 'x',
      '.meignore': 'notes/\n*.psd\n',
    });
    const paths = (await collectFiles(root)).map(file => file.path);
    assert.deepEqual(paths, ['assets/app.js', 'assets/tests/data.json', 'host.html', 'manifest.json', 'player.html']);
  });
});

describe('packing', () => {
  test('refuses symlinks, but not inside skipped folders', async () => {
    const root = await gameDir('links');
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(join(root, 'host.html'), join(root, 'node_modules', 'link'));
    await packGame(root);
    await symlink(join(root, 'host.html'), join(root, 'assets-link.html'));
    await assert.rejects(packGame(root), /Symlinks worden niet geüpload: assets-link.html/);
  });

  test('enforces file, total, count, path length and depth limits locally', async () => {
    const big = await gameDir('big', { 'assets/huge.bin': Buffer.alloc(2 * 1024 * 1024 + 1) });
    await assert.rejects(packGame(big), /groter dan 2,0 MiB: assets\/huge.bin/);

    const total = await gameDir('total');
    for (let i = 0; i < 6; i += 1) await write(total, `assets/part${i}.bin`, Buffer.alloc(2 * 1024 * 1024 - 10));
    await assert.rejects(packGame(total), /Game is te groot/);

    const many = await gameDir('many');
    await mkdir(join(many, 'assets'), { recursive: true });
    await Promise.all(Array.from({ length: 4094 }, (_, i) => writeFile(join(many, 'assets', `f${i}.txt`), '')));
    await assert.rejects(packGame(many), /Te veel bestanden: 4097/);

    const long = await gameDir('long', { [`assets/${'a'.repeat(120)}/${'b'.repeat(140)}.txt`]: 'x' });
    await assert.rejects(packGame(long), /Pad langer dan 255 bytes/);

    const deep = await gameDir('deep', { [`${Array.from({ length: 32 }, () => 'd').join('/')}/f.txt`]: 'x' });
    await assert.rejects(packGame(deep), /dieper dan 32 niveaus/);
  });

  test('validates the manifest before uploading', () => {
    const paths = ['manifest.json', 'host.html', 'player.html'];
    assert.equal(checkManifest(manifest(), paths).id, 'demo');
    assert.throws(() => checkManifest('{', paths), /geen geldige JSON/);
    assert.throws(() => checkManifest(manifest({ id: 'Demo' }), paths), /id moet/);
    assert.throws(() => checkManifest(manifest({ version: '.1' }), paths), /version moet/);
    assert.throws(() => checkManifest(manifest({ runtime: 'server' }), paths), /runtime "host"/);
    assert.throws(() => checkManifest(manifest({ host_modes: ['moderator', 'player'] }), paths), /host_modes/);
    assert.throws(() => checkManifest(manifest({ has_display: true }), paths), /Ontbrekende bestanden: display.html/);
    assert.throws(() => checkManifest(manifest(), ['manifest.json', 'player.html']), /host.html/);
  });

  test('pre-checks achievements and set_kinds with the engine rules', () => {
    const paths = ['manifest.json', 'host.html', 'player.html'];
    const achievement = (overrides = {}) => ({ id: 'eerste-buzz', title: 'Eerste buzz', description: 'Druk als eerste op de knop.', ...overrides });
    const kind = (overrides = {}) => ({ id: 'bord', title: 'Eigen bord', description: 'Vijf categorieën.', schema: { type: 'string' }, ...overrides });
    const ok = fields => checkManifest(manifest(fields), paths);
    const refused = (fields, pattern) => assert.throws(() => checkManifest(manifest(fields), paths), pattern);

    assert.deepEqual(ok({ achievements: [achievement()], set_kinds: [kind()] }).achievements, [achievement()]);
    ok({ achievements: [], set_kinds: [] });
    ok({ achievements: [achievement({ id: `a${'b'.repeat(47)}`, title: '🎉'.repeat(60), description: 'é'.repeat(160) })] });
    ok({ achievements: [achievement({ id: '0_ronde-1' })] });
    refused({ achievements: null }, /achievements moet een lijst zijn/);
    refused({ achievements: [achievement({ id: `a${'b'.repeat(48)}` })] }, /achievements\[0\]\.id moet/);
    refused({ achievements: [achievement({ id: '_ronde' })] }, /achievements\[0\]\.id moet/);
    refused({ achievements: [achievement({ id: 'Ronde' })] }, /achievements\[0\]\.id moet/);
    refused({ achievements: [achievement({ id: 7 })] }, /achievements\[0\] moet een object zijn/);
    refused({ achievements: ['eerste-buzz'] }, /achievements\[0\] moet een object zijn/);
    refused({ achievements: [achievement({ title: 'Eerste\tbuzz' })] }, /achievement eerste-buzz: gebruik een titel/);
    refused({ achievements: [achievement({ description: 'é'.repeat(161) })] }, /beschrijving van 1 tot 160 tekens/);
    refused({ achievements: [achievement({ title: '' })] }, /gebruik een titel van 1 tot 60 tekens/);
    refused({ set_kinds: 'bord' }, /set_kinds moet een lijst zijn/);
    refused({ set_kinds: [kind(), kind({ title: 'Ander bord' })] }, /het id bord komt twee keer voor in set_kinds/);
    refused({ set_kinds: [kind({ schema: undefined })] }, /set-soort bord: schema moet een object zijn/);
    refused({ set_kinds: [kind({ schema: null })] }, /set-soort bord: schema moet een object zijn/);
    refused({ set_kinds: [{ id: 'bord', title: 'Eigen bord', schema: {} }] }, /set_kinds\[0\] moet een object zijn met id, title, description \(tekst\) en schema/);
  });

  test('a scaffolded game packs without its editor files', async () => {
    const { directory } = await scaffoldGame('ja-of-nee', join(home, 'ja-of-nee'));
    const pack = await packGame(directory);
    assert.equal(pack.id, 'ja-of-nee');
    assert.equal(pack.manifest.runtime, 'host');
    assert.deepEqual(pack.manifest.host_modes, ['moderator']);
    assert.deepEqual(
      pack.files.map(file => file.path),
      ['README.md', 'assets/app.js', 'assets/style.css', 'display.html', 'host.html', 'manifest.json', 'player.html'],
    );
    assert.equal(Buffer.from(pack.encoded['host.html'], 'base64').toString().includes('"/games/ja-of-nee/assets/app.js"'), true);
    await assert.rejects(scaffoldGame('ja-of-nee', directory), /Map bestaat al/);
    await assert.rejects(scaffoldGame('Ja', join(home, 'x')), /Slug moet/);
  });
});

describe('prune selection', () => {
  const release = (version, created_at, extra = {}) => ({ version, created_at, active: false, in_use: false, ...extra });
  const game = versions => ({ id: 'g', active_version: versions.find(r => r.active)?.version ?? null, versions });

  test('keeps the active release and the newest N, deletes the rest', () => {
    const plan = selectPrune(game([release('1', 1), release('2', 2, { active: true }), release('3', 3), release('4', 4), release('5', 5)]), 2);
    assert.deepEqual(plan.keep.map(r => r.version), ['5', '4', '2']);
    assert.deepEqual(plan.delete.map(r => r.version), ['3', '1']);
    assert.deepEqual(plan.in_use, []);
  });

  test('skips releases pinned by a live room', () => {
    const plan = selectPrune(game([release('1', 1, { in_use: true }), release('2', 2), release('3', 3, { active: true })]), 0);
    assert.deepEqual(plan.keep.map(r => r.version), ['3']);
    assert.deepEqual(plan.in_use.map(r => r.version), ['1']);
    assert.deepEqual(plan.delete.map(r => r.version), ['2']);
  });

  test('keeps N newest on top of the active release', () => {
    const plan = selectPrune(game([release('1', 1, { active: true }), release('2', 2), release('3', 3)]), 1);
    assert.deepEqual(plan.keep.map(r => r.version), ['3', '1']);
    assert.deepEqual(plan.delete.map(r => r.version), ['2']);
  });

  test('orders equal timestamps by server order and accepts ISO dates', () => {
    const plan = selectPrune(game([release('a', '2026-01-01T00:00:00Z'), release('b', '2026-01-01T00:00:00Z'), release('c', '2025-01-01T00:00:00Z')]), 1);
    assert.deepEqual(plan.keep.map(r => r.version), ['b']);
    assert.deepEqual(plan.delete.map(r => r.version), ['a', 'c']);
  });
});
