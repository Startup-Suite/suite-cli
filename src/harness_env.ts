/**
 * The environment a harness child process gets: built from an ALLOWLIST, never
 * by copying `process.env` and deleting what looks dangerous.
 *
 * A denylist fails open — the variable nobody thought of is the one that
 * leaks. So a child sees only:
 *
 *   PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, TZ, TERM, TMUX_TMPDIR,
 *   LANG, LC_*, and the XDG base-directory variables
 *
 * plus whatever the caller passes as `overrides`, which is how a harness gets
 * its OWN directory variables (HERMES_HOME, OPENCLAW_STATE_DIR, ...). The
 * XDG variables are on the list because per-root isolation depends on them: a
 * throwaway HOME whose XDG_* point elsewhere would silently reach real state.
 *
 * Three families are NEVER inherited, even though the allowlist already
 * excludes them — stated so a later widening of the allowlist cannot quietly
 * reintroduce them:
 *
 *   SUITE_*     the operator's own Suite session, token included
 *   HERMES_*    another Hermes install's home and profile
 *   OPENCLAW_*  another OpenClaw's state dir and config path — hive's live
 *               gateway is exactly such an install
 *
 * An override may set a HERMES_* or OPENCLAW_* name (that is its purpose),
 * but never a SUITE_* token variable: a harness that needs the token gets a
 * ref it resolves itself, or the value on a stdin pipe.
 */
import { createStore, spawnWithSecrets, type CredentialStore, type SpawnResult } from "./secrets.ts";

type Env = Record<string, string | undefined>;

export const ALLOWED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TZ",
  "TERM",
  "TMUX_TMPDIR",
  "LANG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

/** Prefixes never inherited from the parent. */
export const STRIPPED_PREFIXES = ["SUITE_", "HERMES_", "OPENCLAW_"] as const;

const isAllowed = (name: string): boolean =>
  (ALLOWED_ENV as readonly string[]).includes(name) || name.startsWith("LC_");

const isStripped = (name: string): boolean => STRIPPED_PREFIXES.some((p) => name.startsWith(p));

/** A SUITE_* name that could carry a credential. */
const isSuiteSecretName = (name: string): boolean => name.startsWith("SUITE_") && /TOKEN|SECRET|KEY|PASS/.test(name);

export class ForbiddenOverride extends Error {
  constructor(name: string) {
    super(`harnessChildEnv refuses to set ${name}: a harness child never receives a Suite credential in its environment`);
    this.name = "ForbiddenOverride";
  }
}

/**
 * Build a child environment from `base` (normally `process.env`) and the
 * harness's own `overrides`. Pure: returns a new object, reads nothing else.
 */
export function harnessChildEnv(base: Env, overrides: Env = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isStripped(name) || !isAllowed(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (isSuiteSecretName(name)) throw new ForbiddenOverride(name);
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  return out;
}

export interface HarnessSpawnOptions {
  cwd?: string;
  /** The FULL child env, normally from {@link harnessChildEnv}. */
  env: Record<string, string>;
  /** A secret for the child's stdin pipe. Registered in the store so argv is checked against it. */
  stdinSecret?: string;
  /** Extra secret values the argv and `env` must not contain (e.g. a model key). */
  secrets?: string[];
  /**
   * The ONE sanctioned env route for a secret, for a short-lived child whose
   * upstream reads it only from the environment (e.g. an onboarding step's
   * model key). Merged last; its values are still checked against argv.
   */
  secretEnv?: Record<string, string>;
}

/**
 * Run a harness command. Goes through {@link spawnWithSecrets} WITHOUT
 * `allowSecretsInArgv`, so an argv that carries any known secret throws before
 * the child exists.
 */
export async function spawnHarness(argv: string[], options: HarnessSpawnOptions): Promise<SpawnResult> {
  const store: CredentialStore = createStore();
  const known = [
    ...(options.secrets ?? []),
    ...(options.stdinSecret !== undefined ? [options.stdinSecret] : []),
    ...Object.values(options.secretEnv ?? {}),
  ];
  known.forEach((v, i) => store.set(`secret-${i}`, v));
  for (const [name, value] of Object.entries(options.env)) {
    if (known.some((s) => s.length > 0 && value.includes(s))) {
      throw new Error(`spawnHarness refuses a child env whose ${name} carries a secret value`);
    }
  }
  return await spawnWithSecrets(argv, store, {
    cwd: options.cwd,
    env: options.env,
    secretEnv: options.secretEnv,
    stdin: options.stdinSecret,
  });
}
