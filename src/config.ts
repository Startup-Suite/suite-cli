/**
 * The repeatable-install config file.
 *
 * This file exists so a second machine can be brought to the same state by
 * copying one small JSON document. That makes what it may contain a security
 * question, not a convenience one:
 *
 *   IT HOLDS NO SECRET VALUES. Ever. Suite URL, runtime id, the NAMES of any
 *   extra headers the operator's deployment needs, and the session-naming
 *   preference. Header VALUES and the token live in the credential store
 *   (see secrets.ts) and are handed to child processes, never serialised here.
 *
 * Serialisation goes through an explicit whitelist rather than
 * `JSON.stringify(whatever)`, so a future field cannot leak a secret by being
 * added to the wrong object.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { assertWritable, configPath, type GitProbe, gitProbe } from "./paths.ts";

/** How stage 4 derives a tmux session name. Persisted so runs agree. */
export type SessionNaming = "cwd" | "runtime";

export interface SuiteConfig {
  /** Base URL of the Suite deployment, e.g. https://suite.example.invalid */
  suiteUrl: string;
  /** Runtime id this machine is federated as. Not a secret; the token is. */
  runtimeId: string;
  /**
   * Names only of any additional HTTP headers the operator's deployment
   * requires. Which headers those are is operator-specific; the CLI knows none
   * of them by name and hardcodes no defaults.
   */
  headerNames: string[];
  sessionNaming: SessionNaming;
}

export const DEFAULT_SESSION_NAMING: SessionNaming = "cwd";

/** Keys permitted in the serialised document. Anything else is dropped. */
const ALLOWED_KEYS = ["suiteUrl", "runtimeId", "headerNames", "sessionNaming"] as const;

export function emptyConfig(): SuiteConfig {
  return { suiteUrl: "", runtimeId: "", headerNames: [], sessionNaming: DEFAULT_SESSION_NAMING };
}

/**
 * Render the config as the exact bytes we would write. Pure, so a test can
 * assert on the serialised form without touching the filesystem.
 */
export function serializeConfig(config: SuiteConfig): string {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    if (key === "headerNames") {
      out[key] = [...config.headerNames].map((n) => n.trim()).filter((n) => n !== "");
    } else {
      out[key] = config[key];
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function parseConfig(text: string): SuiteConfig {
  const raw = JSON.parse(text) as Partial<Record<string, unknown>>;
  const base = emptyConfig();
  const names = raw.headerNames;
  return {
    suiteUrl: typeof raw.suiteUrl === "string" ? raw.suiteUrl : base.suiteUrl,
    runtimeId: typeof raw.runtimeId === "string" ? raw.runtimeId : base.runtimeId,
    headerNames: Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [],
    sessionNaming: raw.sessionNaming === "runtime" ? "runtime" : base.sessionNaming,
  };
}

export interface WriteOptions {
  /** Override the destination. Defaults to the user-scope config path. */
  path?: string;
  env?: Record<string, string | undefined>;
  probe?: GitProbe;
}

/**
 * Write the config, refusing outright if the destination sits in a git repo
 * that does not ignore it. The refusal happens BEFORE the directory is created
 * so a refused write leaves nothing at all behind.
 */
export async function writeConfig(config: SuiteConfig, options: WriteOptions = {}): Promise<string> {
  const target = options.path ?? configPath(options.env ?? process.env);
  assertWritable(target, options.probe ?? gitProbe);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await Bun.write(target, serializeConfig(config));
  return target;
}

export async function readConfig(options: WriteOptions = {}): Promise<SuiteConfig | null> {
  const target = options.path ?? configPath(options.env ?? process.env);
  const file = Bun.file(target);
  if (!(await file.exists())) return null;
  return parseConfig(await file.text());
}
