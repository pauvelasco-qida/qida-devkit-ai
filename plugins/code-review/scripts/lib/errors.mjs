// @ts-check

/**
 * Error carrying a stable machine-readable code and the process exit code the CLI must use.
 * Exit code 2 = usage or configuration problem, 3 = environment problem (git, TypeScript).
 */
export class ScannerError extends Error {
  /**
   * @param {string} code Stable identifier, e.g. "TYPESCRIPT_NOT_FOUND".
   * @param {string} message Human-readable description.
   * @param {2 | 3} exitCode
   * @param {string} [hint] What the user can do about it.
   */
  constructor(code, message, exitCode, hint) {
    super(message);
    this.name = 'ScannerError';
    /** @readonly */
    this.code = code;
    /** @readonly */
    this.exitCode = exitCode;
    /** @readonly */
    this.hint = hint ?? null;
  }
}
