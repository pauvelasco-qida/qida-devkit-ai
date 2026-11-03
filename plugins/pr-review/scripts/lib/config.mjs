// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { ScannerError } from './errors.mjs';

/**
 * Per-repository configuration, read from `.claude/pr-review.json` → `magicStrings`.
 * The file is committed so every reviewer and every run applies the same rules (ADR-TR-002 §1).
 * @typedef {object} MagicStringsConfig
 * @property {string[]} ignorePaths Extra globs (repo-relative, `**` supported) to skip.
 * @property {string[]} allowValues Exact literal values never reported.
 * @property {number} minLength Literals shorter than this (ignoring `${…}` and whitespace) are ignored.
 * @property {number} duplicateThreshold Same value this many times in the PR → violation.
 * @property {boolean} typedLiteralsAreSafe Literals checked by the compiler against a closed literal union are not magic.
 * @property {string[]} uiTextAttributes Extra JSX attributes whose literal value is user-visible text (ADR-FE-004).
 * @property {string[]} uiTextFunctions Extra callees whose first argument is user-visible text (ADR-FE-004).
 * @property {string[]} i18nFunctions Extra callees whose arguments are translation keys.
 * @property {string[]} logFunctions Extra callees whose arguments are log messages.
 */

/** @type {Readonly<MagicStringsConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  ignorePaths: [],
  allowValues: [],
  minLength: 2,
  duplicateThreshold: 2,
  typedLiteralsAreSafe: true,
  uiTextAttributes: [],
  uiTextFunctions: [],
  i18nFunctions: [],
  logFunctions: [],
});

export const CONFIG_RELATIVE_PATH = '.claude/pr-review.json';

const STRING_ARRAY_KEYS = /** @type {const} */ ([
  'ignorePaths',
  'allowValues',
  'uiTextAttributes',
  'uiTextFunctions',
  'i18nFunctions',
  'logFunctions',
]);

/**
 * @param {string} root
 * @param {string | null} explicitPath
 * @returns {{ config: MagicStringsConfig, path: string | null, warnings: string[] }}
 */
export function loadConfig(root, explicitPath) {
  const file = explicitPath !== null ? path.resolve(explicitPath) : path.join(root, CONFIG_RELATIVE_PATH);
  /** @type {string[]} */
  const warnings = [];
  /** @type {MagicStringsConfig} */
  const config = {
    ...DEFAULT_CONFIG,
    ignorePaths: [],
    allowValues: [],
    uiTextAttributes: [],
    uiTextFunctions: [],
    i18nFunctions: [],
    logFunctions: [],
  };
  if (!fs.existsSync(file)) {
    if (explicitPath !== null) throw new ScannerError('CONFIG_NOT_FOUND', `Config file not found: ${file}`, 2);
    return { config, path: null, warnings };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ScannerError('CONFIG_INVALID', `Invalid JSON in ${file}: ${/** @type {Error} */ (e).message}`, 2);
  }
  const section =
    typeof parsed === 'object' && parsed !== null ? /** @type {Record<string, unknown>} */ (parsed).magicStrings : undefined;
  const relative = path.relative(root, file) || file;
  if (section === undefined) return { config, path: relative, warnings };
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new ScannerError('CONFIG_INVALID', `"magicStrings" in ${relative} must be an object.`, 2);
  }

  for (const [key, value] of Object.entries(section).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (/** @type {readonly string[]} */ (STRING_ARRAY_KEYS).includes(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new ScannerError('CONFIG_INVALID', `"magicStrings.${key}" must be an array of strings.`, 2);
      }
      config[/** @type {typeof STRING_ARRAY_KEYS[number]} */ (key)] = [...value];
    } else if (key === 'minLength' || key === 'duplicateThreshold') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new ScannerError('CONFIG_INVALID', `"magicStrings.${key}" must be an integer >= 1.`, 2);
      }
      config[key] = value;
    } else if (key === 'typedLiteralsAreSafe') {
      if (typeof value !== 'boolean') {
        throw new ScannerError('CONFIG_INVALID', `"magicStrings.${key}" must be a boolean.`, 2);
      }
      config[key] = value;
    } else {
      warnings.push(`Unknown key "magicStrings.${key}" ignored.`);
    }
  }
  return { config, path: relative, warnings };
}

/**
 * Converts a repo-relative glob to a RegExp. Supports `**`, `*`, `?`.
 * `**` followed by a slash matches zero or more directories; `*` and `?` never cross `/`.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${re}$`);
}

/** Built-in file skip rules, evaluated in order; the first match gives the reason. */
const SKIP_RULES = /** @type {const} */ ([
  {
    reason: 'test',
    globs: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/__mocks__/**',
      '**/test/**',
      '**/tests/**',
      '**/e2e/**',
      '**/cypress/**',
      '**/playwright/**',
      '**/fixtures/**',
      '**/mocks/**',
      '**/*.stories.*',
      '**/*.story.*',
    ],
  },
  {
    reason: 'generated',
    globs: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.gen.*',
      '**/*.generated.*',
      '**/generated/**',
      '**/__generated__/**',
      '**/public/**',
      '**/mockServiceWorker.js',
      '**/*.d.ts',
      '**/*.d.mts',
      '**/*.d.cts',
    ],
  },
  { reason: 'config-file', globs: ['**/*.config.*', '**/.*rc.*'] },
]);

const COMPILED_SKIP_RULES = SKIP_RULES.map((r) => ({ reason: r.reason, res: r.globs.map(globToRegExp) }));

export const SCANNED_EXTENSIONS = /** @type {const} */ (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * @param {string} relPath
 * @param {MagicStringsConfig} config
 * @returns {string | null} Why the file is skipped, or null if it must be scanned.
 */
export function skipReason(relPath, config) {
  for (const rule of COMPILED_SKIP_RULES) {
    if (rule.res.some((re) => re.test(relPath))) return rule.reason;
  }
  if (config.ignorePaths.some((g) => globToRegExp(g).test(relPath))) return 'ignored-by-config';
  return null;
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function isScannedExtension(relPath) {
  return SCANNED_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}
