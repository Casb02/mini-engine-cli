export class CliError extends Error {
  constructor(message, { code = 'cli_error', status, exitCode = 1, hint } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const usageError = (message, hint) => new CliError(message, { code: 'usage', exitCode: 2, hint });
