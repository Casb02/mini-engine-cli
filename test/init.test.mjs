import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { packGame } from '../src/pack.mjs';
import { startFakeServer } from './helpers/fake-server.mjs';
import { BIN, closedPort, runMe, tempHome } from './helpers/run.mjs';

const TEMPLATES = ['stemmen', 'quiz', 'buzzer', 'beurten', 'leeg'];
const versionUrl = version => `data:application/json,${encodeURIComponent(JSON.stringify({ version }))}`;
const { version: CLI_VERSION } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

let fake;
let home;
let cleanup;
let key;

beforeEach(async () => {
  fake = await startFakeServer({ version: '0.6.1' });
  fake.addAccount('dani');
  key = fake.issueToken('dani').token;
  ({ home, cleanup } = await tempHome());
});

afterEach(async () => {
  await fake.close();
  await cleanup();
});

const me = (args, options = {}) => runMe(args, { home, ...options, env: { MINIENGINE_SERVER: fake.url, MINIENGINE_VERSION_URL: versionUrl(CLI_VERSION), ...options.env } });
const manifestOf = async dir => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));

describe('me init', () => {
  test('without a terminal it asks nothing and uses the defaults, here in the empty folder', async () => {
    const dir = join(home, 'feestje');
    await mkdir(dir);
    const result = await me(['init'], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '', 'no questions without a terminal');
    assert.match(result.stdout, /^Feestje staat klaar in deze map\.\n {2}Sjabloon {3}stemmen\n {2}Id {9}feestje\n/);
    assert.match(result.stdout, /Kamer {6}Iedereen doet mee \(standaard\) of TV/);
    assert.match(result.stdout, /Uiterlijk {2}MiniEngineUI, thema kalk/);
    assert.match(result.stdout.trimEnd(), /Volgende stappen:\n {2}me dev\n {2}me auth\n {2}me game upload$/);
    const manifest = await manifestOf(dir);
    assert.deepEqual([manifest.id, manifest.title, manifest.default_host_mode], ['feestje', 'Feestje', 'playing']);
    assert.match(await readFile(join(dir, 'player.html'), 'utf8'), /<html lang="nl">[\s\S]*data-theme="kalk"/);
    assert.ok((await stat(join(dir, 'assets', 'ui', 'mini-engine-ui.css'))).isFile());
    assert.ok((await stat(join(home, '.claude', 'skills', 'build-mini-engine-game', 'SKILL.md'))).isFile(), 'missing skills are installed by default');
  });

  test('flags choose everything; --json prints one object', async () => {
    const result = await me(['init', 'kwisavond', '--template', 'quiz', '--title', 'Kwis bij Dani', '--players', '2-6', '--modes', 'tv,playing', '--look', 'plain', '--lang', 'en', '--no-skills', '--json'], { env: { MINIENGINE_TOKEN: key } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const data = result.json();
    assert.equal(data.directory, join(home, 'kwisavond'));
    assert.deepEqual(
      [data.id, data.title, data.template, data.min_players, data.max_players, data.host_modes, data.default_host_mode, data.look, data.theme, data.language, data.skills],
      ['kwis-bij-dani', 'Kwis bij Dani', 'quiz', 2, 6, ['tv', 'playing'], 'tv', 'plain', null, 'en', null],
    );
    assert.deepEqual(data.next, ['cd kwisavond', 'me dev', 'me game upload']);
    assert.ok(data.files.includes('data.json') && data.files.includes('tests/logic.test.mjs') && !data.files.some(file => file.startsWith('assets/ui/')));
    const manifest = await manifestOf(data.directory);
    assert.deepEqual([manifest.min_players, manifest.max_players, manifest.host_modes, manifest.set_kinds[0].id], [2, 6, ['tv', 'playing'], 'questions']);
    await assert.rejects(stat(join(home, '.claude')), 'no skills with --no-skills');
  });

  test('a folder that is not empty gets the game in a new folder; a full one named on purpose is refused', async () => {
    await writeFile(join(home, 'notities.txt'), 'van Pim');
    const result = await me(['init', '--yes', '--title', 'Pim zijn quiz!', '--template', 'leeg', '--no-skills']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Pim zijn quiz! staat klaar in pim-zijn-quiz\./);
    assert.equal((await manifestOf(join(home, 'pim-zijn-quiz'))).id, 'pim-zijn-quiz');
    const again = await me(['init', '--yes', '--title', 'Pim zijn quiz!', '--no-skills']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /Map bestaat al: pim-zijn-quiz/);
    const full = await me(['init', 'pim-zijn-quiz', '--yes']);
    assert.equal(full.code, 1);
    assert.match(full.stderr, /Map is niet leeg: pim-zijn-quiz\nKies een nieuwe of lege map/);
    const empty = join(home, 'leeg-met-git');
    await mkdir(join(empty, '.git'), { recursive: true });
    assert.equal((await me(['init', 'leeg-met-git', '--yes', '--no-skills'])).code, 0, 'hidden files such as .git are fine');
  });

  test('wrong flags are refused before anything is written', async () => {
    for (const [flag, value, message] of [
      ['--template', 'pubquiz', /Onbekend sjabloon: pubquiz\nKies uit: stemmen, quiz, buzzer, beurten, leeg/],
      ['--players', '8-2', /Spelers zijn MIN-MAX/],
      ['--modes', 'moderator', /Kies playing, tv of playing,tv/],
      ['--look', 'fancy', /Onbekend uiterlijk/],
      ['--theme', 'roze', /Onbekend thema/],
      ['--lang', 'de', /Onbekende taal/],
      ['--slug', 'Kwis', /Slug moet/],
    ]) {
      const result = await me(['init', 'x', '--yes', flag, value]);
      assert.equal(result.code, 2, `${flag} ${value}`);
      assert.match(result.stderr, message);
    }
    assert.deepEqual((await readdir(home)).filter(name => !name.startsWith('.')), []);
    assert.equal((await me(['init', 'x', '--dev', '--json'])).code, 2);
  });

  test('answers on stdin with --interactive: every question, a wrong answer asked again, and no me dev', async () => {
    const dir = join(home, 'buzzavond');
    await mkdir(dir);
    const answers = ['Sander zijn buzzer', '', '3', '12-2', '', '3', '1', '', '2', 'n', 'n'];
    const result = await me(['init', '--interactive'], { cwd: dir, input: `${answers.join('\n')}\n` });
    assert.equal(result.code, 0, result.stderr);
    for (const question of ['Titel [Buzzavond]', 'Id op de server [sander-zijn-buzzer]', 'Startsjabloon', 'Spelers (min-max) [2-12]', 'Wie maakt de kamer?', 'Uiterlijk', 'Thema', 'Kies [2]', 'Taal van het spel', 'AI-skills voor Claude Code installeren', 'Nu proberen met me dev? [J/n]']) {
      assert.ok(result.stderr.includes(question), `asks ${question}`);
    }
    assert.match(result.stderr, /Spelers zijn MIN-MAX/);
    assert.match(result.stdout, /Sander zijn buzzer staat klaar in deze map\.\n {2}Sjabloon {3}buzzer\n {2}Id {9}sander-zijn-buzzer\n {2}Spelers {4}2 tot 12\n {2}Kamer {6}alleen TV\n {2}Uiterlijk {2}MiniEngineUI, thema nacht\n {2}Taal {7}English\n {2}AI-skills {2}niet geïnstalleerd; later: me skill install/);
    assert.match(result.stdout, /Volgende stappen:/);
    const manifest = await manifestOf(dir);
    assert.deepEqual([manifest.id, manifest.host_modes, manifest.default_host_mode], ['sander-zijn-buzzer', ['tv'], 'tv']);
    assert.match(await readFile(join(dir, 'host.html'), 'utf8'), /<html lang="en">[\s\S]*data-theme="nacht"/);
  });

  test('--dev starts me dev on the new game', async () => {
    const child = spawn(process.execPath, [BIN, 'init', 'meteen', '--yes', '--template', 'leeg', '--no-skills', '--dev', '--port', '0', '--no-open'], { cwd: home, env: { PATH: process.env.PATH, HOME: home } });
    let out = '';
    child.stdout.on('data', chunk => (out += chunk));
    const closed = new Promise(resolve => child.on('close', resolve));
    try {
      for (let waited = 0; !/Overzicht: (http:\/\/127\.0\.0\.1:\d+)/.test(out); waited += 50) {
        if (waited > 10000) throw new Error(`me dev did not start:\n${out}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const url = /Overzicht: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
      assert.equal((await (await fetch(`${url}/api/v1/games`)).json()).games[0].id, 'meteen');
      assert.match(out, /^Meteen staat klaar in meteen\./);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });

  for (const template of TEMPLATES) {
    test(`${template}: the game passes its own tests, the upload checks and me doctor`, async () => {
      const result = await me(['init', template, '--yes', '--template', template, '--no-skills', '--json']);
      assert.equal(result.code, 0, result.stdout);
      const dir = result.json().directory;
      const tests = spawnSync(process.execPath, ['--test', 'tests/logic.test.mjs'], { cwd: dir, encoding: 'utf8' });
      assert.equal(tests.status, 0, tests.stdout + tests.stderr);
      const pack = await packGame(dir);
      assert.equal(pack.id, template);
      assert.ok(pack.files.some(file => file.path === 'assets/icon.svg'));
      assert.ok(!pack.files.some(file => file.path.startsWith('tests/') || file.path === 'jsconfig.json' || file.path.startsWith('types/')));
      const doctor = await me(['doctor', template, '--json'], { env: { MINIENGINE_TOKEN: key } });
      const game = doctor.json().checks.find(check => check.id === 'game');
      assert.equal(game.ok, true, game.title);
    });
  }
});

describe('me doctor', () => {
  test('all in order: a calm checklist and exit code 0', async () => {
    await me(['skill', 'install']);
    await me(['init', 'kwis', '--yes', '--template', 'quiz', '--no-skills']);
    const result = await me(['doctor'], { cwd: join(home, 'kwis'), env: { MINIENGINE_TOKEN: key } });
    assert.equal(result.code, 0, result.stdout);
    const lines = result.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^✓ Node\.js \d+/);
    assert.equal(lines[1], `✓ CLI ${CLI_VERSION} is de nieuwste versie`);
    assert.match(lines[2], /^✓ Server http:\/\/127\.0\.0\.1:\d+ \(uit MINIENGINE_SERVER\) is bereikbaar, Mini Engine 0\.6\.1$/);
    assert.match(lines[3], /^✓ Ingelogd als Dani \(@dani\) met med_…[0-9a-f]{4}$/);
    assert.equal(lines[4], '✓ AI-skills staan in ~/.claude/skills');
    assert.match(lines[5], /^✓ Spel kwis 0\.1\.0 in \.: \d+ bestanden, [\d,]+ KiB, klaar om te uploaden$/);
    assert.equal(lines[6], '✓ kwis is nog niet geüpload; de eerste upload staat meteen live');
    assert.equal(lines.at(-1), 'Alles in orde.');
    await me(['game', 'upload'], { cwd: join(home, 'kwis'), env: { MINIENGINE_TOKEN: key } });
    const uploaded = await me(['doctor', '--json'], { cwd: join(home, 'kwis'), env: { MINIENGINE_TOKEN: key } });
    assert.equal(uploaded.code, 1);
    const version = uploaded.json().checks.find(check => check.id === 'version');
    assert.deepEqual([version.ok, version.fix], [false, 'Verhoog version in manifest.json voor de volgende upload.']);
  });

  test('from Mini Engine 0.9 the first upload can also be private', async () => {
    fake.state.version = '0.9.0';
    await me(['init', 'kwis', '--yes', '--template', 'quiz', '--no-skills']);
    const result = await me(['doctor', '--json'], { cwd: join(home, 'kwis'), env: { MINIENGINE_TOKEN: key } });
    const version = result.json().checks.find(check => check.id === 'version');
    assert.deepEqual([version.ok, version.title], [true, 'kwis is nog niet geüpload; de eerste upload staat meteen live, of alleen voor jou met me game upload --private']);
  });

  test('broken: an old CLI, no server, no dev key, missing skills and a broken game, each with one fix', async () => {
    const port = await closedPort();
    await me(['game', 'new', 'kapot']);
    await writeFile(join(home, 'kapot', 'player.html'), '');
    const { unlink } = await import('node:fs/promises');
    await unlink(join(home, 'kapot', 'player.html'));
    const result = await me(['doctor', 'kapot'], { env: { MINIENGINE_SERVER: `http://127.0.0.1:${port}`, MINIENGINE_VERSION_URL: versionUrl('9.9.9') } });
    assert.equal(result.code, 1);
    assert.match(result.stdout, new RegExp(`✗ CLI ${CLI_VERSION.replace(/\./g, '\\.')}; versie 9\\.9\\.9 is uit\\.\\n {4}Bijwerken: npm install -g github:Casb02/mini-engine-cli`));
    assert.match(result.stdout, /✗ Server http:\/\/127\.0\.0\.1:\d+ \(uit MINIENGINE_SERVER\) is niet bereikbaar: Kan .* niet bereiken \(verbinding geweigerd\)\.\n {4}Controleer je internet en het adres/);
    assert.match(result.stdout, /✗ Geen dev key voor .*\n {4}Vraag een dev key aan wie de server beheert en log in met: me auth/);
    assert.match(result.stdout, /✗ AI-skills ontbreken in ~\/\.claude\/skills: build-mini-engine-game, design-mini-engine-game-ui, mini-engine-ui\n {4}Installeren: me skill install/);
    assert.match(result.stdout, /✗ Het spel in kapot kan zo niet worden geüpload: Ontbrekende bestanden: player\.html\n {4}Pas het aan en draai me doctor opnieuw\./);
    assert.match(result.stdout.trimEnd(), /\n\n5 dingen om op te lossen\.$/);
    const json = await me(['doctor', 'kapot', '--json'], { env: { MINIENGINE_SERVER: `http://127.0.0.1:${port}`, MINIENGINE_VERSION_URL: versionUrl('9.9.9') } });
    const data = json.json();
    assert.equal(data.ok, false);
    assert.deepEqual(data.checks.map(check => [check.id, check.ok]), [['node', true], ['cli', false], ['server', false], ['auth', false], ['skills', false], ['game', false]]);
  });

  test('offline it skips the version check; a wrong key, wrong asset paths and a missing manifest are named', async () => {
    const port = await closedPort();
    await me(['skill', 'install']);
    await me(['game', 'new', 'hernoemd']);
    const manifest = await manifestOf(join(home, 'hernoemd'));
    await writeFile(join(home, 'hernoemd', 'manifest.json'), JSON.stringify({ ...manifest, id: 'nieuwe-naam' }));
    const result = await me(['doctor', 'hernoemd'], { env: { MINIENGINE_TOKEN: `med_${'0'.repeat(64)}`, MINIENGINE_VERSION_URL: `http://127.0.0.1:${port}/package.json` } });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /– CLI [\d.]+; nieuwste versie niet bekeken \(geen verbinding met GitHub\)/);
    assert.match(result.stdout, /✗ Je dev key med_…0000 werkt niet op .*\n {4}Log opnieuw in met: me auth/);
    assert.match(result.stdout, /✗ Het spel nieuwe-naam 0\.1\.0 in hernoemd mist bestanden\. host\.html laadt \/games\/hernoemd\/assets\/style\.css, maar het id van het spel is nieuwe-naam\. \(en nog \d+\)\n {4}Verander het pad in \/games\/nieuwe-naam\/assets\/style\.css\./);
    await me(['game', 'new', 'plaatjes']);
    const image = { type: 'object', additionalProperties: false, properties: { plaatje: { type: 'string', format: 'image' } } };
    const plain = await manifestOf(join(home, 'plaatjes'));
    await writeFile(join(home, 'plaatjes', 'manifest.json'), JSON.stringify({ ...plain, set_kinds: [{ id: 'foto', title: 'Foto', description: 'Eén plaatje.', schema: image }] }));
    await writeFile(join(home, 'plaatjes', 'data.json'), JSON.stringify({ plaatje: 'assets/kat.png' }));
    const pictures = await me(['doctor', 'plaatjes'], { env: { MINIENGINE_VERSION_URL: `http://127.0.0.1:${port}/package.json` } });
    assert.match(pictures.stdout, /✗ Het spel plaatjes 0\.1\.0 in plaatjes mist bestanden\. data\.json: plaatje: assets\/kat\.png staat niet in de game\.\n {4}Zet de afbeelding in assets\/ en gebruik dat pad/);
    await writeFile(join(home, 'plaatjes', 'assets', 'kat.png'), 'png');
    const fixed = await me(['doctor', 'plaatjes', '--json'], { env: { MINIENGINE_VERSION_URL: `http://127.0.0.1:${port}/package.json` } });
    assert.equal(fixed.json().checks.find(check => check.id === 'game').ok, true);
    const none = await me(['doctor', 'bestaat-niet']);
    assert.match(none.stdout, /✗ Geen manifest.json in bestaat-niet\.\n {4}Maak een spel met: me init/);
  });
});
