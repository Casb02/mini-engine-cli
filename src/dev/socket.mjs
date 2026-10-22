import { performance } from 'node:perf_hooks';
import { asEngineError, bad, EngineError, unauthorized } from './errors.mjs';
import { isObject, parseJson, stringify } from './json.mjs';
import { isRealtime, Limiter } from './realtime.mjs';

const AUTH_TIMEOUT = 5000;
const HEARTBEAT = 15000;
const SILENCE = 45000;
const STATUSES = ['lobby', 'running', 'finished'];
const U64_MAX = 18446744073709551615;
const CHANGES = new Set(['action', 'set_state', 'lifecycle', 'settings', 'ready', 'configure']);

const COMMANDS = {
  auth: { token: 'string' },
  action: { name: 'string', data: 'value?', request_id: 'string?', action_id: 'string?' },
  set_state: { expected_version: 'u64', public_state: 'value', host_state: 'value?', player_states: 'object?', request_id: 'string?' },
  lifecycle: { status: 'status', request_id: 'string?' },
  settings: { expected_version: 'u64', settings: 'value', request_id: 'string?' },
  ping: { request_id: 'string?' },
  ready: { ready: 'bool', request_id: 'string?' },
  configure: { expected_version: 'u64', config: 'value', request_id: 'string?' },
  award: { player_id: 'string', achievement_id: 'string', request_id: 'string?' },
};

export function readField(source, name, kind) {
  const present = Object.hasOwn(source, name);
  const value = source[name];
  const optional = kind.endsWith('?');
  const base = optional ? kind.slice(0, -1) : kind;
  if (!present) {
    if (!optional) throw new Error(`missing ${name}`);
    return base === 'object' ? {} : null;
  }
  const valid =
    base === 'string' ? typeof value === 'string' || (optional && value === null)
    : base === 'u64' || base === 'usize' ? (Number.isInteger(value) && value >= 0 && value <= U64_MAX) || (optional && value === null)
    : base === 'bool' ? typeof value === 'boolean'
    : base === 'status' ? STATUSES.includes(value)
    : base === 'object' ? isObject(value)
    : true;
  if (!valid) throw new Error(`invalid ${name}`);
  return value;
}

export function parseCommand(raw) {
  if (!isObject(raw) || typeof raw.type !== 'string' || !Object.hasOwn(COMMANDS, raw.type)) throw new Error('unknown command');
  const command = { type: raw.type };
  for (const [name, kind] of Object.entries(COMMANDS[raw.type])) command[name] = readField(raw, name, kind);
  return command;
}

export function serveRoomSocket(ws, engine, code) {
  let state = 'auth';
  let token;
  let attachment;
  let heartbeat;
  let seen = performance.now();
  let bucket = performance.now();
  let messages = 0;
  let draining = false;
  const limiter = new Limiter();
  const queue = [];
  const subscriber = {
    push(event) {
      queue.push(event);
      if (!draining) {
        draining = true;
        setImmediate(drain);
      }
    },
  };

  const send = value => ws.sendText(typeof value === 'string' ? value : stringify(value));
  const sendError = (requestId, error) => send({ type: 'error', request_id: requestId ?? null, error: asEngineError(error) });

  function finish() {
    if (state === 'done') return;
    state = 'done';
    clearTimeout(authTimer);
    clearInterval(heartbeat);
    if (attachment) engine.detach(code, attachment, subscriber);
  }

  function close(reason) {
    send({ type: 'closed', reason });
    ws.close();
    finish();
  }

  function refuse(error) {
    sendError(null, error);
    ws.close();
    finish();
  }

  const authTimer = setTimeout(() => {
    if (state === 'auth') refuse(new EngineError(401, 'auth_timeout', 'Authenticeer binnen vijf seconden.'));
  }, AUTH_TIMEOUT);

  function queuedCloseReason() {
    while (queue.length) {
      const event = queue.shift();
      if (event.type === 'closed') return event.reason;
    }
    return null;
  }

  function sendSnapshot() {
    let room;
    try {
      room = engine.snapshot(code, token);
    } catch {
      close(queuedCloseReason() ?? 'session_revoked');
      return false;
    }
    send({ type: 'snapshot', room });
    return true;
  }

  function drain() {
    draining = false;
    while (queue.length && state === 'open') {
      const event = queue.shift();
      if (event.type === 'closed') {
        close(event.reason);
        return;
      }
      if (!engine.isCurrent(code, attachment.identity, attachment.connection)) {
        const fallback = engine.canSnapshot(code, token) ? 'session_replaced' : 'session_revoked';
        close(queuedCloseReason() ?? fallback);
        return;
      }
      if (event.type === 'action') {
        if (attachment.identity.role === 'host') send(event.text);
      } else if (!sendSnapshot()) {
        return;
      }
    }
  }

  function tick() {
    if (state !== 'open') return;
    if (performance.now() - seen > SILENCE) {
      close('heartbeat_timeout');
      return;
    }
    const dropped = limiter.due();
    if (dropped !== null) send({ type: 'rt.throttled', dropped });
    try {
      engine.touch(code, token);
    } catch {
      close(queuedCloseReason() ?? 'session_revoked');
      return;
    }
    ws.ping();
  }

  function authenticate(text) {
    clearTimeout(authTimer);
    let command = null;
    try {
      command = parseCommand(parseJson(text));
    } catch {
      command = null;
    }
    if (command?.type !== 'auth') {
      refuse(unauthorized());
      return;
    }
    token = command.token;
    try {
      attachment = engine.attach(code, token, subscriber, text => {
        if (state === 'open') send(text);
      });
    } catch (error) {
      refuse(error);
      return;
    }
    state = 'open';
    if (!sendSnapshot()) return;
    send(attachment.values);
    heartbeat = setInterval(tick, HEARTBEAT);
    heartbeat.unref?.();
    tick();
  }

  function execute(command) {
    switch (command.type) {
      case 'action':
        return engine.action(code, token, command.name, command.data, command.request_id, command.action_id);
      case 'set_state':
        return engine.setState(code, token, {
          expected_version: command.expected_version,
          public_state: command.public_state,
          host_state: command.host_state,
          player_states: command.player_states,
        });
      case 'lifecycle':
        return engine.lifecycle(code, token, command.status);
      case 'settings':
        return engine.settings(code, token, { expected_version: command.expected_version, settings: command.settings });
      case 'ping':
        return null;
      case 'auth':
        throw bad('Je bent al geauthenticeerd.');
      case 'ready':
        return engine.ready(code, token, command.ready);
      case 'configure':
        return engine.configurePatch(code, token, command.expected_version, command.config);
      default:
        return engine.award(code, token, command.player_id, command.achievement_id);
    }
  }

  function incoming(text) {
    seen = performance.now();
    const ts = Date.now();
    let raw;
    let parsed = true;
    try {
      raw = parseJson(text);
    } catch {
      parsed = false;
    }
    if (parsed && isObject(raw) && typeof raw.type === 'string' && isRealtime(raw.type)) {
      let handled = false;
      try {
        handled = limiter.take() ? attachment.realtime.handle(attachment.peer, raw, ts) : false;
      } catch (error) {
        sendError(null, error);
        return;
      }
      if (!handled) {
        const dropped = limiter.dropped();
        if (dropped !== null) send({ type: 'rt.throttled', dropped });
      }
      return;
    }
    const moment = performance.now();
    if (moment - bucket >= 1000) {
      bucket = moment;
      messages = 0;
    }
    messages += 1;
    if (messages > (attachment.identity.role === 'host' ? 240 : 60)) {
      sendError(null, new EngineError(429, 'rate_limit', 'Te veel berichten per seconde.'));
      close('rate_limit');
      return;
    }
    const requestId = parsed && isObject(raw) && typeof raw.request_id === 'string' ? raw.request_id : null;
    if (requestId !== null && Buffer.byteLength(requestId) > 64) {
      sendError(null, bad('request_id mag maximaal 64 tekens zijn.'));
      return;
    }
    let command;
    try {
      if (!parsed) throw new Error('invalid json');
      command = parseCommand(raw);
    } catch {
      sendError(requestId, bad('Ongeldig websocketbericht.'));
      return;
    }
    if (command.type === 'settings') {
      try {
        engine.checkSettings(code, token, command.settings);
      } catch (error) {
        sendError(requestId, error);
        return;
      }
    }
    if (!engine.isCurrent(code, attachment.identity, attachment.connection)) {
      close('session_replaced');
      return;
    }
    try {
      execute(command);
    } catch (error) {
      sendError(requestId, error);
      return;
    }
    if (CHANGES.has(command.type) && !sendSnapshot()) return;
    send({ type: 'ack', request_id: requestId });
  }

  ws.on('text', text => {
    if (state === 'auth') authenticate(text);
    else if (state === 'open') incoming(text);
  });
  ws.on('binary', () => {
    if (state === 'auth') refuse(new EngineError(401, 'auth_timeout', 'Authenticeer binnen vijf seconden.'));
    else if (state === 'open') sendError(null, bad('Gebruik tekstberichten met JSON.'));
  });
  ws.on('pong', () => {
    seen = performance.now();
  });
  ws.on('ping', () => {
    seen = performance.now();
  });
  ws.on('close', finish);
}
