export class EngineError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export const bad = message => new EngineError(400, 'invalid_request', message);
export const unauthorized = () => new EngineError(401, 'unauthorized', 'Ongeldige of verlopen sessie.');
export const forbidden = () => new EngineError(403, 'forbidden', 'Deze actie is niet toegestaan voor jouw rol.');
export const missing = () => new EngineError(404, 'room_not_found', 'Deze room bestaat niet of is verlopen.');
export const conflict = (code, message) => new EngineError(409, code, message);
export const notFound = (code, message) => new EngineError(404, code, message);
export const gameNotFound = () => notFound('game_not_found', 'This game is not installed.');
export const assetNotFound = () => notFound('asset_not_found', 'This public game asset does not exist.');
export const invalidJson = status =>
  new EngineError(status, 'invalid_json', 'Stuur geldige JSON met de verwachte velden en Content-Type application/json.');

export function asEngineError(error) {
  if (error instanceof EngineError) return error;
  return new EngineError(500, 'internal_error', 'De server kon deze actie niet opslaan.');
}
