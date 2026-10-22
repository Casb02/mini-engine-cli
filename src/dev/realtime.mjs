import { performance } from 'node:perf_hooks';
import { bad, forbidden } from './errors.mjs';
import { isObject, stringify } from './json.mjs';

export const MAX_PAYLOAD_BYTES = 2 * 1024;
export const MAX_KEYS_PER_SENDER = 64;
export const MAX_ROOM_VALUE_BYTES = 256 * 1024;
export const MAX_TARGETS = 16;
export const RATE_PER_SECOND = 60;
export const BURST = 120;
export const REPORT_INTERVAL = 5000;

const NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const FIELDS = { 'rt.emit': ['type', 'channel', 'data', 'to', 'echo'], 'rt.set': ['type', 'key', 'value'], 'rt.reset': ['type'] };
const ALL = { kind: 'all' };

export const isRealtime = kind => Object.hasOwn(FIELDS, kind);

export function createPeer(identity, connection, deliver) {
  const playerId = identity.player_id ?? null;
  return {
    connection,
    role: identity.role,
    playerId,
    sender: identity.role === 'player' ? (playerId ?? '') : identity.role,
    from: stringify({ role: identity.role, player_id: playerId }),
    revoked: false,
    deliver,
  };
}

function parse(raw) {
  const invalid = () => bad('Ongeldig realtimebericht.');
  if (!isObject(raw)) throw invalid();
  const allowed = FIELDS[raw.type];
  if (!allowed || Object.keys(raw).some(key => !allowed.includes(key))) throw invalid();
  if (raw.type === 'rt.emit') {
    if (typeof raw.channel !== 'string') throw invalid();
    if ('echo' in raw && typeof raw.echo !== 'boolean') throw invalid();
    return { type: 'emit', channel: raw.channel, data: 'data' in raw ? raw.data : null, to: raw.to ?? null, echo: raw.echo === true };
  }
  if (raw.type === 'rt.set') {
    if (typeof raw.key !== 'string' || !('value' in raw)) throw invalid();
    return { type: 'set', key: raw.key, value: raw.value };
  }
  return { type: 'reset' };
}

function payload(value) {
  const text = stringify(value);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw bad('Realtime-data mag maximaal 2 KiB zijn.');
  return text;
}

function target(value) {
  const invalid = () => bad("Gebruik voor to: all, host, players, display of een lijst van maximaal 16 speler-id's.");
  if (value === null || value === undefined) return ALL;
  if (typeof value === 'string') {
    if (['all', 'host', 'players', 'display'].includes(value)) return { kind: value };
    throw invalid();
  }
  if (Array.isArray(value) && value.length <= MAX_TARGETS) {
    const ids = value.map(id => {
      if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id) > 64) throw invalid();
      return id;
    });
    return { kind: 'ids', ids };
  }
  throw invalid();
}

function reaches(peer, origin, echo, to) {
  if (peer.revoked || (origin === peer.connection && !echo)) return false;
  switch (to.kind) {
    case 'all':
      return true;
    case 'host':
      return peer.role === 'host';
    case 'players':
      return peer.playerId !== null;
    case 'display':
      return peer.role === 'display';
    default:
      return peer.playerId !== null && to.ids.includes(peer.playerId);
  }
}

const bySlot = (a, b) => (a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const valueFrame = entry => `{"type":"rt.value",${entry.slice(1)}`;

export class Realtime {
  constructor() {
    this.peers = new Set();
    this.values = new Map();
    this.bytes = 0;
  }

  subscribe(peer) {
    this.peers.add(peer);
    return this.valuesFrame();
  }

  unsubscribe(peer) {
    this.peers.delete(peer);
  }

  valuesFrame() {
    const entries = [...this.values.values()].sort(bySlot).map(item => item.entry);
    return `{"type":"rt.values","values":[${entries.join(',')}]}`;
  }

  send(text, origin, echo, to) {
    for (const peer of [...this.peers]) if (reaches(peer, origin, echo, to)) peer.deliver(text);
  }

  handle(peer, raw, ts) {
    const command = parse(raw);
    if (command.type === 'emit') {
      if (!NAME.test(command.channel)) throw bad('Gebruik een kanaalnaam van 1–64 letters, cijfers, _, ., : of -.');
      const data = payload(command.data);
      const to = target(command.to);
      if (!peer.revoked) {
        this.send(`{"type":"rt.event","channel":"${command.channel}","data":${data},"from":${peer.from},"ts":${ts}}`, peer.connection, command.echo, to);
      }
      return true;
    }
    if (command.type === 'set') {
      if (!NAME.test(command.key)) throw bad('Gebruik een sleutel van 1–64 letters, cijfers, _, ., : of -.');
      return this.set(peer, command.key, payload(command.value), ts);
    }
    if (peer.role !== 'host') throw forbidden();
    if (!peer.revoked) {
      this.clear();
      this.send(`{"type":"rt.reset","from":${peer.from},"ts":${ts}}`, null, false, ALL);
    }
    return true;
  }

  keysOf(sender) {
    let count = 0;
    for (const item of this.values.values()) if (item.sender === sender) count += 1;
    return count;
  }

  set(peer, key, value, ts) {
    if (peer.revoked) return true;
    const slot = `${peer.sender}\u0000${key}`;
    const entry = `{"key":"${key}","value":${value},"from":${peer.from},"ts":${ts}}`;
    const existing = this.values.get(slot);
    const old = existing ? Buffer.byteLength(existing.entry) + 1 : 0;
    if (value === 'null') {
      if (!old) return true;
      this.values.delete(slot);
      this.bytes -= old;
    } else {
      const bytes = this.bytes - old + Buffer.byteLength(entry) + 1;
      if (bytes > MAX_ROOM_VALUE_BYTES || (!old && this.keysOf(peer.sender) >= MAX_KEYS_PER_SENDER)) return false;
      this.values.set(slot, { sender: peer.sender, key, entry });
      this.bytes = bytes;
    }
    this.send(valueFrame(entry), peer.connection, false, ALL);
    return true;
  }

  forget(playerId, ts) {
    const from = stringify({ role: 'player', player_id: playerId });
    const owned = [...this.values.entries()].filter(([, item]) => item.sender === playerId).sort(([, a], [, b]) => bySlot(a, b));
    for (const [slot, item] of owned) {
      this.values.delete(slot);
      this.bytes -= Buffer.byteLength(item.entry) + 1;
      this.send(valueFrame(`{"key":"${item.key}","value":null,"from":${from},"ts":${ts}}`), null, false, ALL);
    }
  }

  clear() {
    this.values.clear();
    this.bytes = 0;
  }

  achievement(playerId, achievement) {
    const text = stringify({
      type: 'achievement',
      player_id: playerId,
      achievement: { id: achievement.id, title: achievement.title, description: achievement.description },
    });
    this.send(text, null, false, ALL);
  }
}

export class Limiter {
  constructor(now = performance.now()) {
    this.tokens = BURST;
    this.refilled = now;
    this.pending = 0;
    this.reported = null;
  }

  take(now = performance.now()) {
    const elapsed = Math.max(0, now - this.refilled) / 1000;
    this.tokens = Math.min(BURST, this.tokens + elapsed * RATE_PER_SECOND);
    this.refilled = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  dropped(now = performance.now()) {
    this.pending += 1;
    return this.due(now);
  }

  due(now = performance.now()) {
    if (this.pending === 0 || (this.reported !== null && now - this.reported < REPORT_INTERVAL)) return null;
    this.reported = now;
    const count = this.pending;
    this.pending = 0;
    return count;
  }
}
