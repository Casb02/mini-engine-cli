import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const MiB = 1024 * 1024;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const MAX_INVITES = 50;
const INVALID_JSON = 'Stuur geldige JSON met de verwachte velden en Content-Type application/json.';

// True for a version before major.minor, and for a missing or unreadable one.
function before(version, major, minor) {
  const parts = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!parts) return true;
  return Number(parts[1]) < major || (Number(parts[1]) === major && Number(parts[2]) < minor);
}

// Usernames as the engine reads them: trimmed, ASCII lowercase.
const normalizeUsername = name => String(name).trim().replace(/[A-Z]/g, c => c.toLowerCase());

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
  const state = { accounts: new Map(), tokens: [], games: new Map(), featured: [], mediaRequests: [], requests: [], adminToken, version };

  const addAccount = username => {
    const account = { id: randomUUID(), username, display_name: username[0].toUpperCase() + username.slice(1), admin: false, email_verified: false, created_at: clock, game_limit: quotaGames, media_used: 0, media_limit: null };
    state.accounts.set(username, account);
    return account;
  };
  const issueToken = (username, { label = 'cli', expires_at = null } = {}) => {
    const token = { id: randomUUID(), token: `med_${randomBytes(32).toString('hex')}`, username, label, created_at: tick(), expires_at, last_used_at: null, revoked_at: null };
    state.tokens.unshift(token);
    return token;
  };

  const addMediaRequest = (username, message = '') => {
    const request = { id: state.mediaRequests.length + 1, username, message, requested_at: tick(), status: 'pending', decided_at: null, granted_mb: null };
    for (const open of state.mediaRequests) if (open.username === username && open.status === 'pending') open.status = 'replaced';
    state.mediaRequests.push(request);
    return request;
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
  // Private games and invites arrived in Mini Engine 0.9. Below that (or without a version) the fake
  // answers like 0.8.1: no private or invites in a game, 422 invalid_json for a private field, and
  // 404 not_found on the invite routes.
  const privateGames = () => !before(state.version, 0, 9);
  const view = game => ({
    id: game.id,
    title: game.title,
    enabled: game.enabled,
    blocked: game.blocked,
    ...(privateGames() ? { private: game.private, invites: game.invites.length } : {}),
    active_version: game.active_version,
    created_at: game.created_at,
    updated_at: game.updated_at,
    versions: game.releases.map(r => release(game, r)),
  });
  const adminView = game => {
    const owner = state.accounts.get(game.owner);
    return { ...view(game), owner: { id: owner.id, username: owner.username, display_name: owner.display_name } };
  };
  const inviteView = game => ({
    private: game.private,
    invites: game.invites
      .map(invite => {
        const account = state.accounts.get(invite.username);
        return { username: account.username, display_name: account.display_name, invited_at: invite.invited_at };
      })
      .sort((a, b) => a.username.localeCompare(b.username)),
  });
  const knownAccount = name => {
    if (!state.accounts.has(name)) fail(404, 'account_not_found', `Er is geen account met de gebruikersnaam ${name}.`);
    return state.accounts.get(name);
  };

  function invite(game, body) {
    const given = body?.usernames;
    if (!body || Object.keys(body).some(field => field !== 'usernames') || !Array.isArray(given) || given.some(name => typeof name !== 'string')) {
      fail(422, 'invalid_json', INVALID_JSON);
    }
    const names = [...new Set(given.map(normalizeUsername))];
    if (!names.length || names.length > MAX_INVITES) fail(400, 'invalid_request', `Nodig 1 tot ${MAX_INVITES} accounts tegelijk uit.`);
    for (const name of names) {
      knownAccount(name);
      if (name === game.owner) fail(400, 'invalid_request', 'Dit is je eigen game; die kun je altijd starten.');
    }
    const added = names.filter(name => !game.invites.some(invite => invite.username === name));
    if (game.invites.length + added.length > MAX_INVITES) {
      fail(409, 'quota_invites', `Een game heeft hoogstens ${MAX_INVITES} uitnodigingen, en deze heeft er al ${game.invites.length}. Trek er eerst een in.`);
    }
    const now = tick();
    for (const name of added) game.invites.push({ username: name, invited_at: now });
    return [200, { ...inviteView(game), added }];
  }

  // Going private takes a game off the featured list, as the engine does in the same transaction.
  const setPrivate = (game, value) => {
    game.private = value;
    if (value) state.featured = state.featured.filter(id => id !== game.id);
  };

  const ownedGames = username => [...state.games.values()].filter(g => g.owner === username).length;
  const workingKeys = username => state.tokens.filter(t => t.username === username && !t.revoked_at && !(t.expires_at && t.expires_at < clock)).length;
  // Without a choice of an admin, the role decides: 1 GiB for an admin, 250 MiB with a working dev key, else nothing.
  const mediaLimit = account => account.media_limit ?? (account.admin ? 1024 : workingKeys(account.username) ? 250 : 0);
  const accountView = account => ({
    username: account.username,
    display_name: account.display_name,
    admin: account.admin,
    email_verified: account.email_verified,
    created_at: account.created_at,
    games: ownedGames(account.username),
    game_limit: account.game_limit,
    dev_keys: workingKeys(account.username),
    media_used: account.media_used,
    media_limit_mb: mediaLimit(account),
    media_limit_custom: account.media_limit !== null,
  });
  const requestView = r => ({ id: r.id, status: r.status, message: r.message, requested_at: r.requested_at, decided_at: r.decided_at, granted_mb: r.granted_mb });
  const MAX_MEDIA_MB = 1048576;
  const grantOpen = (account, mb) => {
    for (const r of state.mediaRequests) {
      if (r.username === account.username && r.status === 'pending') Object.assign(r, { status: 'granted', decided_at: tick(), granted_mb: mb });
    }
  };
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
    if (!game || game.owner !== account.username) fail(404, 'game_not_found', 'Je hebt geen game met dit id.');
    return game;
  };

  function upload(account, id, body) {
    if (body?.private !== undefined && (!privateGames() || typeof body.private !== 'boolean')) fail(422, 'invalid_json', INVALID_JSON);
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
      // A new private game is private from the start, like the INSERT of the engine.
      game = { id, title: manifest.title ?? id, owner: account.username, enabled: true, blocked: false, private: body.private === true, invites: [], active_version: null, created_at: now, updated_at: now, releases: [] };
      state.games.set(id, game);
    } else if (body.private !== undefined) setPrivate(game, body.private);
    const created = { version: manifest.version, content_hash: contentHash(files), size: total, file_count: Object.keys(files).length, created_at: now, in_use: false, files };
    game.releases.push(created);
    if (!game.active_version || body.activate === true) game.active_version = created.version;
    game.updated_at = now;
    return [201, { game: view(game), release: release(game, created) }];
  }

  function route(method, path, req, body, query) {
    let m;
    if (method === 'GET' && path === '/api/health') return [200, { status: 'ok', version: state.version }];
    // The public list, as a visitor sees it: only enabled public games, and the featured ones among them.
    if (method === 'GET' && path === '/api/v1/games') {
      const games = [...state.games.values()].filter(game => game.enabled && !game.blocked && !game.private);
      return [200, { games: games.map(game => ({ id: game.id, title: game.title, version: game.active_version })), featured: state.featured.filter(id => games.some(game => game.id === id)) }];
    }
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
        if (typeof body?.admin !== 'boolean') fail(400, 'invalid_request', 'admin moet true of false zijn.');
        account.admin = body.admin;
        return [200, accountView(account)];
      }
      if (method === 'PUT' && (m = /^\/api\/v1\/admin\/accounts\/([^/]+)\/game-limit$/.exec(path))) {
        const account = findAccount(m[1]);
        const limit = body?.game_limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_request', 'De gamelimiet is een heel getal van 1 tot 100.');
        account.game_limit = limit;
        return [200, accountView(account)];
      }
      if (method === 'PUT' && (m = /^\/api\/v1\/admin\/accounts\/([^/]+)\/media-limit$/.exec(path))) {
        const account = findAccount(m[1]);
        const mb = body?.media_limit_mb;
        if (mb !== null && (!Number.isInteger(mb) || mb < 0 || mb > MAX_MEDIA_MB)) fail(400, 'invalid_request', 'De ruimte is een heel aantal MB van 0 tot 1048576, of null.');
        account.media_limit = mb;
        if (mb > 0) grantOpen(account, mb);
        return [200, accountView(account)];
      }
      if (method === 'GET' && path === '/api/v1/admin/media-requests') {
        const requests = state.mediaRequests
          .filter(r => r.status === 'pending')
          .map(r => {
            const account = state.accounts.get(r.username);
            return { id: r.id, username: r.username, display_name: account.display_name, message: r.message, requested_at: r.requested_at, media_used: account.media_used, media_limit_mb: mediaLimit(account) };
          });
        return [200, { requests }];
      }
      if (method === 'POST' && (m = /^\/api\/v1\/admin\/media-requests\/([^/]+)$/.exec(path))) {
        const decision = body?.decision;
        const mb = body?.media_limit_mb;
        if (decision === 'grant' && !(Number.isInteger(mb) && mb >= 1 && mb <= MAX_MEDIA_MB)) fail(400, 'invalid_request', 'Kies hoeveel ruimte je geeft: een heel aantal MB van 1 tot 1048576.');
        if (!(decision === 'grant' || (decision === 'reject' && mb === undefined))) fail(400, 'invalid_request', 'decision is grant met media_limit_mb, of reject.');
        const request = state.mediaRequests.find(r => String(r.id) === decodeURIComponent(m[1]));
        if (!request || request.status === 'replaced') fail(404, 'media_request_not_found', 'Deze aanvraag voor ruimte bestaat niet.');
        if (request.status !== 'pending') fail(409, 'media_request_decided', 'Over deze aanvraag is al beslist.');
        const account = state.accounts.get(request.username);
        if (decision === 'grant') {
          account.media_limit = mb;
          grantOpen(account, mb);
        } else Object.assign(request, { status: 'rejected', decided_at: tick() });
        return [200, { request: requestView(request), account: accountView(account) }];
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
      if (privateGames() && (m = /^\/api\/v1\/dev\/games\/([^/]+)\/invites$/.exec(path))) {
        const game = ownGame(account, decodeURIComponent(m[1]));
        if (method === 'GET') return [200, inviteView(game)];
        if (method === 'POST') return invite(game, body);
      }
      if (privateGames() && (m = /^\/api\/v1\/dev\/games\/([^/]+)\/invites\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        const game = ownGame(account, decodeURIComponent(m[1]));
        const { username } = knownAccount(normalizeUsername(decodeURIComponent(m[2])));
        const index = game.invites.findIndex(invite => invite.username === username);
        if (index < 0) fail(404, 'invite_not_found', `@${username} is niet uitgenodigd voor deze game.`);
        game.invites.splice(index, 1);
        return [204];
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
          if (!privateGames()) {
            if (body?.private !== undefined) fail(422, 'invalid_json', INVALID_JSON);
            if (typeof body?.enabled !== 'boolean') fail(400, 'invalid_request', 'enabled ontbreekt.');
          } else {
            const fields = Object.keys(body ?? {});
            if (!body || fields.some(field => !['enabled', 'private'].includes(field) || typeof body[field] !== 'boolean')) fail(422, 'invalid_json', INVALID_JSON);
            if (!fields.length) fail(400, 'invalid_request', 'Geef enabled of private mee.');
          }
          if (game.blocked && body.enabled) fail(403, 'game_blocked', 'De beheerder heeft deze game geblokkeerd.');
          if (body.enabled !== undefined) game.enabled = body.enabled;
          if (body.private !== undefined) setPrivate(game, body.private);
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
    addMediaRequest,
    issueToken,
    game: id => state.games.get(id),
    feature(ids) {
      state.featured = [...ids];
    },
    setInUse(id, version, value = true) {
      state.games.get(id).releases.find(r => r.version === version).in_use = value;
    },
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
