import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const MiB = 1024 * 1024;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => {
  throw new HttpError(status, code, message);
};

function contentHash(files) {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    hash.update(`${path}\0${files[path].length}\0`);
    hash.update(files[path]);
  }
  return hash.digest('hex');
}

export async function startFakeServer({ adminToken = 'admin-token-0123456789abcdef0123456789', builtins = ['common-dice'], quotaGames = 10, quotaReleases = 10, version = '0.5.0' } = {}) {
  let clock = 1_760_000_000;
  const tick = () => (clock += 1);
  const state = { accounts: new Map(), tokens: [], games: new Map(), requests: [], adminToken, version };

  const addAccount = username => {
    const account = { id: randomUUID(), username, display_name: username[0].toUpperCase() + username.slice(1), admin: false, email_verified: false, created_at: clock, game_limit: quotaGames };
    state.accounts.set(username, account);
    return account;
  };
  const issueToken = (username, { label = 'cli', expires_at = null } = {}) => {
    const token = { id: randomUUID(), token: `med_${randomBytes(32).toString('hex')}`, username, label, created_at: tick(), expires_at, last_used_at: null, revoked_at: null };
    state.tokens.unshift(token);
    return token;
  };

  const release = (game, r) => ({
    version: r.version,
    title: game.title,
    content_hash: r.content_hash,
    size: r.size,
    file_count: r.file_count,
    created_at: r.created_at,
    active: game.active_version === r.version,
    in_use: r.in_use,
  });
  const view = game => ({
    id: game.id,
    title: game.title,
    enabled: game.enabled,
    blocked: game.blocked,
    active_version: game.active_version,
    created_at: game.created_at,
    updated_at: game.updated_at,
    versions: game.releases.map(r => release(game, r)),
  });
  const adminView = game => {
    const owner = state.accounts.get(game.owner);
    return { ...view(game), owner: { id: owner.id, username: owner.username, display_name: owner.display_name } };
  };

  const ownedGames = username => [...state.games.values()].filter(g => g.owner === username).length;
  const accountView = account => ({
    username: account.username,
    display_name: account.display_name,
    admin: account.admin,
    email_verified: account.email_verified,
    created_at: account.created_at,
    games: ownedGames(account.username),
    game_limit: account.game_limit,
  });
  const findAccount = raw => {
    const account = state.accounts.get(decodeURIComponent(raw).trim().toLowerCase());
    if (!account) fail(404, 'account_not_found', 'Er is geen account met deze gebruikersnaam.');
    return account;
  };

  const bearer = req => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const devAccount = req => {
    const value = bearer(req);
    const token = state.tokens.find(t => t.token === value);
    if (!token || token.revoked_at || (token.expires_at && token.expires_at < clock)) fail(401, 'unauthorized', 'Ongeldige of verlopen sessie.');
    token.last_used_at = tick();
    return { account: state.accounts.get(token.username), token };
  };
  const requireAdmin = req => {
    if (!state.adminToken) fail(404, 'admin_disabled', 'Beheer staat uit op deze server.');
    if (bearer(req) !== state.adminToken) fail(401, 'unauthorized', 'Ongeldig admintoken.');
  };
  const ownGame = (account, id) => {
    const game = state.games.get(id);
    if (!game || game.owner !== account.username) fail(404, 'game_not_found', 'Deze game bestaat niet.');
    return game;
  };

  function upload(account, id, body) {
    if (!body || typeof body.files !== 'object' || Array.isArray(body.files)) fail(400, 'invalid_request', 'files ontbreekt.');
    const files = {};
    let total = 0;
    for (const [path, data] of Object.entries(body.files)) {
      const segments = path.split('/');
      if (path.includes('\\') || Buffer.byteLength(path) > 255 || segments.length > 32 || segments.some(s => !s || s === '.' || s === '..')) {
        fail(400, 'invalid_request', `Ongeldig pad: ${path}`);
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > 2 * MiB) fail(400, 'invalid_request', 'Bestand te groot.');
      total += bytes.length;
      files[path] = bytes;
    }
    if (Object.keys(files).length > 4096 || total > 10 * MiB) fail(400, 'invalid_request', 'Game te groot.');
    if (!files['manifest.json']) fail(400, 'invalid_request', 'manifest.json ontbreekt.');
    const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
    if (manifest.id !== id) fail(400, 'invalid_request', 'Manifest-id hoort bij de URL.');
    if (!VERSION.test(manifest.version ?? '')) fail(400, 'invalid_request', 'Ongeldige versie.');
    if (manifest.runtime !== 'host') fail(400, 'invalid_request', 'Alleen runtime host.');
    if (builtins.includes(id)) fail(409, 'game_id_taken', 'Deze id is van een ingebouwde game.');
    let game = state.games.get(id);
    if (game && game.owner !== account.username) fail(403, 'forbidden', 'Deze game is van een andere ontwikkelaar.');
    if (!game && ownedGames(account.username) >= account.game_limit) {
      fail(409, 'quota_games', `Je hebt al ${account.game_limit} games.`);
    }
    if (game?.releases.some(r => r.version === manifest.version)) fail(409, 'version_exists', 'Deze versie bestaat al. Verhoog version in manifest.json.');
    if (game && game.releases.length >= quotaReleases) fail(409, 'quota_releases', `Een game mag ${quotaReleases} versies bewaren. Verwijder eerst oude versies.`);
    const now = tick();
    if (!game) {
      game = { id, title: manifest.title ?? id, owner: account.username, enabled: true, blocked: false, active_version: null, created_at: now, updated_at: now, releases: [] };
      state.games.set(id, game);
    }
    const created = { version: manifest.version, content_hash: contentHash(files), size: total, file_count: Object.keys(files).length, created_at: now, in_use: false, files };
    game.releases.push(created);
    if (!game.active_version || body.activate === true) game.active_version = created.version;
    game.updated_at = now;
    return [201, { game: view(game), release: release(game, created) }];
  }

  function route(method, path, req, body, query) {
    let m;
    if (method === 'GET' && path === '/api/health') return [200, { status: 'ok', version: state.version }];
    if (path.startsWith('/api/v1/admin/')) {
      requireAdmin(req);
      if (method === 'POST' && path === '/api/v1/admin/dev-tokens') {
        if (!state.accounts.has(body?.username)) fail(404, 'account_not_found', 'Dit account bestaat niet.');
        const days = body.expires_in_days ?? null;
        const token = issueToken(body.username, { label: body.label ?? 'cli', expires_at: days ? clock + days * 86400 : null });
        const account = state.accounts.get(body.username);
        return [201, { id: token.id, token: token.token, username: token.username, display_name: account.display_name, label: token.label, created_at: token.created_at, expires_at: token.expires_at }];
      }
      if (method === 'GET' && path === '/api/v1/admin/dev-tokens') {
        return [200, { tokens: state.tokens.map(({ token, ...rest }) => ({ ...rest, display_name: state.accounts.get(rest.username).display_name })) }];
      }
      if (method === 'DELETE' && (m = /^\/api\/v1\/admin\/dev-tokens\/([^/]+)$/.exec(path))) {
        const token = state.tokens.find(t => t.id === decodeURIComponent(m[1]));
        if (!token) fail(404, 'token_not_found', 'Deze dev key bestaat niet.');
        token.revoked_at = tick();
        return [204];
      }
      if (method === 'POST' && (m = /^\/api\/v1\/admin\/accounts\/([^/]+)\/verify-email$/.exec(path))) {
        const account = state.accounts.get(decodeURIComponent(m[1]));
        if (!account) fail(404, 'account_not_found', 'Dit account bestaat niet.');
        account.email_verified = true;
        return [200, { username: account.username, email: `${account.username}@example.com`, email_verified: true }];
      }
      if (method === 'GET' && path === '/api/v1/admin/accounts') {
        const q = (query.get('q') ?? '').trim().toLowerCase();
        const accounts = [...state.accounts.values()]
          .filter(a => !q || a.username.includes(q) || a.display_name.toLowerCase().includes(q))
          .sort((a, b) => a.username.localeCompare(b.username))
          .slice(0, 50)
          .map(accountView);
        return [200, { accounts }];
      }
      if (method === 'PUT' && (m = /^\/api\/v1\/admin\/accounts\/([^/]+)\/admin$/.exec(path))) {
        const account = findAccount(m[1]);
        if (typeof body?.admin !== 'boolean') fail(400, 'bad_request', 'admin moet true of false zijn.');
        account.admin = body.admin;
        return [200, accountView(account)];
      }
      if (method === 'PUT' && (m = /^\/api\/v1\/admin\/accounts\/([^/]+)\/game-limit$/.exec(path))) {
        const account = findAccount(m[1]);
        const limit = body?.game_limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'bad_request', 'De gamelimiet is een heel getal van 1 tot 100.');
        account.game_limit = limit;
        return [200, accountView(account)];
      }
      if (method === 'GET' && path === '/api/v1/admin/games') return [200, { games: [...state.games.values()].map(adminView) }];
      if (method === 'PUT' && (m = /^\/api\/v1\/admin\/games\/([^/]+)$/.exec(path))) {
        const game = state.games.get(decodeURIComponent(m[1]));
        if (!game) fail(404, 'game_not_found', 'Deze game bestaat niet.');
        game.enabled = body.enabled === true;
        game.blocked = !game.enabled;
        return [200, adminView(game)];
      }
      fail(404, 'not_found', 'Onbekende route.');
    }
    if (path.startsWith('/api/v1/dev/')) {
      const { account, token } = devAccount(req);
      if (method === 'GET' && path === '/api/v1/dev/me') {
        return [200, { account, token: { id: token.id, label: token.label, expires_at: token.expires_at } }];
      }
      if (method === 'GET' && path === '/api/v1/dev/games') {
        return [200, { games: [...state.games.values()].filter(g => g.owner === account.username).map(view) }];
      }
      if ((m = /^\/api\/v1\/dev\/games\/([^/]+)\/versions$/.exec(path)) && method === 'POST') return upload(account, decodeURIComponent(m[1]), body);
      if ((m = /^\/api\/v1\/dev\/games\/([^/]+)\/versions\/([^/]+)\/activate$/.exec(path)) && method === 'POST') {
        const game = ownGame(account, decodeURIComponent(m[1]));
        const version = decodeURIComponent(m[2]);
        if (!game.releases.some(r => r.version === version)) fail(404, 'release_not_found', 'Deze versie bestaat niet.');
        game.active_version = version;
        return [200, view(game)];
      }
      if ((m = /^\/api\/v1\/dev\/games\/([^/]+)\/versions\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        const game = ownGame(account, decodeURIComponent(m[1]));
        const version = decodeURIComponent(m[2]);
        const index = game.releases.findIndex(r => r.version === version);
        if (index < 0) fail(404, 'release_not_found', 'Deze versie bestaat niet.');
        if (game.active_version === version) fail(409, 'release_active', 'De actieve versie kan niet worden verwijderd.');
        if (game.releases[index].in_use) fail(409, 'release_in_use', 'Een lopende room gebruikt deze versie.');
        game.releases.splice(index, 1);
        return [204];
      }
      if ((m = /^\/api\/v1\/dev\/games\/([^/]+)$/.exec(path))) {
        const game = ownGame(account, decodeURIComponent(m[1]));
        if (method === 'GET') return [200, view(game)];
        if (method === 'PUT') {
          if (typeof body?.enabled !== 'boolean') fail(400, 'invalid_request', 'enabled ontbreekt.');
          if (game.blocked && body.enabled) fail(403, 'game_blocked', 'De beheerder heeft deze game geblokkeerd.');
          game.enabled = body.enabled;
          return [200, view(game)];
        }
        if (method === 'DELETE') {
          if (game.releases.some(r => r.in_use)) fail(409, 'game_in_use', 'Een lopende room gebruikt deze game.');
          state.games.delete(game.id);
          return [204];
        }
      }
    }
    fail(404, 'not_found', 'Onbekende route.');
  }

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= 16 * MiB) chunks.push(chunk);
    });
    req.on('end', () => {
      const send = (status, data) => {
        res.writeHead(status, data === undefined ? {} : { 'content-type': 'application/json' });
        res.end(data === undefined ? undefined : JSON.stringify(data));
      };
      try {
        if (size > 16 * MiB) fail(413, 'payload_too_large', 'De upload is groter dan 16 MiB.');
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            fail(400, 'invalid_json', 'Ongeldige JSON.');
          }
        }
        const { pathname: path, searchParams } = new URL(req.url, 'http://x');
        state.requests.push({ method: req.method, path, query: Object.fromEntries(searchParams), body, authorization: req.headers.authorization });
        const [status, data] = route(req.method, path, req, body, searchParams);
        send(status, data);
      } catch (error) {
        if (error instanceof HttpError) send(error.status, { error: { code: error.code, message: error.message } });
        else send(500, { error: { code: 'internal_error', message: error.message } });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    addAccount,
    issueToken,
    game: id => state.games.get(id),
    setInUse(id, version, value = true) {
      state.games.get(id).releases.find(r => r.version === version).in_use = value;
    },
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
