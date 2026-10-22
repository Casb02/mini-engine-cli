// src/api.ts
var MiniEngineError = class extends Error {
  constructor(message, code = "client_error", status) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "MiniEngineError";
  }
  code;
  status;
};
var normalizeCode = (code) => code.trim().toUpperCase();
function endpoint(baseUrl, path) {
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}${path}` : path;
}
async function http(path, { token, ...options } = {}, fetcher = globalThis.fetch) {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetcher(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new MiniEngineError(body.error?.message || `Verzoek mislukt (${response.status}).`, body.error?.code || "http_error", response.status);
  }
  return response.status === 204 ? null : response.json();
}
var ApiClient = class {
  baseUrl;
  accountToken;
  fetcher;
  constructor({ baseUrl = "", accountToken, fetch: fetcher } = {}) {
    this.baseUrl = baseUrl;
    this.accountToken = accountToken;
    this.fetcher = fetcher;
  }
  call(path, options = {}) {
    return http(endpoint(this.baseUrl, `/api/v1${path}`), options, this.fetcher ?? globalThis.fetch);
  }
  getGames() {
    return this.call("/games");
  }
  getGame(id) {
    return this.call(`/games/${encodeURIComponent(id)}`);
  }
  createRoom(options) {
    return this.call("/rooms", { method: "POST", token: this.accountToken, body: JSON.stringify(options) });
  }
  joinRoom(code, name) {
    return this.call(`${this.roomPath(code)}/join`, { method: "POST", token: this.accountToken, body: JSON.stringify({ name }) });
  }
  getRoom(code, token) {
    return this.call(this.roomPath(code), { token });
  }
  roomInfo(code) {
    return this.call(`${this.roomPath(code)}/info`);
  }
  gameData(code, token) {
    return this.call(`${this.roomPath(code)}/game-data`, { token });
  }
  displayToken(code, token) {
    return this.call(`${this.roomPath(code)}/display-token`, { method: "POST", token });
  }
  /** Creates an account; the engine mails a confirmation link to `email`. */
  register(input) {
    return this.call("/accounts/register", { method: "POST", body: JSON.stringify(input) });
  }
  /** Confirms an address with the token from the `?verify=` link; needs that account's `accountToken`. */
  verifyEmail(token) {
    return this.call("/accounts/verify-email", { method: "POST", token: this.accountToken, body: JSON.stringify({ token }) });
  }
  /** Adds or changes the account address, or resends the confirmation link. */
  setEmail(email) {
    return this.call("/accounts/email", { method: "PUT", token: this.accountToken, body: JSON.stringify({ email }) });
  }
  login(input) {
    return this.call("/accounts/login", { method: "POST", body: JSON.stringify(input) });
  }
  me() {
    return this.call("/accounts/me", { token: this.accountToken });
  }
  stats() {
    return this.call("/accounts/stats", { token: this.accountToken });
  }
  /** Achievements of an account, newest first; defaults to this client's `accountToken`. */
  achievements(accountToken = this.accountToken) {
    return this.call("/accounts/achievements", { token: accountToken });
  }
  /** The account's sets without their content, most recently changed first. */
  listSets(filter = {}) {
    const query = new URLSearchParams();
    if (filter.game_id !== void 0) query.set("game_id", filter.game_id);
    if (filter.kind !== void 0) query.set("kind", filter.kind);
    const search = query.toString();
    return this.call(`/accounts/sets${search ? `?${search}` : ""}`, { token: this.accountToken });
  }
  /** One of the account's sets with its content; another account's set answers 404 `set_not_found`. */
  getSet(id) {
    return this.call(this.setPath(id), { token: this.accountToken });
  }
  /** Saves a set; the kind must be declared by the game's active release and the data must match its schema. */
  createSet(input) {
    return this.call("/accounts/sets", { method: "POST", token: this.accountToken, body: JSON.stringify(input) });
  }
  /** Replaces the title and content of a set; rooms that already use it keep their copy. */
  updateSet(id, input) {
    return this.call(this.setPath(id), { method: "PUT", token: this.accountToken, body: JSON.stringify(input) });
  }
  deleteSet(id) {
    return this.call(this.setPath(id), { method: "DELETE", token: this.accountToken });
  }
  async logout() {
    const result = await this.call("/accounts/logout", { method: "POST", token: this.accountToken });
    this.accountToken = void 0;
    return result;
  }
  roomPath(code) {
    return `/rooms/${encodeURIComponent(normalizeCode(code))}`;
  }
  setPath(id) {
    return `/accounts/sets/${encodeURIComponent(id)}`;
  }
};
var getGames = () => new ApiClient().getGames();
var createRoom = (options) => new ApiClient().createRoom(options);
var joinRoom = (code, name) => new ApiClient().joinRoom(code, name);

// src/client.ts
var transientReasons = /* @__PURE__ */ new Set(["host_lagged", "heartbeat_timeout", "rate_limit", "server_shutdown"]);
var actionSequence = 0;
var senderOf = (from) => typeof from === "string" ? from : from.role === "player" ? String(from.player_id ?? "") : from.role;
var fromOf = (value) => {
  const from = value && typeof value === "object" ? value : {};
  return { role: from.role ?? "player", player_id: from.player_id ?? null };
};
function call(handlers, ...args) {
  for (const fn of [...handlers ?? []]) {
    try {
      fn(...args);
    } catch (error) {
      console.error(error);
    }
  }
}
var RealtimeChannel = class {
  constructor(link, interval) {
    this.link = link;
    this.interval = interval;
  }
  link;
  interval;
  events = /* @__PURE__ */ new Map();
  watchers = /* @__PURE__ */ new Map();
  values = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  /** Keys this connection set before its `rt.values` arrived; that frame cannot know them. */
  early = /* @__PURE__ */ new Set();
  synced = false;
  /** Own `rt.reset` frames still to come back, and the keys set since the last one was sent. */
  resets = 0;
  kept = /* @__PURE__ */ new Set();
  timer;
  flushed = 0;
  emit(channel, data = null, { to, echo } = {}) {
    const frame = { type: "rt.emit", channel, data };
    if (to !== void 0) frame.to = to;
    if (echo) frame.echo = true;
    return this.link.send(frame);
  }
  on(channel, fn) {
    return listen(this.events, channel, fn);
  }
  onValue(key, fn) {
    return listen(this.watchers, key, fn);
  }
  value(from, key) {
    return this.values.get(senderOf(from))?.get(key)?.value;
  }
  set(key, value) {
    const self = this.link.self();
    if (!self) return;
    if (!this.synced) this.early.add(key);
    if (this.resets) this.kept.add(key);
    this.pending.set(key, value);
    this.store(key, value, self, Date.now());
    if (this.timer !== void 0) return;
    const wait = this.flushed + this.interval - Date.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }
  reset() {
    this.unsent();
    if (this.link.send({ type: "rt.reset" }) && this.link.self()?.role === "host") {
      this.resets++;
      this.kept.clear();
    }
  }
  unsent() {
    clearTimeout(this.timer);
    this.timer = void 0;
    this.pending.clear();
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = void 0;
    this.flushed = Date.now();
    for (const [key, value] of this.pending) this.link.send({ type: "rt.set", key, value });
    this.pending.clear();
  }
  store(key, value, from, ts) {
    const sender = senderOf(from);
    if (value === null) {
      this.values.get(sender)?.delete(key);
      if (this.values.get(sender)?.size === 0) this.values.delete(sender);
    } else {
      if (!this.values.has(sender)) this.values.set(sender, /* @__PURE__ */ new Map());
      this.values.get(sender).set(key, { value, from, ts });
    }
    this.notify(key, value, from, ts);
  }
  notify(key, value, from, ts) {
    call(this.watchers.get(key), value, from, ts, key);
    call(this.watchers.get("*"), value, from, ts, key);
  }
  receive(message) {
    const ts = Number(message.ts) || 0;
    if (message.type === "rt.event") {
      const channel = String(message.channel);
      const from = fromOf(message.from);
      call(this.events.get(channel), message.data ?? null, from, ts, channel);
      call(this.events.get("*"), message.data ?? null, from, ts, channel);
    } else if (message.type === "rt.value") {
      this.store(String(message.key), message.value ?? null, fromOf(message.from), ts);
    } else if (message.type === "rt.values" && Array.isArray(message.values)) {
      const previous = this.values;
      this.values = /* @__PURE__ */ new Map();
      for (const item of message.values) {
        const from = fromOf(item?.from);
        if (item?.value === null || item?.value === void 0) continue;
        if (!this.values.has(senderOf(from))) this.values.set(senderOf(from), /* @__PURE__ */ new Map());
        this.values.get(senderOf(from)).set(String(item.key), { value: item.value, from, ts: Number(item.ts) || 0 });
      }
      const self = this.link.self();
      if (self) {
        const sender = senderOf(self);
        for (const key of this.early) {
          const entry = previous.get(sender)?.get(key);
          if (entry) {
            if (!this.values.has(sender)) this.values.set(sender, /* @__PURE__ */ new Map());
            this.values.get(sender).set(key, entry);
          } else this.values.get(sender)?.delete(key);
        }
        if (this.values.get(sender)?.size === 0) this.values.delete(sender);
      }
      this.early.clear();
      this.synced = true;
      for (const [sender, entries] of previous) {
        for (const [key, entry] of entries) if (!this.values.get(sender)?.has(key)) this.notify(key, null, entry.from, entry.ts);
      }
      for (const [sender, entries] of this.values) {
        for (const [key, entry] of entries) if (previous.get(sender)?.get(key) !== entry) this.notify(key, entry.value, entry.from, entry.ts);
      }
    } else if (message.type === "rt.reset") {
      const self = this.link.self();
      const own = self && this.resets && senderOf(fromOf(message.from)) === senderOf(self) ? senderOf(self) : null;
      const previous = this.values;
      this.values = /* @__PURE__ */ new Map();
      for (const [sender, entries] of previous) {
        for (const [key, entry] of entries) {
          if (sender === own && this.kept.has(key)) {
            if (!this.values.has(sender)) this.values.set(sender, /* @__PURE__ */ new Map());
            this.values.get(sender).set(key, entry);
          } else this.notify(key, null, entry.from, ts);
        }
      }
      if (own !== null && --this.resets === 0) this.kept.clear();
    }
  }
  /** Forget unsent values; they are never sent after a reconnect. */
  drop() {
    this.unsent();
    this.early.clear();
    this.synced = false;
    this.resets = 0;
    this.kept.clear();
  }
  clear() {
    this.drop();
    this.values = /* @__PURE__ */ new Map();
  }
};
function listen(map, name, fn) {
  if (!map.has(name)) map.set(name, /* @__PURE__ */ new Set());
  map.get(name).add(fn);
  return () => {
    map.get(name)?.delete(fn);
  };
}
function actionId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++actionSequence}`;
}
var MiniEngine = class {
  code;
  token;
  room = null;
  connected = false;
  pending = /* @__PURE__ */ new Map();
  /** Ephemeral events and values for this room. */
  realtime;
  live;
  options;
  listeners = /* @__PURE__ */ new Map();
  waiters = /* @__PURE__ */ new Set();
  socket;
  serial = 0;
  attempt = 0;
  stopped = true;
  retry;
  cooldown = 0;
  constructor(options) {
    this.options = options;
    this.code = normalizeCode(options.code);
    this.token = options.token;
    this.live = new RealtimeChannel({
      send: (frame) => this.sendRealtime(frame),
      self: () => this.connected && this.room ? { role: this.room.you.role, player_id: this.room.you.player_id ?? null } : null
    }, Math.max(0, options.realtime?.setInterval ?? 33));
    this.realtime = this.live;
  }
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, /* @__PURE__ */ new Set());
    this.listeners.get(type).add(fn);
    return () => {
      this.listeners.get(type)?.delete(fn);
    };
  }
  once(type, fn) {
    const off = this.on(type, (value) => {
      off();
      fn(value);
    });
    return off;
  }
  emit(type, value) {
    for (const fn of [...this.listeners.get(type) ?? []]) {
      try {
        fn(value);
      } catch (error) {
        console.error(error);
      }
    }
  }
  connect() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.attempt = 0;
    this.open();
    return this;
  }
  /** Explicitly reconnect; saved room state is retained until a fresh snapshot arrives. */
  resume() {
    return this.connect();
  }
  open() {
    if (this.stopped) return;
    this.emit("status", this.attempt ? "reconnecting" : "connecting");
    let socket;
    try {
      const base = this.options.baseUrl || globalThis.location?.origin || (globalThis.location?.host ? `${globalThis.location.protocol}//${globalThis.location.host}` : "");
      if (!base) throw new MiniEngineError("Set baseUrl outside a browser.", "missing_base_url");
      const url = new URL(endpoint(base, `/api/v1/rooms/${encodeURIComponent(this.code)}/ws`));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const Socket = this.options.WebSocket ?? globalThis.WebSocket;
      socket = new Socket(url.toString());
    } catch (error) {
      this.close();
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket && !this.stopped) socket.send(JSON.stringify({ type: "auth", token: this.token }));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      if (message.type === "snapshot" && message.room && typeof message.room === "object") {
        this.room = message.room;
        const wasConnected = this.connected;
        this.connected = true;
        this.attempt = 0;
        if (!wasConnected) this.emit("status", "connected");
        this.emit("snapshot", this.room);
      } else if (message.type === "ack") {
        const pending = this.pending.get(String(message.request_id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(String(message.request_id));
          pending.resolve(message);
        }
      } else if (message.type === "error") {
        const body = message.error;
        const error = new MiniEngineError(body?.message || "Verzoek mislukt.", body?.code);
        const pending = this.pending.get(String(message.request_id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(String(message.request_id));
          pending.reject(error);
        }
        this.emit("error", error);
        if (!this.connected && !message.request_id) this.close();
      } else if (message.type === "closed") {
        const reason = String(message.reason);
        if (transientReasons.has(reason)) {
          if (reason === "rate_limit") this.cooldown = 1200;
          socket.close();
        } else {
          this.close();
          this.emit("closed", reason);
        }
      } else if (message.type === "action") this.emit("action", message);
      else if (message.type === "rt.throttled") this.emit("throttled", { dropped: Number(message.dropped) || 0 });
      else if (message.type === "achievement" && message.achievement && typeof message.achievement === "object") {
        this.emit("achievement", { player_id: String(message.player_id), achievement: message.achievement });
      } else if (typeof message.type === "string" && message.type.startsWith("rt.")) this.live.receive(message);
    };
    socket.onerror = () => {
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = void 0;
      this.connected = false;
      this.live.drop();
      this.rejectPending(new MiniEngineError("Verbinding verbroken. Probeer opnieuw zodra je verbonden bent.", "disconnected"));
      if (this.stopped) return;
      this.emit("status", "reconnecting");
      const delay = Math.max(this.cooldown, Math.min(15e3, (this.options.reconnectDelay ?? 500) * 2 ** Math.min(this.attempt++, 6)));
      this.cooldown = 0;
      this.retry = setTimeout(() => this.open(), delay + Math.random() * delay * 0.2);
    };
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  sendRealtime(frame) {
    if (!this.connected || this.socket?.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
  request(type, payload = {}) {
    if (!this.connected || this.socket?.readyState !== 1) return Promise.reject(new MiniEngineError("Je bent nog niet verbonden.", "not_connected"));
    const request_id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new MiniEngineError("Geen bevestiging ontvangen. Controleer de actuele spelstand voordat je opnieuw probeert.", "request_timeout"));
      }, this.options.requestTimeout ?? 1e4);
      this.pending.set(request_id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ ...payload, type, request_id }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(error);
      }
    });
  }
  action(name, data = {}, { actionId: id = actionId() } = {}) {
    if (!id || id.length > 64) return Promise.reject(new MiniEngineError("actionId must contain 1\u201364 characters.", "invalid_action_id"));
    return this.request("action", { name, data, action_id: id });
  }
  setState(state) {
    return this.request("set_state", { ...state });
  }
  lifecycle(status) {
    return this.request("lifecycle", { status });
  }
  setSettings(settings) {
    return this.request("settings", { expected_version: this.room?.version, settings });
  }
  ready(ready = true) {
    return this.request("ready", { ready });
  }
  configure(config) {
    return this.request("configure", { expected_version: this.room?.version, config });
  }
  /** Host of a browser-host game: grant a declared achievement to a seated player with an account. Awarding twice still acks. */
  award(playerId, achievementId) {
    return this.request("award", { player_id: playerId, achievement_id: achievementId });
  }
  waitForSnapshot(predicate = () => true, { timeout = this.options.requestTimeout ?? 1e4, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.connected && this.room && predicate(this.room)) return Promise.resolve(this.room);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        off();
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(fail);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const abort = () => fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      const off = this.on("snapshot", (room) => {
        try {
          if (predicate(room)) {
            cleanup();
            resolve(room);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const timer = setTimeout(() => fail(new MiniEngineError("Timed out waiting for a snapshot.", "snapshot_timeout")), timeout);
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.add(fail);
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.connected = false;
    const error = new MiniEngineError("Verbinding gesloten.", "closed");
    this.rejectPending(error);
    this.live.clear();
    for (const fail of [...this.waiters]) fail(error);
    const socket = this.socket;
    this.socket = void 0;
    socket?.close();
    this.emit("status", "disconnected");
  }
};

// src/session.ts
var sessionKey = (code, role) => `mini-engine:${normalizeCode(code)}:${role}`;
function saveSession(session, storage = globalThis.sessionStorage) {
  storage.setItem(sessionKey(session.code, session.role), JSON.stringify({ ...session, code: normalizeCode(session.code) }));
}
function loadSession(code, role, storage = globalThis.sessionStorage) {
  try {
    const value = JSON.parse(storage.getItem(sessionKey(code, role)) ?? "null");
    return value && normalizeCode(value.code) === normalizeCode(code) && value.role === role && typeof value.token === "string" && value.token.length > 0 ? value : null;
  } catch {
    return null;
  }
}
function removeSession(code, role, storage = globalThis.sessionStorage) {
  storage.removeItem(sessionKey(code, role));
}
export {
  ApiClient,
  MiniEngine,
  MiniEngineError,
  createRoom,
  endpoint,
  getGames,
  http,
  joinRoom,
  loadSession,
  normalizeCode,
  removeSession,
  saveSession,
  sessionKey
};
