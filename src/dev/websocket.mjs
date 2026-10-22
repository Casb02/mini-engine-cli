import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE_BYTES = 96 * 1024;

export function handshakeProblem(req) {
  const tokens = value => String(value ?? '').toLowerCase().split(',').map(part => part.trim());
  if (req.method !== 'GET') return 'Request method must be `GET`';
  if (!tokens(req.headers.connection).includes('upgrade')) return "Connection header did not include 'upgrade'";
  if (!tokens(req.headers.upgrade).includes('websocket')) return "`Upgrade` header did not include 'websocket'";
  if (req.headers['sec-websocket-version'] !== '13') return "`Sec-WebSocket-Version` header did not include '13'";
  if (!req.headers['sec-websocket-key']) return '`Sec-WebSocket-Key` header missing';
  return null;
}

export function acceptWebSocket(req, socket, head, extraHeaders = []) {
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...extraHeaders, '', ''].join('\r\n'),
  );
  return new WebSocketConnection(socket, head);
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];
    this.partType = 0;
    this.partBytes = 0;
    this.closing = false;
    this.closed = false;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on('data', chunk => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.parse();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buffer.length) setImmediate(() => this.parse());
  }

  get open() {
    return !this.closing && !this.closed;
  }

  write(data) {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(data);
    return true;
  }

  sendText(text) {
    if (!this.open) return false;
    return this.write(frame(0x1, Buffer.from(text)));
  }

  ping() {
    if (this.open) this.write(frame(0x9));
  }

  close(code) {
    if (this.closing || this.closed) return;
    this.closing = true;
    let payload = Buffer.alloc(0);
    if (code) {
      payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
    }
    this.write(frame(0x8, payload));
    this.timer = setTimeout(() => this.finish(), 1000);
    this.timer.unref?.();
  }

  fail(code) {
    this.close(code);
    this.buffer = Buffer.alloc(0);
    setImmediate(() => this.finish());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.socket.destroy();
    this.emit('close');
  }

  parse() {
    while (!this.closed) {
      const buffer = this.buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const rsv = buffer[0] & 0x70;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.fail(1009);
        length = Number(big);
        offset = 10;
      }
      if (rsv || !masked) return this.fail(1002);
      const control = opcode >= 0x8;
      if (control ? !fin || length > 125 || opcode > 0xa : opcode > 0x2) return this.fail(1002);
      if (!control && this.partBytes + length > MAX_MESSAGE_BYTES) return this.fail(1009);
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) {
        if (!this.closing) {
          this.closing = true;
          this.write(frame(0x8, payload.subarray(0, 2)));
        }
        this.socket.end();
        this.finish();
        return;
      }
      if (opcode === 0x9) {
        this.write(frame(0xa, payload));
        this.emit('ping');
        continue;
      }
      if (opcode === 0xa) {
        this.emit('pong');
        continue;
      }
      if (opcode === 0x0) {
        if (!this.partType) return this.fail(1002);
        this.parts.push(payload);
        this.partBytes += payload.length;
        if (fin) this.deliver(this.partType, Buffer.concat(this.parts));
        continue;
      }
      if (this.partType) return this.fail(1002);
      if (fin) {
        this.deliver(opcode, payload);
      } else {
        this.partType = opcode;
        this.parts = [payload];
        this.partBytes = payload.length;
      }
    }
  }

  deliver(opcode, payload) {
    this.partType = 0;
    this.parts = [];
    this.partBytes = 0;
    if (this.closing) return;
    if (opcode === 0x2) {
      this.emit('binary', payload);
      return;
    }
    let text;
    try {
      text = this.decoder.decode(payload);
    } catch {
      this.fail(1007);
      return;
    }
    this.emit('text', text);
  }
}
