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
  test('top-level help lists every command group', async () => {
    const result = await runMe(['--help'], { home });
    assert.equal(result.code, 0);
    for (const text of ['setup', 'auth status', 'game upload [map]', 'game prune <id>', 'skill install', 'admin token create', 'admin game block <id>']) {
      assert.match(result.stdout, new RegExp(text.replace(/[[\]]/g, '\\$&')));
    }
    assert.deepEqual(await runMe([], { home }).then(r => r.stdout), result.stdout);
  });

  test('group and command help', async () => {
    const group = await runMe(['game'], { home });
    assert.equal(group.code, 0);
    assert.match(group.stdout, /Gebruik: me game <commando>/);
    const command = await runMe(['game', 'upload', '--help'], { home });
    assert.match(command.stdout, /Gebruik: me game upload \[map\] \[--activate\] \[--dry-run\]/);
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
    assert.deepEqual(result.json(), { error: { code: 'game_not_found', message: 'Deze game bestaat niet.', status: 404 } });
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
    assert.deepEqual(manifest.host_modes, ['moderator']);
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
    assert.match(result.stdout, /Spelen: .*\/demo\/new\/kwis/);
    const request = fake.state.requests.find(r => r.method === 'POST');
    assert.equal(request.path, '/api/v1/dev/games/kwis/versions');
    assert.equal(request.body.activate, undefined);
    assert.deepEqual(Object.keys(request.body.files).sort(), ['README.md', 'assets/app.js', 'assets/style.css', 'display.html', 'host.html', 'manifest.json', 'player.html']);
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

  test('list and versions', async () => {
    const empty = await authed(['game', 'list']);
    assert.match(empty.stdout, /Je hebt nog geen games/);
    await uploaded(['0.1.0', '0.2.0']);
    const list = await authed(['game', 'list']);
    assert.match(list.stdout, /ID\s+TITEL\s+ACTIEF\s+STATUS\s+VERSIES\nkwis\s+Kwis\s+0\.1\.0\s+aan\s+2/);
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

describe('skill', () => {
  test('list shows the vendored skills', async () => {
    const result = await runMe(['skill', 'list', '--json'], { home });
    const data = result.json();
    assert.equal(data.sdk_version, JSON.parse(await readFile(new URL('../vendor/VENDOR.json', import.meta.url), 'utf8')).sdk.version);
    assert.deepEqual(data.skills.map(skill => skill.name), ['build-mini-engine-game', 'design-mini-engine-game-ui']);
  });

  test('install into ~/.claude/skills, --project and --path', async () => {
    const result = await runMe(['skill', 'install'], { home });
    assert.equal(result.code, 0, result.stderr);
    const skill = join(home, '.claude', 'skills', 'build-mini-engine-game');
    assert.ok((await readFile(join(skill, 'SKILL.md'), 'utf8')).includes('name: build-mini-engine-game'));
    assert.ok((await stat(join(skill, 'scripts', 'play.mjs'))).isFile());
    const project = join(home, 'project');
    await mkdir(project);
    await runMe(['skill', 'install', 'design-mini-engine-game-ui', '--project'], { home, cwd: project });
    assert.deepEqual(await readdir(join(project, '.claude', 'skills')), ['design-mini-engine-game-ui']);
    await runMe(['skill', 'install', '--path', 'elders'], { home });
    assert.equal((await readdir(join(home, 'elders'))).length, 2);
    const both = await runMe(['skill', 'install', '--project', '--path', 'x'], { home });
    assert.equal(both.code, 2);
  });

  test('refuses to overwrite a different skill unless --force', async () => {
    await runMe(['skill', 'install'], { home });
    const same = await runMe(['skill', 'install', '--json'], { home });
    assert.deepEqual(same.json().skills.map(skill => skill.status), ['al actueel', 'al actueel']);
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
    assert.equal(data.server_version, '0.4.0');
    assert.equal(data.account.username, 'sander');
    assert.equal(data.skills, null);
    assert.equal(data.game.id, 'eerste');
    assert.deepEqual(data.next, ['cd eerste', 'me game upload', 'me game list']);
    assert.deepEqual(JSON.parse(await readFile(configFile(), 'utf8')), { server: fake.url, token: key });
    await assert.rejects(stat(join(home, '.claude')));
  });

  test('answers from stdin, every step skippable', async () => {
    const input = [fake.url, key, 'j', 'ja', 'mijn-quiz', ''].join('\n');
    const result = await runMe(['setup'], { home, input });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Ingelogd als Sander/);
    assert.match(result.stdout, /Klaar\. Volgende stappen:\n {2}cd mijn-quiz\n {2}me game upload\n {2}me game list/);
    assert.ok((await stat(join(home, '.claude', 'skills', 'build-mini-engine-game'))).isDirectory());
    assert.ok((await stat(join(home, 'mijn-quiz', 'manifest.json'))).isFile());

    const { home: other, cleanup: done } = await tempHome();
    const skipped = await runMe(['setup'], { home: other, input: `${fake.url}\n\nn\nn\n` });
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.match(skipped.stdout, /me auth\n {2}me game new mijn-game/);
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
    assert.match(games.stdout, /kwis\s+sander\s+0\.1\.0\s+aan\s+1/);
    const block = await admin(['admin', 'game', 'block', 'kwis', '--json']);
    assert.equal(block.json().blocked, true);
    assert.deepEqual(fake.state.requests.at(-1).body, { enabled: false });
    assert.equal((await authed(['game', 'enable', 'kwis', '--json'])).json().error.code, 'game_blocked');
    const unblock = await admin(['admin', 'game', 'unblock', 'kwis']);
    assert.match(unblock.stdout, /vrijgegeven en staat aan/);
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
