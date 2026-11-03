// @ts-check
import path from 'node:path';
import { enclosingStatementSpan, probeRegion } from './classify.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').Program} Program */
/** @typedef {import('typescript').ParsedCommandLine} ParsedCommandLine */
/** @typedef {import('typescript').CompilerHost} CompilerHost */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('./classify.mjs').Literal} Literal */

/**
 * @typedef {object} Project
 * @property {Program} program
 * @property {ParsedCommandLine} parsed
 * @property {CompilerHost} host
 */

/**
 * One text replacement, in original-file offsets.
 * @typedef {object} Edit
 * @property {number} start
 * @property {number} end
 * @property {string} text
 */

/** Replacement value: no literal union will ever contain it. */
const PROBE = '__pr_review_probe__';
/** Upper bound of batch rounds per file before the remaining literals are reported as unknown. */
const MAX_ROUNDS = 25;

/**
 * @param {string} p
 * @returns {string}
 */
function norm(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * @param {number} pos
 * @param {readonly [number, number]} span
 * @returns {boolean}
 */
function within(pos, span) {
  return pos >= span[0] && pos < span[1];
}

/**
 * Applies non-overlapping edits and returns a function that maps a position in the new text
 * back to the original text (positions inside an edit map to the edit start).
 * @param {string} text
 * @param {Edit[]} edits
 * @returns {{ text: string, toOriginal: (pos: number) => number }}
 */
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let last = 0;
  for (const e of sorted) {
    out += text.slice(last, e.start) + e.text;
    last = e.end;
  }
  out += text.slice(last);
  /** @param {number} pos */
  const toOriginal = (pos) => {
    let delta = 0;
    for (const e of sorted) {
      const newStart = e.start + delta;
      if (pos < newStart) return pos - delta;
      if (pos < newStart + e.text.length) return e.start;
      delta += e.text.length - (e.end - e.start);
    }
    return pos - delta;
  };
  return { text: out, toOriginal };
}

const CODE_RADIX = 1_000_000;

/**
 * Encodes diagnostics as `originalStart * CODE_RADIX + code` so they compare as plain numbers.
 * @param {readonly import('typescript').Diagnostic[]} diagnostics
 * @param {(pos: number) => number} toOriginal
 * @returns {number[]}
 */
function encodeDiagnostics(diagnostics, toOriginal) {
  /** @type {number[]} */
  const out = [];
  for (const d of diagnostics) {
    if (d.start !== undefined) out.push(toOriginal(d.start) * CODE_RADIX + d.code);
  }
  return out;
}

/**
 * Decides whether the compiler already protects a literal against typos.
 *
 * Method ("mutation probe"): rewrite the literal's text to a value no type allows, re-check the
 * file with the project's own tsconfig, and look for a new compiler error attributable to it.
 * A new error means a typo in that literal would not compile, so the literal is constrained by
 * the type system (literal unions, typed routes, typed i18n keys, keyof, discriminants...).
 *
 * All pending literals of a file are probed together, in rounds: errors are attributed to the
 * literal whose own span or probe region contains them; attributed literals are restored and the
 * file is re-checked, because the compiler reports only the first failing property of an object
 * literal or JSX element. Ambiguous attributions are verified one literal at a time. The result is
 * exact for the installed dependencies and identical on every run.
 */
export class TypeProber {
  /**
   * @param {TS} ts
   * @param {string} root
   * @param {number} maxProbes Budget of type-check passes (each pass re-checks one file).
   */
  constructor(ts, root, maxProbes) {
    this.ts = ts;
    this.root = norm(root);
    this.maxProbes = maxProbes;
    this.probesRun = 0;
    /** @type {Map<string, ParsedCommandLine | null>} */
    this.configs = new Map();
    /** @type {Map<string, Project | null>} */
    this.projects = new Map();
    /** @type {Map<string, Project | null>} */
    this.fileProjects = new Map();
  }

  /**
   * @param {string} configPath
   * @returns {ParsedCommandLine | null}
   */
  parseConfig(configPath) {
    const key = norm(configPath);
    if (this.configs.has(key)) return this.configs.get(key) ?? null;
    const ts = this.ts;
    /** @type {ParsedCommandLine | null} */
    let parsed = null;
    try {
      parsed =
        ts.getParsedCommandLineOfConfigFile(key, {}, {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        }) ?? null;
    } catch {
      parsed = null;
    }
    this.configs.set(key, parsed);
    return parsed;
  }

  /**
   * @param {string} configPath
   * @param {ParsedCommandLine} parsed
   * @returns {Project | null}
   */
  project(configPath, parsed) {
    const key = norm(configPath);
    if (this.projects.has(key)) return this.projects.get(key) ?? null;
    const ts = this.ts;
    /** @type {Project | null} */
    let project = null;
    try {
      const options = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined };
      const host = ts.createCompilerHost(options, true);
      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options,
        host,
        projectReferences: parsed.projectReferences,
      });
      project = { program, parsed: { ...parsed, options }, host };
    } catch {
      project = null;
    }
    this.projects.set(key, project);
    return project;
  }

  /**
   * Finds the tsconfig project (following `references`) whose files include `absFile`.
   * @param {string} absFile
   * @returns {Project | null}
   */
  projectFor(absFile) {
    const file = norm(absFile);
    if (this.fileProjects.has(file)) return this.fileProjects.get(file) ?? null;
    const ts = this.ts;
    /** @type {Project | null} */
    let found = null;
    const first = ts.findConfigFile(path.dirname(file), ts.sys.fileExists, 'tsconfig.json');
    if (first !== undefined && norm(first).startsWith(`${this.root}/`)) {
      const queue = [norm(first)];
      const seen = new Set();
      while (queue.length > 0 && found === null) {
        const cfg = /** @type {string} */ (queue.shift());
        if (seen.has(cfg)) continue;
        seen.add(cfg);
        const parsed = this.parseConfig(cfg);
        if (parsed === null) continue;
        if (parsed.fileNames.some((f) => norm(f) === file)) {
          found = this.project(cfg, parsed);
          break;
        }
        for (const ref of parsed.projectReferences ?? []) {
          queue.push(norm(ts.resolveProjectReferencePath(ref)));
        }
      }
    }
    this.fileProjects.set(file, found);
    return found;
  }

  /**
   * @param {string} absFile
   * @returns {boolean}
   */
  hasTypes(absFile) {
    return this.projectFor(absFile) !== null;
  }

  /**
   * Edit that replaces the literal's text (template: its head) with the probe value.
   * @param {Literal} lit
   * @param {SourceFile} sf
   * @returns {Edit}
   */
  editFor(lit, sf) {
    const node = lit.node;
    if (this.ts.isTemplateExpression(node)) {
      return { start: node.head.getStart(sf) + 1, end: node.head.end - 2, text: PROBE };
    }
    return { start: node.getStart(sf) + 1, end: node.end - 1, text: PROBE };
  }

  /**
   * Re-checks `absFile` with the given edits applied.
   * @param {Project} project
   * @param {string} absFile
   * @param {string} text
   * @param {Edit[]} edits
   * @returns {number[] | null} Original-text start offsets of the diagnostics, or null on failure.
   */
  check(project, absFile, text, edits) {
    if (this.probesRun >= this.maxProbes) return null;
    this.probesRun += 1;
    const ts = this.ts;
    const target = norm(absFile);
    const { text: modified, toOriginal } = applyEdits(text, edits);
    const program = project.program;
    /** @type {CompilerHost} */
    const host = {
      ...project.host,
      getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreate) => {
        if (norm(fileName) === target) return ts.createSourceFile(fileName, modified, languageVersionOrOptions, true);
        return (
          program.getSourceFile(fileName) ??
          project.host.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate)
        );
      },
    };
    try {
      const probed = ts.createProgram({
        rootNames: project.parsed.fileNames,
        options: project.parsed.options,
        host,
        oldProgram: program,
        projectReferences: project.parsed.projectReferences,
      });
      const sf = probed.getSourceFile(absFile);
      if (sf === undefined) return null;
      return encodeDiagnostics(probed.getSemanticDiagnostics(sf), toOriginal);
    } catch {
      return null;
    }
  }

  /**
   * Classifies every given literal of one file.
   * @param {string} absFile
   * @param {Literal[]} lits Pending literals of the file, in source order.
   * @param {SourceFile} ownSf The file as parsed by the scanner (same text as on disk).
   * @returns {(boolean | null)[]} Per literal: true = constrained by the type system, false = not,
   *   null = unknown (no tsconfig covers the file, file differs from disk, or budget spent).
   */
  probeFile(absFile, lits, ownSf) {
    /** @type {(boolean | null)[]} */
    const results = lits.map(() => null);
    const project = this.projectFor(absFile);
    if (project === null || lits.length === 0) return results;
    const ts = this.ts;
    const sf = project.program.getSourceFile(absFile);
    if (sf === undefined || sf.text !== ownSf.text) return results;
    const text = sf.text;

    const baselineRaw = encodeDiagnostics(project.program.getSemanticDiagnostics(sf), (pos) => pos);
    const edits = lits.map((l) => this.editFor(l, ownSf));
    const own = lits.map((l) => /** @type {[number, number]} */ ([l.node.getStart(ownSf), l.node.end]));
    const regions = lits.map((l) => probeRegion(ts, l.node, ownSf));
    const statements = lits.map((l) => enclosingStatementSpan(ts, l.node, ownSf));

    /**
     * New diagnostics (original offsets) of a check, compared with the baseline as a multiset.
     * @param {number[]} encoded
     * @returns {number[]}
     */
    const fresh = (encoded) => {
      /** @type {Map<number, number>} */
      const left = new Map();
      for (const k of baselineRaw) left.set(k, (left.get(k) ?? 0) + 1);
      /** @type {number[]} */
      const out = [];
      for (const k of encoded) {
        const n = left.get(k) ?? 0;
        if (n > 0) left.set(k, n - 1);
        else out.push(Math.floor(k / CODE_RADIX));
      }
      return out;
    };

    let active = lits.map((_, i) => i);
    /** @type {Set<number>} */
    const individual = new Set();
    for (let round = 0; round < MAX_ROUNDS && active.length > 0; round += 1) {
      const encoded = this.check(
        project,
        absFile,
        text,
        active.map((i) => edits[i]),
      );
      if (encoded === null) return results;
      /** @type {Set<number>} */
      const attributed = new Set();
      let progressed = false;
      for (const pos of fresh(encoded)) {
        const byOwn = active.filter((i) => within(pos, own[i]));
        if (byOwn.length === 1) {
          attributed.add(byOwn[0]);
          continue;
        }
        const byRegion = active.filter((i) => within(pos, regions[i]));
        if (byRegion.length === 1) {
          attributed.add(byRegion[0]);
          continue;
        }
        const pool = byRegion.length > 1 ? byRegion : active.filter((i) => within(pos, statements[i]));
        for (const i of pool) {
          if (!individual.has(i)) {
            individual.add(i);
            progressed = true;
          }
        }
      }
      for (const i of attributed) results[i] = true;
      const before = active.length;
      active = active.filter((i) => !attributed.has(i) && !individual.has(i));
      if (attributed.size === 0 && !progressed) {
        for (const i of active) results[i] = false;
        active = [];
      } else if (active.length === before) {
        break;
      }
    }

    for (const i of [...individual].sort((a, b) => a - b)) {
      const encoded = this.check(project, absFile, text, [edits[i]]);
      if (encoded === null) {
        results[i] = null;
        continue;
      }
      results[i] = fresh(encoded).some((pos) => within(pos, statements[i]));
    }
    return results;
  }
}
