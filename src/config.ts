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
  /**
   * Where halt telemetry is shipped, if anywhere. Optional by construction:
   * an install that never sets it simply emits nothing, so this cannot break
   * an existing box or make the CLI depend on one operator's observability
   * stack. Contains no credential — the token lives in the secret store, the
   * same split the rest of this config uses.
   */
  telemetry?: TelemetrySinkConfig;
  /**
   * A REFERENCE to the runtime token, written by the stamp verbs: the string
   * `file:<absolute path>` or `keychain:<item>`. Never the value — parseConfig
   * drops anything not spelled as a ref, so a literal cannot round-trip.
   */
  tokenRef?: string;
  /** The keychain service a `keychain:` ref is looked up under. A name, not a secret. */
  keychainService?: string;
  /**
   * `suite init --token-from-env VAR`: the NAME of the variable the harness
   * wiring reads the token from at launch. A name, never a value, so it can
   * live here. When set, the token itself is not saved to disk.
   */
  tokenEnv?: string;
}

export interface TelemetrySinkConfig {
  /** Base URL of the collector, e.g. https://observe.example.invalid:5080 */
  endpoint: string;
  org: string;
  stream: string;
}

export const DEFAULT_SESSION_NAMING: SessionNaming = "cwd";

/** Keys permitted in the serialised document. Anything else is dropped. */
const ALLOWED_KEYS = [
  "suiteUrl",
  "runtimeId",
  "headerNames",
  "sessionNaming",
  "telemetry",
  "tokenRef",
  "keychainService",
  "tokenEnv",
] as const;

/** Mirrors token_ref.ts; duplicated so config.ts keeps no import of the resolver. */
/** A shell variable name, and nothing that could carry a value. */
const isEnvName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);

const isRefString = (v: unknown): v is string =>
  typeof v === "string" && (v.startsWith("file:") || v.startsWith("keychain:"));

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
    } else if (key === "telemetry") {
      // Omit entirely when unset, so an untouched config is byte-identical to
      // what it was before this feature existed.
      if (config.telemetry) out[key] = config.telemetry;
    } else if (key === "tokenRef") {
      // Omitted when unset (byte-identical to before), and never a non-ref.
      if (config.tokenRef !== undefined) {
        if (!isRefString(config.tokenRef)) throw new Error("config.tokenRef must be a file: or keychain: ref");
        out[key] = config.tokenRef;
      }
    } else if (key === "keychainService") {
      if (config.keychainService !== undefined && config.keychainService !== "") out[key] = config.keychainService;
    } else if (key === "tokenEnv") {
      // Omitted when unset. Refused when it is not a variable NAME: this field
      // must never become a place a token value can be written.
      if (config.tokenEnv !== undefined) {
        if (!isEnvName(config.tokenEnv)) throw new Error("config.tokenEnv must be an environment variable name");
        out[key] = config.tokenEnv;
      }
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
    ...parseTelemetry(raw.telemetry),
    ...(isRefString(raw.tokenRef) ? { tokenRef: raw.tokenRef } : {}),
    ...(typeof raw.keychainService === "string" && raw.keychainService !== ""
      ? { keychainService: raw.keychainService }
      : {}),
    ...(isEnvName(raw.tokenEnv) ? { tokenEnv: raw.tokenEnv } : {}),
  };
}

/** Accept a telemetry block only when all three fields are real strings. */
function parseTelemetry(raw: unknown): { telemetry?: TelemetrySinkConfig } {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const { endpoint, org, stream } = r;
  if (typeof endpoint !== "string" || typeof org !== "string" || typeof stream !== "string") return {};
  if (endpoint === "" || org === "" || stream === "") return {};
  return { telemetry: { endpoint, org, stream } };
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
