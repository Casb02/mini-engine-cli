import { createInterface } from 'node:readline';
import { CliError } from './errors.mjs';

function lineReader(stdin) {
  let buffer = '';
  let ended = false;
  const lines = [];
  const waiters = [];
  let started = false;
  const flush = () => {
    while (waiters.length && (lines.length || ended)) waiters.shift()(lines.length ? lines.shift() : null);
    if (!waiters.length && !ended) stdin.pause();
  };
  const start = () => {
    started = true;
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
      flush();
    });
    stdin.on('end', () => {
      if (buffer) lines.push(buffer);
      buffer = '';
      ended = true;
      flush();
    });
  };
  return {
    next() {
      if (!started) start();
      return new Promise(resolve => {
        waiters.push(resolve);
        stdin.resume();
        flush();
      });
    },
    close() {
      if (started && !ended) stdin.destroy();
    },
  };
}

function readHidden(stdin, stderr) {
  return new Promise((resolve, reject) => {
    let value = '';
    let escape = false;
    const wasRaw = stdin.isRaw;
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write('\n');
    };
    const onData = chunk => {
      for (const char of String(chunk)) {
        if (escape) {
          if (/[A-Za-z~]/.test(char)) escape = false;
        } else if (char === '\u001b') {
          escape = true;
        } else if (char === '\r' || char === '\n' || char === '\u0004') {
          finish();
          resolve(value);
          return;
        } else if (char === '\u0003') {
          finish();
          reject(new CliError('Afgebroken.', { code: 'aborted', exitCode: 130 }));
          return;
        } else if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
        }
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export function createPrompter({ stdin, stderr }) {
  const tty = Boolean(stdin.isTTY);
  let reader;
  const readLine = async question => {
    if (tty) {
      const rl = createInterface({ input: stdin, output: stderr, terminal: true });
      try {
        return await new Promise((resolve, reject) => {
          rl.on('SIGINT', () => reject(new CliError('Afgebroken.', { code: 'aborted', exitCode: 130 })));
          rl.question(question, resolve);
        });
      } finally {
        rl.close();
      }
    }
    stderr.write(question);
    reader ??= lineReader(stdin);
    const line = await reader.next();
    stderr.write('\n');
    return line;
  };
  return {
    interactive: tty,
    async ask(question, { defaultValue } = {}) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await readLine(`${question}${suffix}: `);
      const text = (answer ?? '').trim();
      return text || defaultValue || '';
    },
    async askHidden(question) {
      if (!tty) return ((await readLine(`${question}: `)) ?? '').trim();
      stderr.write(`${question}: `);
      return (await readHidden(stdin, stderr)).trim();
    },
    async confirm(question, defaultYes = false) {
      const answer = (await readLine(`${question} ${defaultYes ? '[J/n]' : '[j/N]'} `)) ?? '';
      const text = answer.trim().toLowerCase();
      if (!text) return defaultYes;
      return ['j', 'ja', 'y', 'yes'].includes(text);
    },
    close() {
      reader?.close();
    },
  };
}
