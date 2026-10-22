import { CliError } from './errors.mjs';

const NETWORK_CODES = {
  ECONNREFUSED: 'verbinding geweigerd',
  ENOTFOUND: 'onbekende host',
  EAI_AGAIN: 'DNS-fout',
  ECONNRESET: 'verbinding verbroken',
  ETIMEDOUT: 'time-out',
  EHOSTUNREACH: 'host onbereikbaar',
  CERT_HAS_EXPIRED: 'TLS-certificaat verlopen',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'zelfondertekend TLS-certificaat',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS-certificaat niet te controleren',
};

export async function request(server, path, { method = 'GET', token, body, timeoutMs = 30_000 } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'mini-engine-cli' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${server}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new CliError(`Geen antwoord van ${server} binnen ${Math.round(timeoutMs / 1000)} s.`, { code: 'timeout' });
    }
    const code = error.cause?.code;
    const reason = NETWORK_CODES[code] ?? (error.cause?.message === 'bad port' ? 'poort niet toegestaan' : (code ?? error.cause?.message ?? error.message));
    throw new CliError(`Kan ${server} niet bereiken (${reason}).`, {
      code: 'network',
      hint: 'Controleer de server-URL (me auth status) en of de engine draait.',
    });
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const error = data?.error;
    if (error?.message) {
      throw new CliError(error.message, { code: error.code ?? 'server_error', status: response.status });
    }
    const fallback = response.status === 413 ? 'Upload is te groot voor de server.' : `Server antwoordde met HTTP ${response.status}.`;
    throw new CliError(fallback, {
      code: response.status === 404 ? 'not_found' : 'server_error',
      status: response.status,
      hint: response.status === 404 ? `Draait op ${server} wel Mini Engine 0.3 of nieuwer?` : undefined,
    });
  }
  if (text && data === null) throw new CliError(`Onverwacht antwoord van ${server}${path} (geen JSON).`, { code: 'bad_response' });
  return data;
}

export const enc = encodeURIComponent;
