import assert from 'node:assert/strict';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { configPath, loadConfig, normalizeServer, resolveSettings, saveConfig, updateConfig } from '../src/config.mjs';
import { formatBytes, maskToken, table, terminalSafe } from '../src/format.mjs';
import { checkManifest, collectFiles, compileIgnore, isIgnored, packGame, parseIgnore } from '../src/pack.mjs';
import { selectPrune } from '../src/prune.mjs';
import { Readable } from 'node:stream';
import { createApp, isLoopback } from '../src/dev/http.mjs';
import { loadPackage } from '../src/dev/package.mjs';
import { dataImageProblems, hasImageFields, validateSetData, validateSetSchema } from '../src/dev/schema.mjs';
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

  test('a browser-host game may let the host play along, but never runs hostless', () => {
    const paths = ['manifest.json', 'host.html', 'player.html'];
    const ok = fields => checkManifest(manifest(fields), paths);
    const refused = (fields, pattern) => assert.throws(() => checkManifest(manifest(fields), paths), pattern);
    assert.deepEqual(ok({ host_modes: ['playing'], default_host_mode: 'playing' }).host_modes, ['playing']);
    ok({ host_modes: ['moderator', 'playing'], default_host_mode: 'playing' });
    ok({ host_modes: ['playing', 'moderator'], default_host_mode: 'moderator' });
    ok({ host_modes: ['moderator', 'playing'], default_host_mode: undefined });
    // 0.5.2: party games offer "Iedereen doet mee" and "TV".
    assert.deepEqual(ok({ host_modes: ['playing', 'tv'], default_host_mode: 'playing' }).host_modes, ['playing', 'tv']);
    ok({ host_modes: ['tv'], default_host_mode: 'tv' });
    refused({ host_modes: ['hostless'], default_host_mode: 'hostless' }, /host_modes moet een lijst zijn met "playing", "tv" en\/of "moderator"\. "hostless" is alleen voor ingebouwde games\./);
    refused({ host_modes: ['moderator', 'hostless'] }, /"hostless" is alleen voor ingebouwde games/);
    refused({ host_modes: [] }, /host_modes moet een lijst zijn/);
    refused({ host_modes: 'playing' }, /host_modes moet een lijst zijn/);
    refused({ host_modes: undefined }, /host_modes moet een lijst zijn/);
    refused({ host_modes: ['playing'], default_host_mode: 'moderator' }, /default_host_mode moet een van de host_modes zijn \("playing"\)\./);
    refused({ host_modes: ['playing'], default_host_mode: undefined }, /default_host_mode moet een van de host_modes zijn/);
  });

  test('checks the optional icon like the engine does', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#2b6"/></svg>';
    const files = { 'assets/icoon.svg': svg };
    const paths = () => ['manifest.json', 'host.html', 'player.html', ...Object.keys(files)];
    const contentOf = path => (path in files ? Buffer.from(files[path]) : undefined);
    const check = icon => checkManifest(manifest({ icon }), paths(), contentOf);
    const refused = (icon, pattern) => assert.throws(() => check(icon), pattern);

    assert.equal(check('assets/icoon.svg').icon, 'assets/icoon.svg');
    assert.equal(check(undefined).icon, undefined);
    assert.equal(check(null).icon, null, 'null means no icon, as in the engine');
    refused('icoon.svg', /manifest\.json: icon moet een SVG in assets\/ zijn, bijvoorbeeld "assets\/icoon\.svg"\./);
    refused('assets/icoon.png', /icon moet een SVG in assets\//);
    refused('assets/icoon.SVG', /icon moet een SVG in assets\//);
    refused(42, /icon moet een SVG in assets\//);
    refused('assets/weg.svg', /manifest\.json: icon assets\/weg\.svg staat niet in de game\./);
    assert.throws(() => checkManifest(manifest({ icon: 'assets/icoon.svg' }), paths()), /staat niet in de game/, 'without contents the icon cannot be checked');

    files['assets/groot.svg'] = `<svg>${' '.repeat(64 * 1024)}</svg>`;
    refused('assets/groot.svg', /icon assets\/groot\.svg is 65547 bytes; een icoon mag maximaal 65536 bytes \(64 KiB\) zijn\./);
    files['assets/precies.svg'] = `<svg>${' '.repeat(64 * 1024 - 11)}</svg>`;
    assert.equal(Buffer.byteLength(files['assets/precies.svg']), 64 * 1024);
    check('assets/precies.svg');
    files['assets/latin1.svg'] = '<svg>\u00e9</svg>';
    const latin1 = Buffer.from('<svg>\xe9</svg>', 'latin1');
    assert.throws(() => checkManifest(manifest({ icon: 'assets/latin1.svg' }), paths(), path => (path === 'assets/latin1.svg' ? latin1 : contentOf(path))), /icon assets\/latin1\.svg is geen geldige UTF-8\./);
    files['assets/png.svg'] = 'PNG';
    refused('assets/png.svg', /icon assets\/png\.svg is geen SVG: er staat geen <svg in\./);
    files['assets/hoofd.svg'] = '<SVG viewBox="0 0 48 48"></SVG>';
    check('assets/hoofd.svg');

    const bad = {
      script: ['<svg><SCRIPT>alert(1)</SCRIPT></svg>', /bevat <script\. Een icoon mag geen scripts bevatten\./],
      foreign: ['<svg><foreignObject><p>x</p></foreignObject></svg>', /bevat <foreignObject\./],
      link: ['<svg><a href="JavaScript:alert(1)"><rect/></a></svg>', /bevat javascript:\./],
      onload: ['<svg onload="alert(1)"></svg>', /bevat een on…=-attribuut\./],
      spaced: ['<svg><rect\nOnClick = "x"/></svg>', /bevat een on…=-attribuut/],
      slash: ['<svg/onload=alert(1)>', /bevat een on…=-attribuut/],
    };
    for (const [name, [content, pattern]] of Object.entries(bad)) {
      files[`assets/${name}.svg`] = content;
      refused(`assets/${name}.svg`, pattern);
    }
    const fine = { tekst: '<svg><text>Zon = heet, on=</text><g data-on="x" font="y"/></svg>' };
    for (const [name, content] of Object.entries(fine)) {
      files[`assets/${name}.svg`] = content;
      check(`assets/${name}.svg`);
    }
  });

  test('packs a game with its icon and refuses an icon that .meignore leaves out', async () => {
    const svg = '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12"/></svg>';
    const dir = await gameDir('icoon', { 'manifest.json': manifest({ icon: 'assets/icoon.svg' }), 'assets/icoon.svg': svg });
    assert.equal((await packGame(dir)).manifest.icon, 'assets/icoon.svg');
    await writeFile(join(dir, '.meignore'), '*.svg\n');
    await assert.rejects(packGame(dir), /manifest\.json: icon assets\/icoon\.svg staat niet in de game\./);
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
    assert.deepEqual(pack.manifest.host_modes, ['playing', 'tv']);
    assert.deepEqual(
      pack.files.map(file => file.path),
      ['README.md', 'assets/app.js', 'assets/icon.svg', 'assets/logic.js', 'assets/room.js', 'assets/style.css', 'assets/texts.js', 'display.html', 'host.html', 'manifest.json', 'player.html'],
    );
    assert.equal(Buffer.from(pack.encoded['host.html'], 'base64').toString().includes('"/games/ja-of-nee/assets/app.js"'), true);
    await assert.rejects(scaffoldGame('ja-of-nee', directory), /Map bestaat al/);
    await assert.rejects(scaffoldGame('Ja', join(home, 'x')), /Slug moet/);
  });
});

describe('images in set schemas', () => {
  const image = (extra = {}) => ({ type: 'string', format: 'image', ...extra });
  const board = (field = image()) => ({ type: 'object', additionalProperties: false, required: ['vragen'], properties: { vragen: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['vraag'], properties: { vraag: { type: 'string' }, plaatje: field } } } } });
  const ID = '0123456789abcdef0123456789abcdef';

  test('a string may have format image, without minLength, maxLength or enum', () => {
    validateSetSchema(image());
    validateSetSchema(image({ title: 'Plaatje', description: 'Bij de vraag.' }));
    validateSetSchema(board());
    validateSetSchema({ type: 'array', items: image(), maxItems: 4 });
    const refused = (schema, pattern) => assert.throws(() => validateSetSchema(schema), pattern);
    refused(image({ minLength: 1 }), /schema: minLength kan niet samen met format "image"\./);
    refused(image({ maxLength: 200 }), /schema: maxLength kan niet samen met format "image"\./);
    refused(image({ enum: ['/media/a'] }), /schema: enum kan niet samen met format "image"\./);
    refused(board(image({ maxLength: 9 })), /schema\.properties\.vragen\.items\.properties\.plaatje: maxLength kan niet samen met format "image"\./);
    refused(image({ format: 'uri' }), /schema: format kan alleen "image" zijn\./);
    refused(image({ format: 7 }), /schema: format kan alleen "image" zijn\./);
    refused({ type: 'integer', format: 'image' }, /schema: format wordt niet ondersteund bij type integer\./);
    refused({ type: 'object', additionalProperties: false, properties: {}, format: 'image' }, /format wordt niet ondersteund bij type object/);
    assert.equal(hasImageFields(board()), true);
    assert.equal(hasImageFields(board({ type: 'string' })), false);
  });

  test('in an account set an image is /media/ with the id of an upload; optional images may be left out', () => {
    validateSetData(board(), { vragen: [{ vraag: 'Wie?', plaatje: `/media/${ID}` }, { vraag: 'Waar?' }] });
    const refused = (data, pattern) => assert.throws(() => validateSetData(board(), data), pattern);
    refused({ vragen: [{ vraag: 'Wie?', plaatje: '' }] }, /vragen\[0\]\.plaatje: kies een afbeelding\./);
    refused({ vragen: [{ vraag: 'Wie?', plaatje: 7 }] }, /vragen\[0\]\.plaatje: verwacht een afbeelding\./);
    for (const value of [`/media/${ID.toUpperCase()}`, `/media/${ID}0`, `https://example.com/media/${ID}`, `media/${ID}`, '/media/plaatje.png', 'assets/plaatje.png']) {
      refused({ vragen: [{ vraag: 'Wie?', plaatje: value }] }, /vragen\[0\]\.plaatje: verwacht een afbeelding: \/media\/ met het id van een eigen upload\./);
    }
  });

  test('an image in data.json is a file in the game under assets/', () => {
    const files = new Set(['assets/vragen/1.png']);
    const has = path => files.has(path);
    assert.deepEqual(dataImageProblems([{ id: 'bord', schema: board() }], { vragen: [{ vraag: 'Wie?', plaatje: 'assets/vragen/1.png' }] }, has), []);
    assert.deepEqual(dataImageProblems([{ id: 'bord', schema: board() }], { vragen: [{ vraag: 'Wie?', plaatje: 'assets/vragen/2.png' }] }, has), ['vragen[0].plaatje: assets/vragen/2.png staat niet in de game.']);
    for (const value of ['/media/1.png', '../assets/vragen/1.png', 'assets/../manifest.json', 'assets//vragen/1.png', '/games/demo/assets/vragen/1.png', 'vragen/1.png', 'assets\\vragen\\1.png', '']) {
      assert.deepEqual(dataImageProblems([{ id: 'bord', schema: board() }], { vragen: [{ vraag: 'Wie?', plaatje: value }] }, has), ['vragen[0].plaatje: gebruik een pad naar een bestand in de game, zoals assets/plaatje.png.'], value);
    }
    assert.deepEqual(dataImageProblems([{ id: 'bord', schema: board() }], { iets: 'anders' }, has), [], 'a data.json that is no set is left alone');
    assert.deepEqual(dataImageProblems([{ id: 'bord', schema: board() }], null, has), []);
  });

  test('the quiz template has pictures in its set and passes the engine rules', async () => {
    const { directory } = await scaffoldGame('plaatjesquiz', join(home, 'plaatjesquiz'), { template: 'quiz' });
    const pkg = await loadPackage(directory);
    assert.equal(hasImageFields(pkg.metadata.set_kinds[0].schema), true);
    assert.deepEqual(pkg.warnings, []);
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

describe('me dev access from the network', () => {
  const LAUNCHER = 3570;
  const JOIN = 3571;
  const PHONE = 3572;
  const LOCAL_SEAT = 3573;
  const calls = [];
  const app = createApp({
    engine: { info: () => ({ game_id: 'feest', game_version: '0.1.0' }) },
    project: { metadata: { id: 'feest', version: '0.1.0' }, html: () => '<p>speler</p>', asset: () => undefined, media: async () => null },
    session: () => ({
      state: () => ({ seats: [{ hash: 'geheim' }] }),
      joinInfo: () => ({ title: 'Feest', open: true }),
      newRoom: async () => calls.push('room'),
      addPlayer: async () => calls.push('player'),
      addPhone: async name => ({ label: name, remote: true }),
    }),
    launcherPort: () => LAUNCHER,
    lanHosts: ['192.168.1.5'],
    joinPort: () => JOIN,
    phonePorts: () => new Set([PHONE]),
  });
  /** Calls the app the way Node would, with the socket address of a phone on the network. */
  function send(port, method, path, { remote = '192.168.1.20', host = '192.168.1.5', body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: `${host}:${port}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, socket: { localPort: port, remoteAddress: remote } });
    return new Promise(resolve => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.type = headers['content-type'] ?? '';
          this.headersSent = true;
        },
        setHeader() {},
        write() {},
        end(chunk) {
          const text = chunk ? String(chunk) : '';
          resolve({ status: this.status, text, json: this.type.includes('json') && text ? JSON.parse(text) : null });
        },
        destroy() {},
      };
      app.request(req, res);
    });
  }

  test('loopback is decided on the socket address', () => {
    for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(address), true, address);
    for (const address of ['192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) assert.equal(isLoopback(address), false, address);
  });

  test('a phone gets 403 on the overview, its events, new rooms and new players, whatever Host it sends', async () => {
    for (const port of [LAUNCHER, PHONE, LOCAL_SEAT]) {
      for (const [method, path] of [['GET', '/__me/state'], ['GET', '/__me/events'], ['POST', '/__me/room'], ['POST', '/__me/players']]) {
        for (const host of ['192.168.1.5', '127.0.0.1']) {
          const result = await send(port, method, path, { host, body: method === 'POST' ? {} : undefined });
          assert.ok([403, 421].includes(result.status), `${method} ${path} on ${port} as ${host}: ${result.status}`);
          assert.doesNotMatch(result.text, /geheim/);
        }
      }
    }
    assert.deepEqual(calls, []);
  });

  test('on its own seat a phone reaches only what a player needs', async () => {
    assert.equal((await send(PHONE, 'GET', '/room/ABCDEF/player')).status, 200);
    assert.equal((await send(PHONE, 'GET', '/sdk/mini-engine.js')).status, 200);
    assert.equal((await send(PHONE, 'GET', '/api/v1/games/feest/player?room=ABCDEF')).status, 200);
    assert.equal((await send(PHONE, 'GET', '/media/plaatje.png')).json.error.code, 'media_not_found', 'a phone may load the pictures of a set');
    for (const [method, path] of [
      ['GET', '/room/ABCDEF/host'],
      ['GET', '/room/ABCDEF/display'],
      ['GET', '/api/v1/games/feest/host'],
      ['POST', '/api/v1/rooms'],
      ['POST', '/api/v1/rooms/ABCDEF/join'],
      ['POST', '/api/v1/rooms/ABCDEF/display-token'],
      ['GET', '/api/v1/rooms/ABCDEF/game-data'],
      ['GET', '/'],
      ['GET', '/niets'],
    ]) {
      assert.equal((await send(PHONE, method, path, { body: method === 'POST' ? {} : undefined })).status, 403, `${method} ${path}`);
    }
    assert.equal((await send(LOCAL_SEAT, 'GET', '/sdk/mini-engine.js')).status, 403, 'a seat of this computer is not a phone seat');
    assert.equal((await send(PHONE, 'GET', '/sdk/mini-engine.js', { host: 'evil.example' })).status, 421, 'DNS rebinding stays out');
  });

  test('the join port answers only the join page, with the title and nothing else', async () => {
    assert.equal((await send(JOIN, 'GET', '/join')).status, 200);
    assert.deepEqual((await send(JOIN, 'GET', '/__me/join/info')).json, { title: 'Feest', open: true });
    assert.deepEqual((await send(JOIN, 'POST', '/__me/join', { body: { name: 'Pim' } })).json, { label: 'Pim', remote: true });
    for (const remote of ['192.168.1.20', '127.0.0.1']) {
      for (const [method, path] of [['GET', '/__me/state'], ['GET', '/__me/events'], ['POST', '/__me/room'], ['POST', '/api/v1/rooms'], ['GET', '/room/ABCDEF/player']]) {
        const host = remote === '127.0.0.1' ? '127.0.0.1' : '192.168.1.5';
        assert.equal((await send(JOIN, method, path, { remote, host, body: method === 'POST' ? {} : undefined })).status, 403, `${method} ${path} from ${remote}`);
      }
    }
  });

  test('this computer keeps the overview', async () => {
    const state = await send(LAUNCHER, 'GET', '/__me/state', { remote: '127.0.0.1', host: '127.0.0.1' });
    assert.equal(state.status, 200);
    assert.equal((await send(LAUNCHER, 'POST', '/__me/room', { remote: '127.0.0.1', host: '127.0.0.1' })).status, 200);
    assert.deepEqual(calls, ['room']);
  });
});
