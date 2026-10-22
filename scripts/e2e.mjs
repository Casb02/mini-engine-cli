#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = process.env.MINIENGINE_E2E_SERVER?.replace(/\/+$/, '');
const adminToken = process.env.MINIENGINE_E2E_ADMIN_TOKEN;
if (!server || !adminToken) {
  console.error('Zet MINIENGINE_E2E_SERVER en MINIENGINE_E2E_ADMIN_TOKEN.');
  process.exit(2);
}

const bin = fileURLToPath(new URL('../bin/me.mjs', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'me-e2e-'));
const suffix = randomBytes(4).toString('hex');
const username = `e2e_${suffix}`;
const slug = `e2e-${suffix}`;
const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), MINIENGINE_SERVER: server };
let step = 0;

function me(args, { input, expectFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bin, ...args, '--json'], { cwd: home, env, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (error.code ?? 1) : 0;
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        return reject(new Error(`me ${args.join(' ')}: geen JSON (exit ${code})\n${stdout}\n${stderr}`));
      }
      if (expectFail ? code === 0 : code !== 0) {
        return reject(new Error(`me ${args.join(' ')}: exit ${code}\n${JSON.stringify(data, null, 2)}\n${stderr}`));
      }
      resolve(data);
    });
    child.stdin.end(input ?? '');
  });
}

function check(condition, label, detail) {
  step += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`}`);
  console.log(`ok ${String(step).padStart(2)}  ${label}`);
}

async function api(path, options = {}) {
  const response = await fetch(`${server}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function setVersion(version) {
  const path = join(home, slug, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const publicIds = async () => (await api('/api/v1/games')).data.games.map(game => game.id);

try {
  const health = await api('/api/health');
  check(health.status === 200, `engine bereikbaar (${health.data?.version})`);

  const registered = await api('/api/v1/accounts/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: `e2e-password-${suffix}`, display_name: 'E2E', email: `${username}@example.com` }),
  });
  check(registered.status === 201 && registered.data.account.email_verified === false, `account ${username} geregistreerd, e-mail nog niet bevestigd`, registered.data);

  const admin = await me(['admin', 'login', '--token', adminToken]);
  check(admin.admin_token.masked.endsWith(adminToken.slice(-4)), 'me admin login');
  const config = await stat(join(home, 'config', 'miniengine', 'config.json'));
  check((config.mode & 0o777) === 0o600, 'config.json heeft rechten 0600');

  const unverified = await me(['admin', 'token', 'create', username], { expectFail: true });
  check(unverified.error?.code === 'email_not_verified', 'geen dev key zonder bevestigd e-mailadres', unverified);
  const verified = await me(['admin', 'account', 'verify', username]);
  check(verified.email_verified === true, 'me admin account verify', verified);

  const created = await me(['admin', 'token', 'create', username, '--label', 'e2e', '--expires', '1']);
  check(/^med_[0-9a-f]{64}$/.test(created.token) && created.username === username, 'me admin token create', created);

  const auth = await me(['auth', '--token', created.token]);
  check(auth.account.username === username && !JSON.stringify(auth).includes(created.token), 'me auth --token (sleutel niet in uitvoer)', auth);
  const status = await me(['auth', 'status']);
  check(status.account.username === username && status.token.label === 'e2e', 'me auth status', status);

  const scaffold = await me(['game', 'new', slug]);
  check(scaffold.files.includes('manifest.json'), `me game new ${slug}`, scaffold);

  const dry = await me(['game', 'upload', slug, '--dry-run']);
  const paths = dry.files.map(file => file.path);
  check(dry.dry_run && paths.includes('assets/app.js') && !paths.includes('jsconfig.json') && !paths.includes('.meignore'), 'me game upload --dry-run volgt .meignore', paths);

  const first = await me(['game', 'upload', slug]);
  check(first.release.version === '0.1.0' && first.release.active && first.game.active_version === '0.1.0', 'eerste upload wordt actief', first);
  check(/^[0-9a-f]{64}$/.test(String(first.release.content_hash).replace(/^sha256:/, '')), 'release heeft een content hash', first.release);

  const room = await api('/api/v1/rooms', { method: 'POST', body: JSON.stringify({ game_id: slug }) });
  check(room.status === 201 || room.status === 200, `room ${room.data?.code} gemaakt met de geüploade game`, room.data);
  const html = await fetch(`${server}/api/v1/games/${slug}/host?room=${room.data.code}`).then(response => response.text());
  check(html.includes(`"/releases/${slug}/0.1.0/assets/app.js"`), 'host-HTML verwijst naar de vastgepinde release');
  const script = await fetch(`${server}/releases/${slug}/0.1.0/assets/app.js`);
  check(script.status === 200 && (await script.text()).includes('MiniEngine'), 'release-asset wordt geserveerd');

  const list = await me(['game', 'list']);
  check(list.games.some(game => game.id === slug), 'me game list', list);
  check((await publicIds()).includes(slug), 'game staat in /api/v1/games');

  const duplicate = await me(['game', 'upload', slug], { expectFail: true });
  check(duplicate.error.code === 'version_exists', 'dezelfde versie opnieuw uploaden geeft version_exists', duplicate);

  await setVersion('0.1.1');
  const second = await me(['game', 'upload', slug]);
  check(second.release.version === '0.1.1' && !second.release.active && second.game.active_version === '0.1.0', 'tweede upload blijft inactief', second);
  await setVersion('0.1.2');
  const third = await me(['game', 'upload', slug]);
  check(!third.release.active, 'derde upload blijft inactief');

  const activated = await me(['game', 'activate', slug, '0.1.1']);
  check(activated.active_version === '0.1.1', 'me game activate 0.1.1', activated);

  const activeDelete = await me(['game', 'delete-version', slug, '0.1.1'], { expectFail: true });
  check(activeDelete.error.code === 'release_active', 'actieve versie verwijderen geeft release_active', activeDelete);

  const disabled = await me(['game', 'disable', slug]);
  check(disabled.enabled === false && !(await publicIds()).includes(slug), 'me game disable verbergt de game', disabled);
  const enabled = await me(['game', 'enable', slug]);
  check(enabled.enabled === true && (await publicIds()).includes(slug), 'me game enable toont de game weer', enabled);

  const adminGames = await me(['admin', 'games']);
  const owned = adminGames.games.find(game => game.id === slug);
  check(owned?.owner?.username === username, 'me admin games toont eigenaar', owned);
  const blocked = await me(['admin', 'game', 'block', slug]);
  check(blocked.blocked === true && blocked.enabled === false, 'me admin game block', blocked);
  const refused = await me(['game', 'enable', slug], { expectFail: true });
  check(refused.error.code === 'game_blocked', 'eigenaar kan geblokkeerde game niet aanzetten', refused);
  const unblocked = await me(['admin', 'game', 'unblock', slug]);
  check(unblocked.blocked === false && unblocked.enabled === true, 'me admin game unblock', unblocked);

  const preview = await me(['game', 'prune', slug, '--keep', '0', '--dry-run']);
  check(
    preview.deleted.join() === '0.1.2' && preview.keep.join() === '0.1.1' && preview.skipped.map(item => item.version).join() === '0.1.0',
    'me game prune --dry-run slaat de versie van de lopende room over',
    preview,
  );
  const inUse = await me(['game', 'delete', slug, '--yes'], { expectFail: true });
  check(inUse.error.code === 'game_in_use', 'game met lopende room verwijderen geeft game_in_use', inUse);
  const closed = await api(`/api/v1/rooms/${room.data.code}`, { method: 'DELETE', headers: { authorization: `Bearer ${room.data.token}` } });
  check(closed.status === 204, 'room gesloten', closed.data);
  const pruned = await me(['game', 'prune', slug, '--keep', '0', '--yes']);
  check([...pruned.deleted].sort().join() === '0.1.0,0.1.2' && pruned.failed.length === 0, 'me game prune --keep 0 --yes', pruned);
  const versions = await me(['game', 'versions', slug]);
  check(versions.versions.map(release => release.version).join() === '0.1.1', 'alleen de actieve versie blijft over', versions);

  const unconfirmed = await me(['game', 'delete', slug], { expectFail: true });
  check(unconfirmed.error.code === 'usage', 'me game delete zonder --yes weigert zonder terminal', unconfirmed);
  const deleted = await me(['game', 'delete', slug, '--yes']);
  check(deleted.deleted, 'me game delete --yes');
  check(!(await me(['game', 'list'])).games.some(game => game.id === slug), 'game is weg uit me game list');

  const tokens = await me(['admin', 'token', 'list']);
  check(tokens.tokens.some(token => token.id === created.id && token.last_used_at), 'me admin token list toont gebruik', tokens);
  await me(['admin', 'token', 'revoke', created.id]);
  const revoked = await me(['auth', 'status'], { expectFail: true });
  check(revoked.error.status === 401, 'ingetrokken dev key werkt niet meer', revoked);

  console.log(`\nAlle ${step} stappen geslaagd tegen ${server}.`);
} catch (error) {
  console.error(`\nMISLUKT na stap ${step}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(home, { recursive: true, force: true });
}
