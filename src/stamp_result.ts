/**
 * The machine contract of `suite <harness> --stamp-only`.
 *
 * Other tools call the stamp verbs rather than reimplementing them, so what
 * they read back is an interface, not a log. Three rules hold it:
 *
 *  1. ONE DOCUMENT. Under `--stamp-only` stdout carries exactly one JSON
 *     document (indent 2, trailing newline) and nothing else. Every line meant
 *     for a human goes to stderr. {@link divertStdout} enforces this for the
 *     whole run, so a stray `console.log` in a writer cannot corrupt stdout.
 *  2. ADDITIVE ONLY. `contract_version` is 1. A later field may be added; an
 *     existing one is never renamed, retyped or removed without bumping it.
 *  3. EXIT CODES MEAN ONE THING EACH, aligned with core's setup CLI:
 *       0 ok        stamped, and the post-write check passed
 *       1 failed    the harness or its check failed, or its output was unreadable
 *       2 refused   a literal secret, a bad ref, an unsupported header, a busy
 *                   port, an absent harness without its install flag
 *       3 blocked   a human has to act first (a locked keychain, a missing item)
 *
 * NO SECRET VALUE EVER APPEARS HERE. The token is reported as its REF string
 * (`file:/abs/path` or `keychain:<item>`), and {@link renderStampResult}
 * redacts any value it is told about as a last line of defence.
 */

export const CONTRACT_VERSION = 1 as const;

export const EXIT_OK = 0 as const;
export const EXIT_FAILED = 1 as const;
export const EXIT_REFUSED = 2 as const;
export const EXIT_BLOCKED = 3 as const;

export type StampExitCode = typeof EXIT_OK | typeof EXIT_FAILED | typeof EXIT_REFUSED | typeof EXIT_BLOCKED;

/** Every exit code the contract defines, for docs and tests to enumerate. */
export const EXIT_CODES: Record<StampExitCode, string> = {
  0: "ok",
  1: "failed",
  2: "refused",
  3: "blocked on a human",
};

export type ActionOutcome = "written" | "unchanged" | "repaired";

export interface StampAction {
  /** What sort of write, e.g. `identity`, `config_set`, `plugin_install`. */
  kind: string;
  /** What it writes to: a path, a config key, a package. Never a value. */
  target: string;
  outcome: ActionOutcome;
  /**
   * Whether the disk now holds what `outcome` names. MEASURED, not planned:
   * a write is `applied` only once it has been performed (and, where the
   * writer can check, read back); an `unchanged` action is applied because
   * nothing had to be written. A run that stops part-way reports the writes
   * it never reached as `applied: false`, so a failed stamp does not claim
   * writes that did not happen.
   */
  applied: boolean;
}

/** A planned action: not applied until a writer performs it. `unchanged` needs no write. */
export function planned(kind: string, target: string, outcome: ActionOutcome): StampAction {
  return { kind, target, outcome, applied: outcome === "unchanged" };
}

/** Whether an action changed the disk in this run. */
export const changedTheDisk = (a: StampAction): boolean => a.applied && a.outcome !== "unchanged";

export type Verdict = "pass" | "fail" | "unparseable";

export interface ValidationCheck {
  /** The command as a display string. argv never carries a secret here. */
  command: string;
  exit_code: number;
  verdict: Verdict;
  /** The raw line we could not read, carried so a failure can show it. */
  raw?: string;
}

export interface ValidationVerdict {
  verdict: Verdict;
  checks: ValidationCheck[];
}

export interface HumanStep {
  /** e.g. `start_agent_session`, `keychain_unlock`, `install_tmux`. */
  kind: string;
  text: string;
  /** The exact command a human runs, when there is one. Never carries a value. Additive (0.8.0). */
  command?: string;
  /** An official page explaining the step. Additive (0.8.0). */
  url?: string;
}

export interface StampError {
  code: string;
  message: string;
}

export interface StampResult {
  contract_version: typeof CONTRACT_VERSION;
  ok: boolean;
  harness: string;
  agent: { name: string; root: string; runtime_id: string };
  token_ref: string | null;
  changed: boolean;
  actions: StampAction[];
  validation: ValidationVerdict;
  harness_version: string | null;
  writer_version: number;
  warnings: string[];
  human_steps: HumanStep[];
  error: StampError | null;
}

/** Top-level field names, in emission order. The README contract names each. */
export const RESULT_FIELDS = [
  "contract_version",
  "ok",
  "harness",
  "agent",
  "token_ref",
  "changed",
  "actions",
  "validation",
  "harness_version",
  "writer_version",
  "warnings",
  "human_steps",
  "error",
] as const satisfies readonly (keyof StampResult)[];

/**
 * A stamp that stops with a defined exit code.
 *
 * Thrown anywhere in a stamp run and caught once by the runner, which turns it
 * into the `error` field and the process exit code. The message must name
 * paths, modes, flags and item NAMES only — never a value.
 */
export class StampFailure extends Error {
  readonly exitCode: typeof EXIT_FAILED | typeof EXIT_REFUSED | typeof EXIT_BLOCKED;
  readonly code: string;
  readonly humanSteps: HumanStep[];

  constructor(
    exitCode: typeof EXIT_FAILED | typeof EXIT_REFUSED | typeof EXIT_BLOCKED,
    code: string,
    message: string,
    humanSteps: HumanStep[] = [],
  ) {
    super(message);
    this.name = "StampFailure";
    this.exitCode = exitCode;
    this.code = code;
    this.humanSteps = humanSteps;
  }
}

export const refused = (code: string, message: string): StampFailure =>
  new StampFailure(EXIT_REFUSED, code, message);

/** A result skeleton for a run that has not got far enough to fill it in. */
export function emptyResult(harness: string, writerVersion: number): StampResult {
  return {
    contract_version: CONTRACT_VERSION,
    ok: false,
    harness,
    agent: { name: "", root: "", runtime_id: "" },
    token_ref: null,
    changed: false,
    actions: [],
    validation: { verdict: "fail", checks: [] },
    harness_version: null,
    writer_version: writerVersion,
    warnings: [],
    human_steps: [],
    error: null,
  };
}

/** Fold per-check verdicts into one. Any fail fails; else any unparseable is unparseable. */
export function aggregateVerdict(checks: ValidationCheck[]): Verdict {
  if (checks.length === 0) return "fail";
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "unparseable")) return "unparseable";
  return "pass";
}

/** The process exit code a result implies. */
export function exitCodeFor(result: StampResult, failure: StampFailure | null): StampExitCode {
  if (failure !== null) return failure.exitCode;
  if (result.error !== null) return EXIT_FAILED;
  return result.ok ? EXIT_OK : EXIT_FAILED;
}

/** Replace every occurrence of each secret with a fixed marker. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * The exact bytes written to stdout: one JSON document, indent 2, newline.
 * Field order is {@link RESULT_FIELDS} so the output diffs cleanly.
 */
export function renderStampResult(result: StampResult, secrets: readonly string[] = []): string {
  const ordered: Record<string, unknown> = {};
  for (const key of RESULT_FIELDS) ordered[key] = result[key];
  return redact(`${JSON.stringify(ordered, null, 2)}\n`, secrets);
}

export interface StampIO {
  /** The one document. Called exactly once per run. */
  stdout(text: string): void;
  /** Human-facing lines. */
  stderr(text: string): void;
}

export const processIO: StampIO = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
};

/**
 * Run `fn` with every write to process stdout redirected to stderr, and hand
 * it the ORIGINAL stdout writer for the one document. This is what makes
 * "exactly one JSON document" a property of the process rather than of each
 * writer's discipline.
 */
export async function divertStdout<T>(fn: (io: StampIO) => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const toStderr = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  process.stdout.write = toStderr;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn({ stdout: (t) => void original(t), stderr: (t) => void process.stderr.write(t) });
  } finally {
    process.stdout.write = original;
    console.log = originalLog;
  }
}
