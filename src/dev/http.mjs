import { readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { PACKAGE } from '../vendor.mjs';
import { roomCode } from './engine.mjs';
import { asEngineError, assetNotFound, EngineError, gameNotFound, invalidJson, notFound, unauthorized } from './errors.mjs';
import { isObject, parseJson, stringify } from './json.mjs';
import { readField, serveRoomSocket } from './socket.mjs';
import { acceptWebSocket, handshakeProblem } from './websocket.mjs';

const BODY_LIMIT = 96 * 1024;
const MAX_SOCKETS = 1024;
const WEB = new URL('./web/', import.meta.url);
const FONTS = new URL('../../vendor/skills/mini-engine-ui/kit/ui/fonts/', import.meta.url);
const SDK = new URL('../../vendor/sdk/', import.meta.url);

const MIME = {
  aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', apng: 'image/apng', avif: 'image/avif', avi: 'video/x-msvideo',
  bin: 'application/octet-stream', bmp: 'image/bmp', css: 'text/css', csv: 'text/csv', dae: 'model/vnd.collada+xml',
  eot: 'application/vnd.ms-fontobject', flac: 'audio/flac', gif: 'image/gif', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  gz: 'application/gzip', hdr: 'image/vnd.radiance', htm: 'text/html', html: 'text/html', ico: 'image/x-icon', jfif: 'image/jpeg',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', js: 'text/javascript', json: 'application/json', jsonld: 'application/ld+json',
  jsx: 'text/javascript', ktx: 'image/ktx', m4a: 'audio/m4a', m4v: 'video/x-m4v', map: 'text/plain', md: 'text/markdown',
  mid: 'audio/mid', midi: 'audio/mid', mjs: 'application/javascript', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', oga: 'audio/ogg', ogg: 'audio/ogg', ogv: 'video/ogg',
  opus: 'audio/ogg', otf: 'application/font-sfnt', pdf: 'application/pdf', png: 'image/png', svg: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff', ts: 'video/vnd.dlna.mpeg-tts', ttc: 'font/collection', ttf: 'font/ttf', txt: 'text/plain',
  vtt: 'text/vtt', wasm: 'application/wasm', wav: 'audio/wav', weba: 'audio/webm', webm: 'video/webm',
  webmanifest: 'application/manifest+json', webp: 'image/webp', woff: 'application/font-woff', woff2: 'font/woff2',
  xhtml: 'application/xhtml+xml', xml: 'text/xml', zip: 'application/zip', '3gp': 'video/3gpp', '7z': 'application/x-7z-compressed',
};

export function mimeOf(path) {
  const name = path.split('/').pop();
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

const SHAPES = {
  create: { game_id: 'string', max_players: 'usize?', settings: 'value?', config: 'value?', name: 'string?', set_id: 'string?' },
  join: { name: 'string' },
  configure: { expected_version: 'u64', config: 'value' },
  ready: { ready: 'bool' },
  action: { name: 'string', data: 'value?', action_id: 'string?' },
  state: { expected_version: 'u64', public_state: 'value', host_state: 'value?', player_states: 'object?' },
  settings: { expected_version: 'u64', settings: 'value' },
  lifecycle: { status: 'status' },
  award: { player_id: 'string', achievement_id: 'string' },
};

const csp = (frameAncestors, frameSrc = "'self'") =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${frameSrc}; frame-ancestors ${frameAncestors}; base-uri 'none'; object-src 'none'`;

export function publicMetadata(metadata) {
  const keys = ['id', 'title', 'description', 'version', 'min_players', 'max_players', 'has_display', 'supports_late_join', 'default_settings', 'settings_schema', 'runtime', 'host_modes', 'default_host_mode', 'achievements', 'set_kinds'];
  return Object.fromEntries(keys.map(key => [key, metadata[key]]));
}

function web(name) {
  return readFileSync(new URL(name, WEB));
}

function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map(part => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      if (part.startsWith('*')) {
        names.push(part.slice(1));
        return '(.+)';
      }
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new EngineError(400, 'invalid_request', 'Ongeldig pad.');
  }
}

function bearer(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ') || value.length === 7) throw unauthorized();
  return value.slice(7);
}

async function readBody(req, shape) {
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mime !== 'application/json' && !/^application\/[^/]+\+json$/.test(mime)) throw invalidJson(415);
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw invalidJson(413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw invalidJson(413);
    chunks.push(chunk);
  }
  let value;
  try {
    value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw invalidJson(400);
  }
  if (!isObject(value) || Object.keys(value).some(key => !Object.hasOwn(shape, key))) throw invalidJson(422);
  const out = {};
  try {
    for (const [name, kind] of Object.entries(shape)) out[name] = readField(value, name, kind);
  } catch {
    throw invalidJson(422);
  }
  return out;
}

const json = (status, value) => ({ status, type: 'application/json', body: stringify(value) });
const bytes = (body, type) => ({ status: 200, type, body });
const empty = () => ({ status: 204 });

export function createApp({ engine, project, session, launcherPort }) {
  const sockets = new Set();
  const streams = new Set();
  const launcherOrigins = () => [`http://127.0.0.1:${launcherPort()}`, `http://localhost:${launcherPort()}`];
  const engineCsp = () => csp(`'self' ${launcherOrigins().join(' ')}`);
  const launcherCsp = () => `${csp("'none'", 'http://127.0.0.1:* http://localhost:*')}; font-src 'self'`;

  function headers(contentType, policy = engineCsp()) {
    const out = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'content-security-policy': policy,
    };
    if (contentType) out['content-type'] = contentType;
    return out;
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    const host = req.headers.host ?? '';
    if (origin !== `http://${host}` && origin !== `https://${host}`) {
      throw new EngineError(403, 'origin_forbidden', 'Deze browser-origin is niet toegestaan.');
    }
  }

  function metadataFor(id) {
    if (project.metadata.id !== id) throw gameNotFound();
    return project.metadata;
  }

  function asset(path) {
    if (!path.startsWith('assets/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw assetNotFound();
    }
    const content = project.asset(path);
    if (!content) throw assetNotFound();
    return bytes(content, mimeOf(path));
  }

  const routes = [
    ['GET', '/api/health', () => json(200, { status: 'ok', version: PACKAGE.version, dev: true })],
    ['GET', '/api/v1/games', () => json(200, { games: [publicMetadata(project.metadata)] })],
    ['GET', '/api/v1/games/:id', ({ id }) => json(200, publicMetadata(metadataFor(id)))],
    [
      'GET',
      '/api/v1/games/:id/:role',
      ({ id, role }, { query }) => {
        let pinned = null;
        const room = query.get('room');
        if (room !== null) {
          try {
            const info = engine.info(room);
            if (info.game_id === id) pinned = info.game_version;
          } catch {
            pinned = null;
          }
        }
        if (pinned === null) metadataFor(id);
        else if (project.metadata.id !== id) throw gameNotFound();
        let html = project.html(role);
        if (html === undefined) throw notFound('game_page_not_found', 'This game role page does not exist.');
        if (pinned !== null) html = html.replaceAll(`/games/${id}/assets/`, `/releases/${id}/${pinned}/assets/`);
        return bytes(html, 'text/html; charset=utf-8');
      },
    ],
    [
      'GET',
      '/games/:id/*path',
      ({ id, path }) => {
        metadataFor(id);
        return asset(path);
      },
    ],
    [
      'GET',
      '/releases/:id/:version/*path',
      ({ id, version, path }) => {
        const active = project.metadata.id === id && project.metadata.version === version;
        if (!active && !engine.pinnedVersions(id).has(version)) throw assetNotFound();
        if (project.metadata.id !== id) throw gameNotFound();
        return asset(path);
      },
    ],
    [
      'POST',
      '/api/v1/rooms',
      async (_, { req }) => {
        const input = await readBody(req, SHAPES.create);
        if (req.headers.authorization !== undefined) bearer(req);
        return json(201, engine.createRoom(input));
      },
    ],
    ['GET', '/api/v1/rooms/:code', ({ code }, { req }) => json(200, engine.snapshot(code, bearer(req)))],
    [
      'DELETE',
      '/api/v1/rooms/:code',
      ({ code }, { req }) => {
        engine.delete(code, bearer(req));
        return empty();
      },
    ],
    ['GET', '/api/v1/rooms/:code/info', ({ code }) => json(200, engine.info(code))],
    [
      'POST',
      '/api/v1/rooms/:code/join',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.join);
        engine.info(code);
        if (req.headers.authorization !== undefined) bearer(req);
        return json(201, engine.join(code, input.name));
      },
    ],
    [
      'POST',
      '/api/v1/rooms/:code/leave',
      ({ code }, { req }) => {
        engine.leave(code, bearer(req));
        return empty();
      },
    ],
    [
      'PUT',
      '/api/v1/rooms/:code/state',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.state);
        return json(200, engine.setState(code, bearer(req), input));
      },
    ],
    [
      'PUT',
      '/api/v1/rooms/:code/settings',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.settings);
        const token = bearer(req);
        engine.checkSettings(code, token, input.settings);
        return json(200, engine.settings(code, token, input));
      },
    ],
    [
      'PUT',
      '/api/v1/rooms/:code/config',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.configure);
        return json(200, engine.configurePatch(code, bearer(req), input.expected_version, input.config));
      },
    ],
    [
      'POST',
      '/api/v1/rooms/:code/ready',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.ready);
        return json(200, engine.ready(code, bearer(req), input.ready));
      },
    ],
    [
      'POST',
      '/api/v1/rooms/:code/actions',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.action);
        const token = bearer(req);
        engine.action(code, token, input.name, input.data, null, input.action_id);
        return json(200, engine.snapshot(code, token));
      },
    ],
    ['POST', '/api/v1/rooms/:code/display-token', ({ code }, { req }) => json(200, { token: engine.displayToken(code, bearer(req)) })],
    [
      'POST',
      '/api/v1/rooms/:code/lifecycle',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.lifecycle);
        return json(200, engine.lifecycle(code, bearer(req), input.status));
      },
    ],
    [
      'DELETE',
      '/api/v1/rooms/:code/players/:player',
      ({ code, player }, { req }) => {
        engine.kick(code, bearer(req), player);
        return empty();
      },
    ],
    ['GET', '/api/v1/rooms/:code/game-data', ({ code }, { req }) => json(200, engine.gameData(code, bearer(req)))],
    [
      'POST',
      '/api/v1/rooms/:code/achievements',
      async ({ code }, { req }) => {
        const input = await readBody(req, SHAPES.award);
        return json(200, engine.award(code, bearer(req), input.player_id, input.achievement_id));
      },
    ],
    ['GET', '/api/v1/rooms/:code/ws', (_, { req }) => ({ status: 400, type: 'text/plain; charset=utf-8', body: handshakeProblem(req) ?? 'WebSocket request could not be upgraded' })],
    ['GET', '/sdk/mini-engine.js', () => bytes(readFileSync(new URL('dist/mini-engine.js', SDK)), 'text/javascript')],
    ['GET', '/sdk/mini-engine.d.ts', () => bytes(readFileSync(new URL('types/mini-engine.d.ts', SDK)), 'text/plain; charset=utf-8')],
    [
      'GET',
      '/room/:code/:role',
      ({ role }) => {
        if (!['host', 'player', 'display'].includes(role)) throw notFound('not_found', 'Niet gevonden.');
        return bytes(web('seat.html'), 'text/html; charset=utf-8');
      },
    ],
    ['GET', '/__me/seat.js', () => bytes(web('seat.js'), 'text/javascript')],
    ['GET', '/__me/favicon.svg', () => bytes(web('favicon.svg'), 'image/svg+xml')],
    ['GET', '/__me/seat.css', () => bytes(web('seat.css'), 'text/css')],
    [
      'GET',
      '/__me/fonts/:name',
      ({ name }) => {
        if (!['dm-sans.woff2', 'space-grotesk.woff2'].includes(name)) throw notFound('not_found', 'Niet gevonden.');
        return bytes(readFileSync(new URL(name, FONTS)), 'font/woff2');
      },
    ],
    [
      'GET',
      '/',
      (_, { req, launcher }) => {
        if (launcher) return { ...bytes(web('launcher.html'), 'text/html; charset=utf-8'), policy: launcherCsp() };
        const host = String(req.headers.host ?? '127.0.0.1').replace(/:\d+$/, '');
        return { status: 307, location: `http://${host}:${launcherPort()}/` };
      },
    ],
  ].map(([method, pattern, handler]) => ({ method, ...compile(pattern), handler }));

  const devRoutes = [
    ['GET', '/__me/launcher.js', () => bytes(web('launcher.js'), 'text/javascript')],
    ['GET', '/__me/launcher.css', () => bytes(web('launcher.css'), 'text/css')],
    ['GET', '/__me/state', () => json(200, session().state())],
    ['GET', '/__me/events', (_, { req, res }) => ({ stream: () => openStream(req, res) })],
    ['POST', '/__me/room', async () => json(200, await session().newRoom())],
    ['POST', '/__me/players', async () => json(200, await session().addPlayer())],
  ].map(([method, pattern, handler]) => ({ method, ...compile(pattern), handler }));

  function openStream(req, res) {
    res.writeHead(200, { ...headers('text/event-stream; charset=utf-8', launcherCsp()), connection: 'keep-alive' });
    const stream = {
      send(event, data) {
        res.write(`event: ${event}\ndata: ${stringify(data)}\n\n`);
      },
      end() {
        res.end();
      },
    };
    streams.add(stream);
    stream.send('state', session().state());
    const keepAlive = setInterval(() => res.write(': ok\n\n'), 15000);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      streams.delete(stream);
    });
  }

  function find(list, method, path) {
    let allowed = false;
    for (const route of list) {
      const match = route.regex.exec(path);
      if (!match) continue;
      if (route.method === method || (route.method === 'GET' && method === 'HEAD')) {
        return { route, params: Object.fromEntries(route.names.map((name, index) => [name, decode(match[index + 1])])) };
      }
      allowed = true;
    }
    return allowed ? 'method' : null;
  }

  function send(res, result, method) {
    if (result.status === 307) {
      res.writeHead(307, { ...headers(), location: result.location });
      res.end();
      return;
    }
    const out = headers(result.type, result.policy);
    if (result.body === undefined) {
      res.writeHead(result.status, out);
      res.end();
      return;
    }
    const body = typeof result.body === 'string' ? Buffer.from(result.body) : result.body;
    res.writeHead(result.status, { ...out, 'content-length': body.length });
    res.end(method === 'HEAD' ? undefined : body);
  }

  async function request(req, res) {
    const method = req.method ?? 'GET';
    const index = req.url.indexOf('?');
    const path = index >= 0 ? req.url.slice(0, index) : req.url;
    const query = new URLSearchParams(index >= 0 ? req.url.slice(index + 1) : '');
    const launcher = req.socket.localPort === launcherPort();
    try {
      checkOrigin(req);
      let found = launcher ? find(devRoutes, method, path) : null;
      if (!found || found === 'method') {
        const engineRoute = find(routes, method, path);
        if (engineRoute !== null) found = engineRoute;
      }
      if (found === 'method') throw new EngineError(405, 'method_not_allowed', 'Deze HTTP-methode is niet toegestaan.');
      if (!found) throw notFound('not_found', 'Niet gevonden.');
      const result = await found.route.handler(found.params, { req, res, query, launcher });
      if (result.stream) return result.stream();
      send(res, result, method);
    } catch (error) {
      const failure = asEngineError(error);
      if (failure.status === 500) console.error(error);
      if (res.headersSent) return res.destroy();
      if (failure.status === 413) res.setHeader('connection', 'close');
      send(res, { status: failure.status, type: 'application/json', body: stringify({ error: failure }) }, method);
    }
  }

  function rawRespond(socket, status, type, body) {
    const out = { ...headers(type), 'content-length': Buffer.byteLength(body), connection: 'close' };
    const head = [`HTTP/1.1 ${status} ${STATUS_CODES[status]}`, ...Object.entries(out).map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n');
    socket.end(head + body);
  }

  function upgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    const index = req.url.indexOf('?');
    const path = index >= 0 ? req.url.slice(0, index) : req.url;
    const fail = error => {
      const failure = asEngineError(error);
      rawRespond(socket, failure.status, 'application/json', stringify({ error: failure }));
    };
    try {
      checkOrigin(req);
      const match = /^\/api\/v1\/rooms\/([^/]+)\/ws$/.exec(path);
      if (!match) throw notFound('not_found', 'Niet gevonden.');
      const problem = handshakeProblem(req);
      if (problem) return rawRespond(socket, 400, 'text/plain; charset=utf-8', problem);
      const code = decode(match[1]);
      engine.info(code);
      if (sockets.size >= MAX_SOCKETS) throw new EngineError(503, 'connection_limit', 'Te veel verbindingen. Probeer later opnieuw.');
      const ws = acceptWebSocket(req, socket, head);
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      serveRoomSocket(ws, engine, roomCode(code));
    } catch (error) {
      fail(error);
    }
  }

  function broadcast(event, data) {
    for (const stream of streams) stream.send(event, data);
  }

  function shutdown() {
    for (const stream of streams) stream.end();
    streams.clear();
    for (const ws of sockets) ws.finish();
  }

  return { request, upgrade, broadcast, shutdown, sockets };
}
