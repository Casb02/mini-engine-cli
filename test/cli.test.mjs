import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { startFakeServer } from './helpers/fake-server.mjs';
import { closedPort, runMe, tempHome } from './helpers/run.mjs';

let fake;
let home;
let cleanup;
let key;

beforeEach(async () => {
  fake = await startFakeServer();
  fake.addAccount('sander');
  key = fake.issueToken('sander', { label: 'laptop' }).token;
  ({ home, cleanup } = await tempHome());
});

afterEach(async () => {
  await fake.close();
  await cleanup();
});

const configFile = () => join(home, '.config', 'miniengine', 'config.json');
const me = (args, options = {}) => runMe(args, { home, ...options, env: { MINIENGINE_SERVER: fake.url, ...options.env } });
const authed = (args, options = {}) => me(args, { ...options, env: { MINIENGINE_TOKEN: key, ...options.env } });
const admin = (args, options = {}) => me(args, { ...options, env: { MINIENGINE_ADMIN_TOKEN: fake.state.adminToken, ...options.env } });

async function newGame(slug = 'kwis') {
  const result = await authed(['game', 'new', slug]);
  assert.equal(result.code, 0, result.stderr);
  return join(home, slug);
}

async function bump(dir, version) {
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = version;
  await writeFile(path, JSON.stringify(manifest));
}

async function declare(dir, fields) {
  const path = join(dir, 'manifest.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), ...fields }));
}

const ACHIEVEMENTS = [
  { id: 'eerste-buzz', title: 'Eerste buzz', description: 'Druk als eerste op de knop.' },
  { id: 'foutloos', title: 'Foutloos', description: 'Speel een hele ronde zonder fout antwoord.' },
];
const SET_KINDS = [
  {
    id: 'bord',
    title: 'Eigen bord',
    description: 'Vijf categorieën met elk vijf vragen.',
    schema: { type: 'object', additionalProperties: false, properties: { titel: { type: 'string', maxLength: 60 } }, required: ['titel'] },
  },
];

async function uploaded(versions, slug = 'kwis') {
  const dir = await newGame(slug);
  for (const version of versions) {
    await bump(dir, version);
    const result = await authed(['game', 'upload', slug]);
    assert.equal(result.code, 0, result.stderr);
  }
  return dir;
}

describe('help and usage', () => {
  test('top-level help lists the commands for game makers and leaves admin out', async () => {
    const result = await runMe(['--help'], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Begin hier\n {2}init \[map\] +.*\n {2}setup +.*\n {2}doctor \[map\]/);
    for (const text of ['auth status', 'game upload [map]', 'game prune <id>', 'skill install']) {
      assert.match(result.stdout, new RegExp(text.replace(/[[\]]/g, '\\$&')));
    }
    assert.doesNotMatch(result.stdout, /admin|Beheer|MINIENGINE_ADMIN_TOKEN/);
    assert.deepEqual(await runMe([], { home }).then(r => r.stdout), result.stdout);
    const admin = await runMe(['admin', '--help'], { home });
    assert.equal(admin.code, 0);
    for (const text of ['admin login', 'admin token create', 'admin game block <id>', 'admin account verify', 'admin account promote <gebruikersnaam>', 'admin account demote <gebruikersnaam>', 'admin account limit <gebruikersnaam> <aantal>', 'admin accounts \\[zoekterm\\]']) {
      assert.match(admin.stdout, new RegExp(text));
    }
    assert.match((await runMe(['admin', 'token', 'create', '--help'], { home })).stdout, /--expires DAGEN/);
  });

  test('group and command help', async () => {
    const group = await runMe(['game'], { home });
    assert.equal(group.code, 0);
    assert.match(group.stdout, /Gebruik: me game <commando>/);
    const command = await runMe(['game', 'upload', '--help'], { home });
    assert.match(command.stdout, /Gebruik: me game upload \[map\] \[--activate\] \[--private\] \[--dry-run\]/);
    assert.match(command.stdout, /\.meignore/);
    const viaHelp = await runMe(['help', 'admin', 'token', 'create'], { home });
    assert.match(viaHelp.stdout, /--expires DAGEN/);
  });

  test('--version prints the package version', async () => {
    assert.equal((await runMe(['--version'], { home })).stdout, `${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}\n`);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const vendored = JSON.parse(await readFile(new URL('../vendor/VENDOR.json', import.meta.url), 'utf8'));
    assert.deepEqual((await runMe(['--version', '--json'], { home })).json(), { version: pkg.version, sdk: vendored.sdk.version });
  });

  // Each CLI release names the SDK its skills and templates must come from: CLI 0.9 tells you to
  // test with --private, so it may not ship the older advice of a public test copy.
  test('the vendored SDK is at least the version this CLI release needs', async () => {
    const parts = version => version.split(/[.-]/).slice(0, 3).map(Number);
    const older = (a, b) => {
      const first = a.findIndex((part, i) => part !== b[i]);
      return first !== -1 && a[first] < b[first];
    };
    const cli = parts(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
    const sdk = parts(JSON.parse(await readFile(new URL('../vendor/VENDOR.json', import.meta.url), 'utf8')).sdk.version);
    for (const [release, needs] of [[[0, 9, 0], [0, 7, 2]]]) {
      if (older(cli, release)) continue;
      assert.ok(!older(sdk, needs), `CLI ${cli.join('.')} vendors SDK ${sdk.join('.')}; it needs ${needs.join('.')} or newer. Run npm run sync-vendor -- --sdk ../mini-engine-sdk.`);
    }
  });

  test('unknown commands and options exit 2 with a hint', async () => {
    const unknown = await runMe(['game', 'frob'], { home });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Onbekend commando: me game frob\nZie: me game --help/);
    const option = await runMe(['game', 'list', '--bogus'], { home });
    assert.equal(option.code, 2);
    assert.match(option.stderr, /Onbekende optie: --bogus/);
    const missing = await runMe(['game', 'activate', 'kwis'], { home });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Er ontbreekt een argument/);
  });
});

describe('errors', () => {
  test('network errors name the server', async () => {
    const port = await closedPort();
    const result = await runMe(['game', 'list'], { home, env: { MINIENGINE_SERVER: `http://127.0.0.1:${port}`, MINIENGINE_TOKEN: key } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Kan http://127\\.0\\.0\\.1:${port} niet bereiken \\(verbinding geweigerd\\)`));
  });

  test('--json errors have the server envelope on stdout', async () => {
    const result = await authed(['game', 'versions', 'nope', '--json']);
    assert.equal(result.code, 1);
    assert.deepEqual(result.json(), { error: { code: 'game_not_found', message: 'Je hebt geen game met dit id.', status: 404 } });
    assert.equal(result.stderr, '');
  });

  test('without a dev key commands explain how to log in', async () => {
    const result = await me(['game', 'list']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Niet ingelogd op http:\/\/127\.0\.0\.1:\d+\.\nLog in met: me auth/);
  });
});

describe('auth', () => {
  test('reads the key from stdin, verifies it and saves it 0600 without printing it', async () => {
    const result = await me(['auth'], { input: `${key}\n` });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Ingelogd als Sander \(@sander\)/);
    assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
    assert.match(result.stdout, new RegExp(`med_…${key.slice(-4)}`));
    assert.equal((await stat(configFile())).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, '.config', 'miniengine'))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(configFile(), 'utf8')), { server: fake.url, token: key });
    assert.equal(fake.state.requests.at(-1).authorization, `Bearer ${key}`);
  });

  test('--server and --token save the server too and respect XDG_CONFIG_HOME', async () => {
    const xdg = join(home, 'xdg');
    const result = await runMe(['auth', '--server', `${fake.url}/`, '--token', key, '--json'], { home, env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(result.code, 0, result.stdout);
    const data = result.json();
    assert.equal(data.account.username, 'sander');
    assert.equal(data.token.masked, `med_…${key.slice(-4)}`);
    assert.equal(JSON.parse(await readFile(join(xdg, 'miniengine', 'config.json'), 'utf8')).server, fake.url);
  });

  test('rejects malformed and unknown keys without saving', async () => {
    const malformed = await me(['auth', '--token', 'hallo']);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /geen geldige dev key/);
    const unknown = await me(['auth', '--token', `med_${'0'.repeat(64)}`]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /kent deze dev key niet/);
    await assert.rejects(stat(configFile()));
  });

  test('status shows the masked key; logout forgets it', async () => {
    await me(['auth', '--token', key]);
    const status = await me(['auth', 'status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Account {4}Sander \(@sander\)/);
    assert.match(status.stdout, new RegExp(`med_…${key.slice(-4)} · label laptop`));
    assert.ok(!status.stdout.includes(key));
    const json = (await me(['auth', 'status', '--json'])).json();
    assert.equal(json.token.masked, `med_…${key.slice(-4)}`);
    assert.ok(!JSON.stringify(json).includes(key));
    const logout = await me(['auth', 'logout']);
    assert.match(logout.stdout, /Dev key verwijderd/);
    assert.deepEqual(JSON.parse(await readFile(configFile(), 'utf8')), { server: fake.url });
    const after = await me(['auth', 'status']);
    assert.equal(after.code, 1);
  });

  test('a revoked key fails with the server message and a hint', async () => {
    fake.state.tokens[0].revoked_at = 1;
    const result = await authed(['auth', 'status']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Fout: Ongeldige of verlopen sessie\.\nJe dev key is ongeldig, verlopen of ingetrokken/);
  });
});

describe('game', () => {
  test('new scaffolds an uploadable host game in ./<slug>', async () => {
    const result = await authed(['game', 'new', 'ja-of-nee', '--json']);
    assert.equal(result.code, 0, result.stdout);
    const data = result.json();
    assert.equal(data.directory, join(home, 'ja-of-nee'));
    assert.ok(data.files.includes('.meignore') && data.files.includes('assets/app.js'));
    const manifest = JSON.parse(await readFile(join(home, 'ja-of-nee', 'manifest.json'), 'utf8'));
    assert.equal(manifest.runtime, 'host');
    assert.deepEqual(manifest.host_modes, ['playing', 'tv']);
    assert.equal(manifest.default_host_mode, 'playing');
    const again = await authed(['game', 'new', 'ja-of-nee']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /Map bestaat al/);
    const dir = await authed(['game', 'new', 'quiz', '--dir', 'games/eigen']);
    assert.match(dir.stdout, /cd games\/eigen/);
    assert.ok((await readdir(join(home, 'games', 'eigen'))).includes('manifest.json'));
  });

  test('upload sends the packed files; first release becomes active', async () => {
    const dir = await newGame();
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), '');
    const result = await authed(['game', 'upload', 'kwis']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Geüpload: kwis 0\.1\.0 naar/);
    assert.match(result.stdout, /Actief {5}ja/);
    assert.match(result.stdout, /Spelen: .*\/home\/new\/kwis/);
    const request = fake.state.requests.find(r => r.method === 'POST');
    assert.equal(request.path, '/api/v1/dev/games/kwis/versions');
    assert.equal(request.body.activate, undefined);
    assert.deepEqual(Object.keys(request.body.files).sort(), ['README.md', 'assets/app.js', 'assets/icon.svg', 'assets/logic.js', 'assets/room.js', 'assets/style.css', 'assets/texts.js', 'display.html', 'host.html', 'manifest.json', 'player.html']);
    assert.equal(Buffer.from(request.body.files['manifest.json'], 'base64').toString(), await readFile(join(dir, 'manifest.json'), 'utf8'));
  });

  test('later uploads stay inactive unless --activate', async () => {
    const dir = await uploaded(['0.1.0']);
    await bump(dir, '0.2.0');
    const second = await authed(['game', 'upload', 'kwis']);
    assert.match(second.stdout, /Actief {5}nee \(actief is 0\.1\.0\)/);
    assert.match(second.stdout, /Activeren: me game activate kwis 0\.2\.0/);
    await bump(dir, '0.3.0');
    const third = await authed(['game', 'upload', 'kwis', '--activate', '--json']);
    const data = third.json();
    assert.equal(data.release.active, true);
    assert.equal(data.game.active_version, '0.3.0');
    assert.match(data.release.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(fake.state.requests.at(-1).body.activate, true);
  });

  test('upload errors: version_exists, quota_games, game_id_taken and local checks', async () => {
    await uploaded(['0.1.0']);
    const exists = await authed(['game', 'upload', 'kwis']);
    assert.equal(exists.code, 1);
    assert.match(exists.stderr, /Fout: Deze versie bestaat al/);

    await fake.close();
    fake = await startFakeServer({ quotaGames: 1 });
    fake.addAccount('sander');
    key = fake.issueToken('sander').token;
    await authed(['game', 'upload', 'kwis']);
    await newGame('tweede');
    const quota = await authed(['game', 'upload', 'tweede', '--json']);
    assert.equal(quota.json().error.code, 'quota_games');

    await newGame('common-dice');
    const taken = await authed(['game', 'upload', 'common-dice', '--json']);
    assert.equal(taken.json().error.code, 'game_id_taken');

    const empty = join(home, 'leeg');
    await mkdir(empty);
    const local = await authed(['game', 'upload', 'leeg']);
    assert.equal(local.code, 1);
    assert.match(local.stderr, /Geen manifest.json gevonden/);
    assert.equal(fake.state.requests.filter(r => r.method === 'POST').length, 3);
  });

  test('upload --dry-run lists files without contacting the server', async () => {
    await newGame();
    const before = fake.state.requests.length;
    const result = await me(['game', 'upload', 'kwis', '--dry-run', '--json']);
    assert.equal(result.code, 0, result.stdout);
    const data = result.json();
    assert.equal(data.dry_run, true);
    assert.equal(data.version, '0.1.0');
    assert.ok(!data.files.some(file => file.path === 'jsconfig.json' || file.path.startsWith('types/')));
    assert.equal(fake.state.requests.length, before);
  });

  test('upload --dry-run lists declared achievements and set kinds', async () => {
    const dir = await newGame();
    await declare(dir, { achievements: ACHIEVEMENTS, set_kinds: SET_KINDS });
    const before = fake.state.requests.length;
    const text = await me(['game', 'upload', 'kwis', '--dry-run']);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /\n\nACHIEVEMENT\s+TITEL\neerste-buzz\s+Eerste buzz\nfoutloos\s+Foutloos\n\nSOORT SET\s+TITEL\nbord\s+Eigen bord\n\nNiets geüpload/);
    const data = (await me(['game', 'upload', 'kwis', '--dry-run', '--json'])).json();
    assert.deepEqual(data.achievements, ACHIEVEMENTS);
    assert.deepEqual(data.set_kinds, SET_KINDS.map(({ id, title, description }) => ({ id, title, description })));
    assert.equal(fake.state.requests.length, before);
    await newGame('zonder');
    const none = await me(['game', 'upload', 'zonder', '--dry-run']);
    assert.equal(none.code, 0, none.stderr);
    assert.doesNotMatch(none.stdout, /ACHIEVEMENT|SOORT SET/);
    const empty = (await me(['game', 'upload', 'zonder', '--dry-run', '--json'])).json();
    assert.deepEqual([empty.achievements, empty.set_kinds], [[], []]);
  });

  test('upload summary lists achievements and set kinds and links to /home', async () => {
    const dir = await newGame();
    await declare(dir, { achievements: ACHIEVEMENTS, set_kinds: SET_KINDS });
    const result = await authed(['game', 'upload', 'kwis']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Actief {5}ja\n\nACHIEVEMENT\s+TITEL\neerste-buzz\s+Eerste buzz\nfoutloos\s+Foutloos\n\nSOORT SET\s+TITEL\nbord\s+Eigen bord\n\nDit is de eerste versie van kwis, dus die staat meteen live: iedereen op http:\/\/127\.0\.0\.1:\d+ kan hem spelen\.\nVolgende versies gaan pas live met me game upload --activate\.\n\nSpelen: http:\/\/127\.0\.0\.1:\d+\/home\/new\/kwis$/m);
    const sent = JSON.parse(Buffer.from(fake.state.requests.find(r => r.method === 'POST').body.files['manifest.json'], 'base64').toString());
    assert.deepEqual(sent.set_kinds, SET_KINDS);
    await bump(dir, '0.2.0');
    const json = await authed(['game', 'upload', 'kwis', '--json']);
    const data = json.json();
    assert.deepEqual(data.achievements.map(item => item.id), ['eerste-buzz', 'foutloos']);
    assert.deepEqual(data.set_kinds.map(item => item.id), ['bord']);
    assert.deepEqual(data.warnings, []);
    assert.equal(data.first_upload, false);
    assert.equal(data.release.active, false);
    await bump(dir, '0.3.0');
    const later = await authed(['game', 'upload', 'kwis', '--activate']);
    assert.doesNotMatch(later.stdout, /eerste versie/);
    assert.match(later.stdout, /Spelen: http:\/\/127\.0\.0\.1:\d+\/home\/new\/kwis$/m);
  });

  test('upload warns before uploading achievements or set kinds to a server older than 0.5', async () => {
    fake.state.version = '0.4.4';
    const dir = await newGame();
    await declare(dir, { achievements: ACHIEVEMENTS, set_kinds: SET_KINDS });
    const result = await authed(['game', 'upload', 'kwis']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /^Let op: http:\/\/127\.0\.0\.1:\d+ draait Mini Engine 0\.4\.4, die achievements en set_kinds in manifest\.json negeert\. Die werken pas vanaf Mini Engine 0\.5\.\n$/);
    assert.match(result.stdout, /Spelen: .*\/demo\/new\/kwis/);
    const paths = fake.state.requests.map(r => `${r.method} ${r.path}`);
    assert.ok(paths.lastIndexOf('GET /api/health') < paths.indexOf('POST /api/v1/dev/games/kwis/versions'));

    await bump(dir, '0.2.0');
    await declare(dir, { set_kinds: [] });
    const json = await authed(['game', 'upload', 'kwis', '--json']);
    assert.equal(json.code, 0, json.stdout);
    assert.equal(json.stderr, '');
    assert.match(json.json().warnings[0], /die achievements in manifest\.json negeert/);

    await bump(dir, '0.3.0');
    await declare(dir, { achievements: [] });
    const plain = await authed(['game', 'upload', 'kwis']);
    assert.equal(plain.stderr, '');

    fake.state.version = '0.5.0';
    await bump(dir, '0.4.0');
    await declare(dir, { achievements: ACHIEVEMENTS });
    const current = await authed(['game', 'upload', 'kwis']);
    assert.equal(current.stderr, '');
  });

  test('upload warns before uploading image fields in sets to a server older than 0.8', async () => {
    const pictures = [{ ...SET_KINDS[0], schema: { type: 'object', additionalProperties: false, properties: { plaatje: { type: 'string', format: 'image' } } } }];
    fake.state.version = '0.7.1';
    const dir = await newGame();
    await declare(dir, { set_kinds: pictures });
    const old = await authed(['game', 'upload', 'kwis']);
    assert.equal(old.code, 0, old.stderr);
    assert.match(old.stderr, /^Let op: http:\/\/127\.0\.0\.1:\d+ draait Mini Engine 0\.7\.1\. Afbeeldingen in sets \(format "image"\) werken pas vanaf Mini Engine 0\.8; deze server weigert dit schema\.\n$/);

    await bump(dir, '0.2.0');
    await declare(dir, { set_kinds: SET_KINDS });
    assert.equal((await authed(['game', 'upload', 'kwis'])).stderr, '', 'no images, no warning');

    fake.state.version = '0.8.0';
    await bump(dir, '0.3.0');
    await declare(dir, { set_kinds: pictures });
    assert.equal((await authed(['game', 'upload', 'kwis'])).stderr, '');
  });

  test('upload refuses malformed achievements and set kinds before contacting the server', async () => {
    const dir = await newGame();
    const many = count => Array.from({ length: count }, (_, i) => ({ ...SET_KINDS[0], id: `soort-${i}` }));
    const cases = [
      [{ achievements: {} }, /achievements moet een lijst zijn/],
      [{ achievements: [ACHIEVEMENTS[0], { ...ACHIEVEMENTS[1], id: 'eerste-buzz' }] }, /het id eerste-buzz komt twee keer voor in achievements/],
      [{ achievements: [{ ...ACHIEVEMENTS[0], id: '-buzz' }] }, /achievements\[0\]\.id moet 1 tot 48 kleine letters/],
      [{ achievements: [{ id: 'buzz', title: 'Buzz' }] }, /achievements\[0\] moet een object zijn met id, title en description/],
      [{ achievements: [{ ...ACHIEVEMENTS[0], title: 'x'.repeat(61) }] }, /achievement eerste-buzz: gebruik een titel van 1 tot 60 tekens/],
      [{ achievements: Array.from({ length: 51 }, (_, i) => ({ ...ACHIEVEMENTS[0], id: `a${i}` })) }, /maximaal 50 achievements \(nu 51\)/],
      [{ set_kinds: many(5) }, /maximaal 4 soorten sets \(nu 5\)/],
      [{ set_kinds: [{ ...SET_KINDS[0], schema: [] }] }, /set-soort bord: schema moet een object zijn/],
      [{ set_kinds: [{ ...SET_KINDS[0], description: '  ' }] }, /set-soort bord: gebruik een titel/],
    ];
    for (const [fields, message] of cases) {
      await declare(dir, { achievements: [], set_kinds: [], ...fields });
      const result = await authed(['game', 'upload', 'kwis']);
      assert.equal(result.code, 1, JSON.stringify(fields).slice(0, 80));
      assert.match(result.stderr, message);
    }
    assert.equal(fake.state.requests.length, 0);
    await declare(dir, { set_kinds: many(4), achievements: Array.from({ length: 50 }, (_, i) => ({ ...ACHIEVEMENTS[0], id: `a${i}` })) });
    const fits = await authed(['game', 'upload', 'kwis', '--dry-run']);
    assert.equal(fits.code, 0, fits.stderr);
  });

  test('list and versions', async () => {
    const empty = await authed(['game', 'list']);
    assert.match(empty.stdout, /Je hebt nog geen games/);
    await uploaded(['0.1.0', '0.2.0']);
    const list = await authed(['game', 'list']);
    assert.match(list.stdout, /ID\s+TITEL\s+ACTIEF\s+STATUS\s+PRIVÉ\s+VERSIES\nkwis\s+Kwis\s+0\.1\.0\s+aan\s+-\s+2/, 'a server before 0.9 has no private field');
    const json = (await authed(['game', 'list', '--json'])).json();
    assert.equal(json.games[0].id, 'kwis');
    assert.equal(json.server, fake.url);
    const versions = await authed(['game', 'versions', 'kwis']);
    assert.match(versions.stdout, /0\.2\.0\s+\d+\s/);
    assert.match(versions.stdout, /0\.1\.0\s+actief/);
    assert.ok(versions.stdout.indexOf('0.2.0') < versions.stdout.indexOf('0.1.0'));
  });

  test('activate, disable, enable and a blocked game', async () => {
    await uploaded(['0.1.0', '0.2.0']);
    const activate = await authed(['game', 'activate', 'kwis', '0.2.0']);
    assert.match(activate.stdout, /Actieve versie van kwis is nu 0\.2\.0/);
    const missing = await authed(['game', 'activate', 'kwis', '9.9.9']);
    assert.equal(missing.code, 1);
    const disable = await authed(['game', 'disable', 'kwis', '--json']);
    assert.equal(disable.json().enabled, false);
    const enable = await authed(['game', 'enable', 'kwis']);
    assert.match(enable.stdout, /kwis staat aan/);
    fake.game('kwis').blocked = true;
    fake.game('kwis').enabled = false;
    const blocked = await authed(['game', 'enable', 'kwis']);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /De beheerder heeft deze game geblokkeerd/);
  });

  test('delete-version refuses releases in use', async () => {
    await uploaded(['0.1.0', '0.2.0', '0.3.0']);
    const ok = await authed(['game', 'delete-version', 'kwis', '0.2.0']);
    assert.equal(ok.code, 0, ok.stderr);
    fake.setInUse('kwis', '0.3.0');
    const inUse = await authed(['game', 'delete-version', 'kwis', '0.3.0', '--json']);
    assert.equal(inUse.code, 1);
    assert.equal(inUse.json().error.code, 'release_in_use');
  });

  test('prune keeps active + newest N, skips in-use and needs confirmation', async () => {
    await uploaded(['1', '2', '3', '4', '5', '6']);
    fake.setInUse('kwis', '2');
    const unconfirmed = await authed(['game', 'prune', 'kwis', '--keep', '2']);
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.stderr, /Verwijderen: 4, 3\n.*Bevestiging nodig/s);
    assert.equal(fake.game('kwis').releases.length, 6);
    const dry = (await authed(['game', 'prune', 'kwis', '--keep', '2', '--dry-run', '--json'])).json();
    assert.deepEqual(dry, { id: 'kwis', keep: ['6', '5', '1'], deleted: ['4', '3'], skipped: [{ version: '2', reason: 'in_use' }], failed: [], dry_run: true });
    const result = await authed(['game', 'prune', 'kwis', '--keep', '2', '--yes', '--json']);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.json().deleted, ['4', '3']);
    assert.deepEqual(fake.game('kwis').releases.map(r => r.version), ['1', '2', '5', '6']);
    const nothing = await authed(['game', 'prune', 'kwis', '--keep', '2']);
    assert.match(nothing.stdout, /Niets op te ruimen/);
    const bad = await authed(['game', 'prune', 'kwis', '--keep', '-1']);
    assert.equal(bad.code, 2);
  });

  test('delete asks for --yes and reports game_in_use', async () => {
    await uploaded(['0.1.0']);
    const unconfirmed = await authed(['game', 'delete', 'kwis']);
    assert.equal(unconfirmed.code, 2);
    assert.ok(fake.game('kwis'));
    fake.setInUse('kwis', '0.1.0');
    const inUse = await authed(['game', 'delete', 'kwis', '-y']);
    assert.equal(inUse.code, 1);
    assert.match(inUse.stderr, /lopende room/);
    fake.setInUse('kwis', '0.1.0', false);
    const deleted = await authed(['game', 'delete', 'kwis', '--yes', '--json']);
    assert.deepEqual(deleted.json(), { id: 'kwis', deleted: true });
    assert.equal(fake.game('kwis'), undefined);
  });
});

describe('private games', () => {
  // Cas owns the games; Dani, Sander, Kevin and Pim are accounts without a dev key.
  beforeEach(() => {
    fake.state.version = '0.9.0';
    fake.addAccount('cas');
    key = fake.issueToken('cas').token;
    for (const name of ['dani', 'kevin', 'pim']) fake.addAccount(name);
  });

  const unsupported = version => new RegExp(`^Fout: http://127\\.0\\.0\\.1:\\d+ draait Mini Engine ${version.replaceAll('.', '\\.')}\\. Privégames en uitnodigingen werken vanaf Mini Engine 0\\.9\\.`);
  const devCalls = () => fake.state.requests.filter(r => r.path.startsWith('/api/v1/dev/')).length;

  test('game --help names the new commands; upload --help explains --private', async () => {
    const group = await runMe(['game', '--help'], { home });
    assert.equal(group.code, 0);
    for (const line of [
      /game private <id> +Game privé maken: alleen jij en wie je uitnodigt, kunnen hem starten/,
      /game public <id> +Game weer openbaar maken voor iedereen op de server/,
      /game invite <id> <gebruikersnaam>\.\.\. +Accounts uitnodigen die je privégame mogen starten/,
      /game uninvite <id> <gebruikersnaam> +Uitnodiging intrekken/,
      /game invites <id> +Wie je voor een game hebt uitgenodigd/,
    ]) assert.match(group.stdout, line);
    const upload = await runMe(['game', 'upload', '--help'], { home });
    assert.match(upload.stdout, /--private +De game privé maken \(vanaf Mini Engine 0\.9\): alleen jij en wie je uitnodigt, kunnen hem starten/);
    assert.match(upload.stdout, /Met --private is de game privé voordat deze versie live kan gaan; ook een nieuwe game is dan nooit voor iedereen zichtbaar\./);
    assert.match(upload.stdout, /Zet private niet in manifest\.json: daarmee wordt een game niet privé, dus de CLI stopt dan\./);
    assert.match(upload.stdout, /Voorbeelden\n(?: {2}.*\n)* {2}me game upload --private\n/);
    const invite = await runMe(['game', 'invite', '--help'], { home });
    assert.match(invite.stdout, /Uitgenodigde accounts zien je privégame op de site als ze zijn ingelogd en kunnen er een room mee maken, ook zonder dev key\. Hoogstens 50 per game\. Een @ voor de naam mag\./);
    assert.match((await runMe(['--help'], { home })).stdout, /game invites <id>/);
  });

  test('upload --private makes even a new game private before it can go live', async () => {
    const dir = await newGame();
    const result = await authed(['game', 'upload', 'kwis', '--private']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const post = fake.state.requests.find(r => r.method === 'POST');
    assert.equal(post.body.private, true);
    const paths = fake.state.requests.map(r => `${r.method} ${r.path}`);
    assert.ok(paths.indexOf('GET /api/health') < paths.indexOf('POST /api/v1/dev/games/kwis/versions'), 'the version check comes first');
    assert.equal(fake.game('kwis').private, true);
    assert.match(
      result.stdout,
      /\n {2}Actief {5}ja\n {2}Privé {6}ja\n\nDit is de eerste versie van kwis\. Die is meteen actief, maar privé: alleen jij ziet hem op de site als je bent ingelogd\. Meedoen kan iedereen met de code\.\nVrienden uitnodigen: me game invite kwis <gebruikersnaam>\nVolgende versies gaan pas live met me game upload --activate\.\n\nSpelen: http:\/\/127\.0\.0\.1:\d+\/home\/new\/kwis\n$/,
    );

    await bump(dir, '0.2.0');
    const later = await authed(['game', 'upload', 'kwis', '--activate', '--json']);
    assert.equal(later.code, 0, later.stdout);
    assert.equal(fake.state.requests.at(-1).body.private, undefined, 'without --private nothing about privé is sent');
    assert.equal(later.json().game.private, true, 'an upload never makes a private game public');
    await bump(dir, '0.3.0');
    const text = await authed(['game', 'upload', 'kwis']);
    assert.match(text.stdout, /\n {2}Actief {5}nee \(actief is 0\.2\.0\)\n {2}Privé {6}ja\n/);
  });

  test('a first public upload suggests making it private', async () => {
    const dir = await newGame();
    const result = await authed(['game', 'upload', 'kwis']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /\n {2}Actief {5}ja\n\nDit is de eerste versie van kwis, dus die staat meteen live: iedereen op http:\/\/127\.0\.0\.1:\d+ kan hem spelen\.\nAlleen voor jou en je vrienden\? Maak hem privé: me game private kwis\nVolgende versies gaan pas live met me game upload --activate\.\n\nSpelen: /,
    );
    assert.equal(fake.game('kwis').private, false);
    await bump(dir, '0.2.0');
    assert.doesNotMatch((await authed(['game', 'upload', 'kwis', '--activate'])).stdout, /Privé|privé/);

    fake.state.version = '0.8.1';
    await newGame('quiz');
    const old = await authed(['game', 'upload', 'quiz']);
    assert.equal(old.code, 0, old.stderr);
    assert.doesNotMatch(old.stdout, /me game private/, 'no hint a server before 0.9 cannot follow');
  });

  test('upload --dry-run --private says so and sends nothing', async () => {
    await newGame();
    const before = fake.state.requests.length;
    const result = await me(['game', 'upload', 'kwis', '--dry-run', '--private']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\n\nMet --private wordt kwis privé\.\nNiets geüpload \(--dry-run\)\.\n$/);
    assert.equal((await me(['game', 'upload', 'kwis', '--dry-run', '--private', '--json'])).json().private, true);
    assert.doesNotMatch((await me(['game', 'upload', 'kwis', '--dry-run'])).stdout, /--private/);
    assert.equal(fake.state.requests.length, before);
  });

  test('a server before 0.9 stops every private command before anything is sent', async () => {
    fake.state.version = '0.8.1';
    await newGame();
    const upload = await authed(['game', 'upload', 'kwis', '--private']);
    assert.equal(upload.code, 1);
    assert.match(upload.stderr, unsupported('0.8.1'));
    assert.match(upload.stderr, /Mini Engine 0\.9\. Er is niets geüpload\.\n$/);
    assert.equal(fake.state.games.size, 0);
    assert.equal(devCalls(), 0);
    const json = await authed(['game', 'upload', 'kwis', '--private', '--json']);
    assert.equal(json.code, 1);
    assert.equal(json.json().error.code, 'unsupported');

    await authed(['game', 'upload', 'kwis']);
    for (const args of [['private', 'kwis'], ['public', 'kwis'], ['invite', 'kwis', 'dani'], ['uninvite', 'kwis', 'dani'], ['invites', 'kwis']]) {
      const before = devCalls();
      const result = await authed(['game', ...args]);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, unsupported('0.8.1'));
      assert.match(result.stderr, /Mini Engine 0\.9\.\n$/);
      assert.equal(devCalls(), before, args.join(' '));
      assert.equal((await authed(['game', ...args, '--json'])).json().error.code, 'unsupported');
    }
    assert.equal(fake.game('kwis').private, false);
  });

  test('without a known server version the request goes ahead; an old server refuses it with a hint', async () => {
    fake.state.version = null;
    await newGame();
    const upload = await authed(['game', 'upload', 'kwis', '--private']);
    assert.equal(upload.code, 1);
    assert.match(upload.stderr, /^Fout: Stuur geldige JSON met de verwachte velden en Content-Type application\/json\.\nDraait http:\/\/127\.0\.0\.1:\d+ wel Mini Engine 0\.9 of nieuwer\? Privégames en uitnodigingen werken pas vanaf die versie\. Er is niets geüpload\.\n$/);
    assert.equal(fake.state.games.size, 0);
    await authed(['game', 'upload', 'kwis']);
    const put = await authed(['game', 'private', 'kwis']);
    assert.equal(put.code, 1);
    assert.match(put.stderr, /\nDraait http:\/\/127\.0\.0\.1:\d+ wel Mini Engine 0\.9 of nieuwer\? Privégames en uitnodigingen werken pas vanaf die versie\.\n$/);
    const invite = await authed(['game', 'invite', 'kwis', 'dani', '--json']);
    assert.equal(invite.code, 1);
    assert.equal(invite.json().error.code, 'not_found');
    assert.match(invite.json().error.hint, /wel Mini Engine 0\.9 of nieuwer\?/);
  });

  test('private in manifest.json stops the upload before anything is sent', async () => {
    const dir = await newGame();
    for (const value of [true, false]) {
      await declare(dir, { private: value });
      for (const args of [['game', 'upload', 'kwis'], ['game', 'upload', 'kwis', '--private'], ['game', 'upload', 'kwis', '--dry-run']]) {
        const before = fake.state.requests.length;
        const result = await authed(args);
        assert.equal(result.code, 1, args.join(' '));
        assert.equal(
          result.stderr,
          'Fout: manifest.json: private hoort niet in het manifest; daarmee wordt een game niet privé.\nHaal private weg en upload met: me game upload --private (of later: me game private <id>)\n',
        );
        assert.equal(fake.state.requests.length, before, `${args.join(' ')} sends nothing`);
      }
    }
    assert.equal(fake.state.games.size, 0);
    const doctor = await authed(['doctor', 'kwis']);
    assert.match(doctor.stdout + doctor.stderr, /private hoort niet in het manifest/);
  });

  test('private and public say when nothing changed, and when a game leaves the featured games', async () => {
    await uploaded(['0.1.0']);
    fake.feature(['kwis']);
    const featured = await authed(['game', 'private', 'kwis']);
    assert.equal(featured.code, 0, featured.stderr);
    assert.equal(
      featured.stdout,
      'kwis is nu privé. Alleen jij kunt er een room mee maken; meedoen kan iedereen met de code.\nHij staat niet meer bij de uitgelichte games: een privégame kan niet uitgelicht worden.\nIemand uitnodigen: me game invite kwis <gebruikersnaam>\n',
    );
    assert.deepEqual(fake.state.featured, []);
    const puts = () => fake.state.requests.filter(r => r.method === 'PUT').length;
    const before = puts();
    const again = await authed(['game', 'private', 'kwis']);
    assert.equal(again.stdout, 'kwis was al privé. Alleen jij kunt er een room mee maken; meedoen kan iedereen met de code.\nIemand uitnodigen: me game invite kwis <gebruikersnaam>\n');
    assert.equal(puts(), before, 'nothing to change, nothing sent');
    assert.equal((await authed(['game', 'private', 'kwis', '--json'])).json().private, true);
    await authed(['game', 'public', 'kwis']);
    const open = await authed(['game', 'public', 'kwis']);
    assert.equal(open.stdout, `kwis was al openbaar: iedereen op ${fake.url} kan hem zien en er een room mee maken.\n`);
    // A game that was not featured gets no such line.
    assert.doesNotMatch((await authed(['game', 'private', 'kwis'])).stdout, /uitgelicht/);
  });

  test('private and public, with 0, 1 and more invites', async () => {
    await uploaded(['0.1.0']);
    const zero = await authed(['game', 'private', 'kwis']);
    assert.equal(zero.code, 0, zero.stderr);
    assert.equal(zero.stdout, 'kwis is nu privé. Alleen jij kunt er een room mee maken; meedoen kan iedereen met de code.\nIemand uitnodigen: me game invite kwis <gebruikersnaam>\n');
    assert.deepEqual([fake.state.requests.at(-1).method, fake.state.requests.at(-1).path, fake.state.requests.at(-1).body], ['PUT', '/api/v1/dev/games/kwis', { private: true }]);
    const open = await authed(['game', 'public', 'kwis']);
    assert.equal(open.stdout, `kwis is nu openbaar: iedereen op ${fake.url} kan hem zien en er een room mee maken.\n`);
    assert.deepEqual(fake.state.requests.at(-1).body, { private: false });

    await authed(['game', 'invite', 'kwis', 'dani']);
    assert.equal((await authed(['game', 'private', 'kwis'])).stdout, 'kwis is nu privé. Alleen jij en 1 uitgenodigd account kunnen er een room mee maken; meedoen kan iedereen met de code.\n');
    assert.equal((await authed(['game', 'public', 'kwis'])).stdout, `kwis is nu openbaar: iedereen op ${fake.url} kan hem zien en er een room mee maken.\nJe uitnodiging blijft bewaard en telt weer als je hem privé maakt.\n`);
    await authed(['game', 'invite', 'kwis', 'sander']);
    assert.equal((await authed(['game', 'private', 'kwis'])).stdout, 'kwis is nu privé. Alleen jij en 2 uitgenodigde accounts kunnen er een room mee maken; meedoen kan iedereen met de code.\n');
    assert.equal((await authed(['game', 'public', 'kwis'])).stdout, `kwis is nu openbaar: iedereen op ${fake.url} kan hem zien en er een room mee maken.\nJe 2 uitnodigingen blijven bewaard en tellen weer als je hem privé maakt.\n`);

    const json = await authed(['game', 'private', 'kwis', '--json']);
    assert.deepEqual([json.json().id, json.json().private, json.json().invites], ['kwis', true, 2]);
    await authed(['game', 'disable', 'kwis']);
    assert.match((await authed(['game', 'private', 'kwis'])).stdout, /meedoen kan iedereen met de code\.\nkwis staat uit\. Aanzetten: me game enable kwis\n$/);
    assert.match((await authed(['game', 'public', 'kwis'])).stdout, /tellen weer als je hem privé maakt\.\nkwis staat uit\. Aanzetten: me game enable kwis\n$/);
    fake.game('kwis').blocked = true;
    assert.match((await authed(['game', 'private', 'kwis'])).stdout, /\nkwis is geblokkeerd door de beheerder van de server\.\n$/);

    const unknown = await authed(['game', 'private', 'nope']);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stderr, 'Fout: Je hebt geen game met dit id.\n');
  });

  test('invite drops the @ and doubles and says who was already invited', async () => {
    await uploaded(['0.1.0']);
    await authed(['game', 'private', 'kwis']);
    const first = await authed(['game', 'invite', 'kwis', '@dani', 'sander', 'dani']);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual([fake.state.requests.at(-1).method, fake.state.requests.at(-1).path, fake.state.requests.at(-1).body], ['POST', '/api/v1/dev/games/kwis/invites', { usernames: ['dani', 'sander'] }]);
    assert.equal(first.stdout, `Uitgenodigd voor kwis: @dani en @sander.\nWie is uitgenodigd, ziet kwis na het inloggen op ${fake.url}/home/new/kwis\n`);
    const again = await authed(['game', 'invite', 'kwis', 'Dani', ' @SANDER ']);
    assert.deepEqual(fake.state.requests.at(-1).body, { usernames: ['dani', 'sander'] });
    assert.equal(again.stdout, `@dani en @sander waren al uitgenodigd.\nWie is uitgenodigd, ziet kwis na het inloggen op ${fake.url}/home/new/kwis\n`);
    const mixed = await authed(['game', 'invite', 'kwis', 'kevin', 'pim', 'dani']);
    assert.equal(mixed.stdout, `Uitgenodigd voor kwis: @kevin en @pim.\n@dani was al uitgenodigd.\nWie is uitgenodigd, ziet kwis na het inloggen op ${fake.url}/home/new/kwis\n`);
    fake.addAccount('anouk');
    fake.addAccount('joost');
    const json = await authed(['game', 'invite', 'kwis', 'anouk', 'joost', 'Kevin', '--json']);
    assert.equal(json.code, 0, json.stdout);
    assert.deepEqual(json.json().added, ['anouk', 'joost']);
    assert.equal(json.json().private, true);
    assert.deepEqual(json.json().invites.map(invite => invite.username), ['anouk', 'dani', 'joost', 'kevin', 'pim', 'sander']);
    assert.match((await authed(['game', 'invite', 'kwis', 'anouk', 'dani', 'joost'])).stdout, /^@anouk, @dani en @joost waren al uitgenodigd\.\n/);

    await authed(['game', 'public', 'kwis']);
    fake.addAccount('femke');
    const open = await authed(['game', 'invite', 'kwis', 'femke']);
    assert.equal(open.stdout, 'Uitgenodigd voor kwis: @femke.\nkwis is openbaar, dus iedereen kan hem al starten. De uitnodiging telt zodra je hem privé maakt: me game private kwis\n');
  });

  test('invite errors: unknown accounts, your own name, the cap and wrong use', async () => {
    await uploaded(['0.1.0']);
    const unknown = await authed(['game', 'invite', 'kwis', 'dani', 'niemand']);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stderr, 'Fout: Er is geen account met de gebruikersnaam niemand.\n');
    assert.equal(fake.game('kwis').invites.length, 0, 'all or nothing');
    assert.deepEqual((await authed(['game', 'invite', 'kwis', 'niemand', '--json'])).json(), { error: { code: 'account_not_found', message: 'Er is geen account met de gebruikersnaam niemand.', status: 404 } });
    const own = await authed(['game', 'invite', 'kwis', '@cas']);
    assert.equal(own.code, 1);
    assert.equal(own.stderr, 'Fout: Dit is je eigen game; die kun je altijd starten.\n');
    const other = await authed(['game', 'invite', 'nope', 'dani']);
    assert.equal(other.stderr, 'Fout: Je hebt geen game met dit id.\n');

    const players = Array.from({ length: 50 }, (_, i) => `speler${i}`);
    players.forEach(name => fake.addAccount(name));
    const fifty = await authed(['game', 'invite', 'kwis', ...players]);
    assert.equal(fifty.code, 0, fifty.stderr);
    assert.equal(fake.game('kwis').invites.length, 50);
    const full = await authed(['game', 'invite', 'kwis', 'dani', '--json']);
    assert.equal(full.code, 1);
    assert.deepEqual(full.json().error, { code: 'quota_invites', message: 'Een game heeft hoogstens 50 uitnodigingen, en deze heeft er al 50. Trek er eerst een in.', status: 409 });
    assert.match((await authed(['game', 'invite', 'kwis', 'dani'])).stderr, /^Fout: Een game heeft hoogstens 50 uitnodigingen, en deze heeft er al 50\. Trek er eerst een in\.\n$/);

    const before = fake.state.requests.length;
    const many = await authed(['game', 'invite', 'kwis', ...players, 'dani']);
    assert.equal(many.code, 2);
    assert.match(many.stderr, /Te veel argumenten\.\nGebruik: me game invite <id> <gebruikersnaam>\.\.\./);
    const none = await authed(['game', 'invite', 'kwis']);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /Er ontbreekt een argument\./);
    const empty = await authed(['game', 'invite', 'kwis', 'dani', '@']);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /^Fout: Een gebruikersnaam is leeg\.\nGeef een gebruikersnaam, met of zonder @: dani of @dani\.\n$/);
    assert.equal(fake.state.requests.length, before, 'wrong use sends nothing');
    for (const args of [['private', 'kwis'], ['invite', 'kwis', 'dani'], ['invites', 'kwis'], ['upload', 'kwis', '--private']]) {
      const out = await me(['game', ...args]);
      assert.equal(out.code, 1, args.join(' '));
      assert.match(out.stderr, /^Fout: Niet ingelogd op http:\/\/127\.0\.0\.1:\d+\.\nLog in met: me auth\n$/, args.join(' '));
    }
  });

  test('invites lists who is invited; uninvite takes one back', async () => {
    await uploaded(['0.1.0']);
    const none = await authed(['game', 'invites', 'kwis']);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stdout, 'Nog niemand uitgenodigd voor kwis.\nUitnodigen: me game invite kwis <gebruikersnaam>\n');
    assert.deepEqual((await authed(['game', 'invites', 'kwis', '--json'])).json(), { private: false, invites: [] });

    await authed(['game', 'invite', 'kwis', 'sander', 'dani']);
    const open = await authed(['game', 'invites', 'kwis']);
    assert.match(open.stdout, /^kwis is openbaar\. Deze uitnodigingen tellen zodra je hem privé maakt:\n\nGEBRUIKERSNAAM\s+NAAM\s+UITGENODIGD\ndani\s+Dani\s+\d{4}-\d\d-\d\d \d\d:\d\d\nsander\s+Sander\s+\d{4}-\d\d-\d\d \d\d:\d\d\n$/);
    await authed(['game', 'private', 'kwis']);
    const closed = await authed(['game', 'invites', 'kwis']);
    assert.match(closed.stdout, /^kwis is privé\. Deze accounts kunnen hem starten:\n\nGEBRUIKERSNAAM\s+NAAM\s+UITGENODIGD\ndani\s/);
    assert.equal(fake.state.requests.at(-1).method, 'GET');
    assert.equal(fake.state.requests.at(-1).path, '/api/v1/dev/games/kwis/invites');
    const json = (await authed(['game', 'invites', 'kwis', '--json'])).json();
    assert.equal(json.private, true);
    assert.deepEqual(json.invites.map(invite => [invite.username, invite.display_name, typeof invite.invited_at]), [['dani', 'Dani', 'number'], ['sander', 'Sander', 'number']]);

    const gone = await authed(['game', 'uninvite', 'kwis', '@Dani']);
    assert.equal(gone.code, 0, gone.stderr);
    assert.equal(gone.stdout, '@dani is niet meer uitgenodigd voor kwis. Rooms die al lopen, spelen door.\n');
    assert.deepEqual([fake.state.requests.at(-1).method, fake.state.requests.at(-1).path], ['DELETE', '/api/v1/dev/games/kwis/invites/dani']);
    assert.deepEqual((await authed(['game', 'uninvite', 'kwis', 'sander', '--json'])).json(), { id: 'kwis', username: 'sander', uninvited: true });
    assert.match((await authed(['game', 'invites', 'kwis'])).stdout, /^Nog niemand uitgenodigd voor kwis\./);

    const again = await authed(['game', 'uninvite', 'kwis', 'dani']);
    assert.equal(again.code, 1);
    assert.equal(again.stderr, 'Fout: @dani is niet uitgenodigd voor deze game.\n');
    assert.equal((await authed(['game', 'uninvite', 'kwis', 'dani', '--json'])).json().error.code, 'invite_not_found');
    const unknown = await authed(['game', 'uninvite', 'kwis', 'niemand']);
    assert.equal(unknown.stderr, 'Fout: Er is geen account met de gebruikersnaam niemand.\n');
    assert.equal((await authed(['game', 'invites', 'nope'])).stderr, 'Fout: Je hebt geen game met dit id.\n');
    assert.equal((await authed(['game', 'uninvite', 'kwis'])).code, 2);
  });

  test('list, versions and admin games show which games are private', async () => {
    await uploaded(['0.1.0']);
    await uploaded(['0.1.0'], 'quiz');
    await authed(['game', 'private', 'kwis']);
    const list = await authed(['game', 'list']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /^ID\s+TITEL\s+ACTIEF\s+STATUS\s+PRIVÉ\s+VERSIES\nkwis\s+Kwis\s+0\.1\.0\s+aan\s+ja\s+1\nquiz\s+Quiz\s+0\.1\.0\s+aan\s+nee\s+1\n$/);
    assert.deepEqual((await authed(['game', 'list', '--json'])).json().games.map(game => [game.id, game.private, game.invites]), [['kwis', true, 0], ['quiz', false, 0]]);
    assert.match((await authed(['game', 'versions', 'kwis'])).stdout, /^Kwis \(kwis\) · aan, privé\n\n/);
    assert.match((await authed(['game', 'versions', 'quiz'])).stdout, /^Quiz \(quiz\) · aan\n\n/);
    await authed(['game', 'disable', 'kwis']);
    assert.match((await authed(['game', 'versions', 'kwis'])).stdout, /^Kwis \(kwis\) · uit, privé\n\n/);
    const games = await admin(['admin', 'games']);
    assert.equal(games.code, 0, games.stderr);
    assert.match(games.stdout, /^ID\s+EIGENAAR\s+ACTIEF\s+STATUS\s+PRIVÉ\s+VERSIES\nkwis\s+cas\s+0\.1\.0\s+uit\s+ja\s+1\nquiz\s+cas\s+0\.1\.0\s+aan\s+nee\s+1\n$/);
  });
});

describe('skill', () => {
  const vendoredSkills = async () => (await readdir(new URL('../vendor/sdk/skills/', import.meta.url), { withFileTypes: true })).filter(entry => entry.isDirectory());

  test('list shows the vendored skills', async () => {
    const result = await runMe(['skill', 'list', '--json'], { home });
    const data = result.json();
    assert.equal(data.sdk_version, JSON.parse(await readFile(new URL('../vendor/VENDOR.json', import.meta.url), 'utf8')).sdk.version);
    assert.deepEqual(data.skills.map(skill => skill.name), ['build-mini-engine-game', 'design-mini-engine-game-ui', 'mini-engine-ui']);
  });

  test('install into ~/.claude/skills, --project and --path', async () => {
    const result = await runMe(['skill', 'install'], { home });
    assert.equal(result.code, 0, result.stderr);
    const skill = join(home, '.claude', 'skills', 'build-mini-engine-game');
    assert.ok((await readFile(join(skill, 'SKILL.md'), 'utf8')).includes('name: build-mini-engine-game'));
    assert.ok((await stat(join(skill, 'scripts', 'play.mjs'))).isFile());
    const font = join('mini-engine-ui', 'kit', 'ui', 'fonts', 'dm-sans.woff2');
    assert.ok((await readFile(join(home, '.claude', 'skills', font))).equals(await readFile(new URL(`../vendor/sdk/skills/${font}`, import.meta.url))));
    const project = join(home, 'project');
    await mkdir(project);
    await runMe(['skill', 'install', 'design-mini-engine-game-ui', '--project'], { home, cwd: project });
    assert.deepEqual(await readdir(join(project, '.claude', 'skills')), ['design-mini-engine-game-ui']);
    await runMe(['skill', 'install', '--path', 'elders'], { home });
    assert.equal((await readdir(join(home, 'elders'))).length, (await vendoredSkills()).length);
    const both = await runMe(['skill', 'install', '--project', '--path', 'x'], { home });
    assert.equal(both.code, 2);
  });

  test('refuses to overwrite a different skill unless --force', async () => {
    await runMe(['skill', 'install'], { home });
    const same = await runMe(['skill', 'install', '--json'], { home });
    assert.deepEqual(same.json().skills.map(skill => skill.status), (await vendoredSkills()).map(() => 'al actueel'));
    const file = join(home, '.claude', 'skills', 'build-mini-engine-game', 'SKILL.md');
    await writeFile(file, 'eigen versie');
    const refused = await runMe(['skill', 'install'], { home });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /andere versie van build-mini-engine-game.*\nGebruik --force/s);
    assert.equal(await readFile(file, 'utf8'), 'eigen versie');
    const forced = await runMe(['skill', 'install', '--force'], { home });
    assert.equal(forced.code, 0);
    assert.notEqual(await readFile(file, 'utf8'), 'eigen versie');
    const unknown = await runMe(['skill', 'install', 'bestaat-niet'], { home });
    assert.match(unknown.stderr, /Onbekende skill: bestaat-niet/);
  });
});

describe('setup', () => {
  test('non-interactive flags', async () => {
    const result = await runMe(['setup', '--server', fake.url, '--token', key, '--no-skills', '--game', 'eerste', '--json'], { home });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const data = result.json();
    assert.equal(data.server, fake.url);
    assert.equal(data.server_version, fake.state.version);
    assert.equal(data.account.username, 'sander');
    assert.equal(data.skills, null);
    assert.equal(data.game.id, 'eerste');
    assert.deepEqual(data.next, ['cd eerste', 'me dev', 'me game upload', 'me game list']);
    assert.deepEqual(JSON.parse(await readFile(configFile(), 'utf8')), { server: fake.url, token: key });
    await assert.rejects(stat(join(home, '.claude')));
  });

  test('answers from stdin, every step skippable', async () => {
    const input = [fake.url, key, 'j', 'ja', 'mijn-quiz', ''].join('\n');
    const result = await runMe(['setup'], { home, input });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Ingelogd als Sander/);
    assert.match(result.stdout, /Klaar\. Volgende stappen:\n {2}cd mijn-quiz\n {2}me dev\n {2}me game upload\n {2}me game list/);
    assert.ok((await stat(join(home, '.claude', 'skills', 'build-mini-engine-game'))).isDirectory());
    assert.ok((await stat(join(home, 'mijn-quiz', 'manifest.json'))).isFile());

    const { home: other, cleanup: done } = await tempHome();
    const skipped = await runMe(['setup'], { home: other, input: `${fake.url}\n\nn\nn\n` });
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.match(skipped.stdout, /Volgende stappen:\n {2}me auth\n {2}me init mijn-game/);
    await done();
  });

  test('--yes uses defaults and fails clearly on a bad key', async () => {
    const result = await runMe(['setup', '--yes', '--token', `med_${'f'.repeat(64)}`], { home, env: { MINIENGINE_SERVER: fake.url } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /kent deze dev key niet/);
  });
});

describe('admin', () => {
  test('login verifies and stores the admin token', async () => {
    const wrong = await me(['admin', 'login', '--token', 'x'.repeat(40)]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /accepteert dit admintoken niet/);
    const result = await me(['admin', 'login'], { input: `${fake.state.adminToken}\n` });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes(fake.state.adminToken));
    assert.equal(JSON.parse(await readFile(configFile(), 'utf8')).admin_token, fake.state.adminToken);
    assert.equal((await stat(configFile())).mode & 0o777, 0o600);
    const logout = await me(['admin', 'logout']);
    assert.match(logout.stdout, /Admintoken verwijderd/);
  });

  test('token create shows the key once; list and revoke', async () => {
    fake.addAccount('joost');
    const created = await admin(['admin', 'token', 'create', 'joost', '--label', 'werk', '--expires', '30']);
    assert.equal(created.code, 0, created.stderr);
    const token = /med_[0-9a-f]{64}/.exec(created.stdout)[0];
    assert.match(created.stdout, /maar één keer getoond/);
    assert.deepEqual(fake.state.requests.at(-1).body, { username: 'joost', label: 'werk', expires_in_days: 30 });
    const list = await admin(['admin', 'token', 'list']);
    assert.match(list.stdout, /joost\s+werk/);
    assert.ok(!list.stdout.includes(token));
    const id = (await admin(['admin', 'token', 'list', '--json'])).json().tokens[0].id;
    const revoked = await admin(['admin', 'token', 'revoke', id]);
    assert.match(revoked.stdout, /ingetrokken/);
    assert.match((await admin(['admin', 'token', 'list'])).stdout, /ingetrokken/);
    const unknown = await admin(['admin', 'token', 'create', 'niemand']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Dit account bestaat niet/);
    const badDays = await admin(['admin', 'token', 'create', 'joost', '--expires', '0']);
    assert.equal(badDays.code, 2);
  });

  test('games, block and unblock', async () => {
    await uploaded(['0.1.0']);
    const games = await admin(['admin', 'games']);
    assert.match(games.stdout, /ID\s+EIGENAAR\s+ACTIEF\s+STATUS\s+PRIVÉ\s+VERSIES\nkwis\s+sander\s+0\.1\.0\s+aan\s+-\s+1/);
    const block = await admin(['admin', 'game', 'block', 'kwis', '--json']);
    assert.equal(block.json().blocked, true);
    assert.deepEqual(fake.state.requests.at(-1).body, { enabled: false });
    assert.equal((await authed(['game', 'enable', 'kwis', '--json'])).json().error.code, 'game_blocked');
    const unblock = await admin(['admin', 'game', 'unblock', 'kwis']);
    assert.match(unblock.stdout, /vrijgegeven en staat aan/);
  });

  test('account promote and demote round trip', async () => {
    fake.addAccount('joost');
    const promoted = await admin(['admin', 'account', 'promote', 'Joost']);
    assert.equal(promoted.code, 0, promoted.stderr);
    assert.match(promoted.stdout, /@joost is nu beheerder\. Op de site kan die alle games blokkeren of vrijgeven/);
    assert.deepEqual(fake.state.requests.at(-1).body, { admin: true });
    assert.equal(fake.state.requests.at(-1).path, '/api/v1/admin/accounts/Joost/admin');
    const isAdmin = async () => (await admin(['admin', 'accounts', '--json'])).json().accounts.find(a => a.username === 'joost').admin;
    assert.equal(await isAdmin(), true);
    const demoted = await admin(['admin', 'account', 'demote', 'joost', '--json']);
    assert.equal(demoted.json().admin, false);
    assert.equal(await isAdmin(), false);
    assert.match((await admin(['admin', 'account', 'demote', 'joost'])).stdout, /@joost is geen beheerder meer\./);
  });

  test('account limit validates the number before sending', async () => {
    await uploaded(['0.1.0']);
    const set = await admin(['admin', 'account', 'limit', 'sander', '25']);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /@sander mag nu 25 games uploaden \(heeft er 1\)\./);
    assert.deepEqual(fake.state.requests.at(-1).body, { game_limit: 25 });
    assert.match((await admin(['admin', 'accounts'])).stdout, /sander\s+Sander\s+–\s+1 van 25\s+0 van 250 MB\s+–/);
    for (const bad of ['0', 'abc', '101', '2.5']) {
      const before = fake.state.requests.length;
      const result = await admin(['admin', 'account', 'limit', 'sander', bad]);
      assert.equal(result.code, 2, bad);
      assert.match(result.stderr, /heel getal van 1 tot 100/);
      assert.equal(fake.state.requests.length, before);
    }
  });

  test('account media sets the space for images, or back to the role', async () => {
    fake.state.accounts.get('sander').media_used = 12.3 * 1024 * 1024;
    const set = await admin(['admin', 'account', 'media', 'sander', '500']);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /@sander heeft nu 500 MB voor afbeeldingen \(gebruikt 12,3 MB\)\./);
    assert.deepEqual(fake.state.requests.at(-1).body, { media_limit_mb: 500 });
    assert.equal(fake.state.requests.at(-1).path, '/api/v1/admin/accounts/sander/media-limit');
    assert.match((await admin(['admin', 'accounts'])).stdout, /sander\s+Sander\s+–\s+0 van 10\s+12,3 van 500 MB\s+–/);
    const lower = await admin(['admin', 'account', 'media', 'sander', '0']);
    assert.match(lower.stdout, /@sander heeft nu 0 MB voor afbeeldingen \(gebruikt 12,3 MB\)\. Wat er staat blijft staan; nieuwe uploads worden geweigerd\./);
    const reset = await admin(['admin', 'account', 'media', 'sander', 'standaard', '--json']);
    assert.equal(reset.code, 0, reset.stderr);
    assert.deepEqual(fake.state.requests.at(-1).body, { media_limit_mb: null });
    assert.equal(reset.json().media_limit_mb, 250);
    assert.equal(reset.json().media_limit_custom, false);
    assert.match((await admin(['admin', 'account', 'media', 'sander', 'Standaard'])).stdout, /@sander heeft weer de ruimte van de rol: 250 MB voor afbeeldingen \(gebruikt 12,3 MB\)\./);
    for (const bad of ['1x', 'abc', '1048577', '2.5', '']) {
      const before = fake.state.requests.length;
      const result = await admin(['admin', 'account', 'media', 'sander', bad]);
      assert.equal(result.code, 2, bad);
      assert.match(result.stderr, /heel aantal MB van 0 tot 1048576 zijn, of "standaard"/);
      assert.equal(fake.state.requests.length, before);
    }
  });

  test('media requests: list, grant and reject', async () => {
    const empty = await admin(['admin', 'media', 'requests']);
    assert.equal(empty.code, 0, empty.stderr);
    assert.match(empty.stdout, /Er zijn geen open aanvragen voor ruimte voor afbeeldingen\./);
    fake.addAccount('joost');
    fake.addAccount('anouk');
    const first = fake.addMediaRequest('joost', 'Voor mijn pubquiz met foto\'s');
    const second = fake.addMediaRequest('anouk');
    const list = await admin(['admin', 'media', 'requests']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /^ID\s+GEBRUIKER\s+NAAM\s+AANGEVRAAGD\s+AFBEELDINGEN\s+BERICHT\n1\s+joost\s+Joost\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+0 van 0 MB\s+Voor mijn pubquiz met foto's\n2\s+anouk\s+Anouk\s.*\s-\n\nKen toe/);
    assert.match(list.stdout, /me admin media grant <id> <MB>/);
    assert.deepEqual((await admin(['admin', 'media', 'requests', '--json'])).json().requests.map(r => r.username), ['joost', 'anouk']);

    const grant = await admin(['admin', 'media', 'grant', String(first.id), '300']);
    assert.equal(grant.code, 0, grant.stderr);
    assert.match(grant.stdout, /Aanvraag 1 toegekend: @joost heeft nu 300 MB voor afbeeldingen\./);
    assert.deepEqual(fake.state.requests.at(-1).body, { decision: 'grant', media_limit_mb: 300 });
    assert.equal(fake.state.requests.at(-1).path, '/api/v1/admin/media-requests/1');

    const reject = await admin(['admin', 'media', 'reject', String(second.id), '--json']);
    assert.equal(reject.code, 0, reject.stderr);
    assert.deepEqual(fake.state.requests.at(-1).body, { decision: 'reject' });
    assert.equal(reject.json().request.status, 'rejected');
    assert.equal(reject.json().account.username, 'anouk');

    const again = await admin(['admin', 'media', 'reject', String(first.id)]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /Over deze aanvraag is al beslist\./);
    const unknown = await admin(['admin', 'media', 'grant', '99', '10', '--json']);
    assert.equal(unknown.json().error.code, 'media_request_not_found');
    assert.match((await admin(['admin', 'media', 'requests'])).stdout, /geen open aanvragen/);

    const third = fake.addMediaRequest('anouk', 'Nog een keer');
    const rejected = await admin(['admin', 'media', 'reject', String(third.id)]);
    assert.match(rejected.stdout, /Aanvraag 3 afgewezen\. @anouk houdt 0 MB voor afbeeldingen\./);

    for (const args of [['grant', '1', '0'], ['grant', '1', 'standaard'], ['grant', '1', '1048577'], ['grant', 'abc', '10'], ['reject', 'x']]) {
      const before = fake.state.requests.length;
      const result = await admin(['admin', 'media', ...args]);
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(fake.state.requests.length, before);
    }
  });

  test('account commands on an unknown user show the server message', async () => {
    for (const args of [['promote', 'niemand'], ['demote', 'niemand'], ['limit', 'niemand', '5'], ['media', 'niemand', '5']]) {
      const result = await admin(['admin', 'account', ...args]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Er is geen account met deze gebruikersnaam\./);
    }
  });

  test('accounts lists and searches', async () => {
    fake.addAccount('joost');
    fake.addAccount('anouk');
    await admin(['admin', 'account', 'verify', 'joost']);
    const all = await admin(['admin', 'accounts']);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /^GEBRUIKER\s+NAAM\s+BEHEERDER\s+GAMES\s+AFBEELDINGEN\s+E-MAIL\nanouk\s.*\njoost\s+Joost\s+–\s+0 van 10\s+0 van 0 MB\s+bevestigd\nsander\s/);
    const search = await admin(['admin', 'accounts', 'OOS', '--json']);
    assert.deepEqual(search.json().accounts.map(a => a.username), ['joost']);
    assert.deepEqual(fake.state.requests.at(-1).query, { q: 'OOS' });
    const none = await admin(['admin', 'accounts', 'zzz & co']);
    assert.equal(none.code, 0);
    assert.match(none.stdout, /Geen accounts gevonden voor "zzz & co"\./);
    assert.deepEqual(fake.state.requests.at(-1).query, { q: 'zzz & co' });
  });

  test('account commands with a wrong admin token', async () => {
    const env = { MINIENGINE_ADMIN_TOKEN: 'w'.repeat(40) };
    for (const args of [['accounts'], ['account', 'promote', 'sander'], ['account', 'limit', 'sander', '5'], ['account', 'media', 'sander', '5'], ['media', 'requests']]) {
      const result = await me(['admin', ...args], { env });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Het admintoken klopt niet\. Log opnieuw in met: me admin login/);
    }
  });

  test('admin_disabled and missing token', async () => {
    const missing = await me(['admin', 'games']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Geen admintoken ingesteld\.\nLog in met: me admin login/);
    fake.state.adminToken = null;
    const disabled = await me(['admin', 'games', '--json'], { env: { MINIENGINE_ADMIN_TOKEN: 'y'.repeat(40) } });
    assert.equal(disabled.json().error.code, 'admin_disabled');
  });
});
