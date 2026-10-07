/**
 * The INSTALL CONNECTION: which Suite this machine talks to, and as whom.
 *
 * An install is a server — a URL, a runtime id and a token. Connecting a
 * machine to one is harness-neutral: it is the same three values whether the
 * agent here is Claude Code, DeepSeek, Hermes or OpenClaw. Everything a
 * particular harness needs on top (an MCP entry, a plugin checkout, a
 * CLAUDE.md) is that harness's WIRING, and is done by the harness's own verb
 * from what this module saves. See `src/claude_wiring.ts`.
 *
 * WHERE EACH VALUE LIVES — PER AGENT FOLDER (see agent_connections.ts):
 *   - URL, runtime id, header NAMES: `<configDir>/agents/<key>.json` (no
 *     secret, ever).
 *   - the token and header VALUES: `<configDir>/agents/<key>.credentials.json`,
 *     mode 0600, outside the agent folder and any repository.
 *   - `--token-from-env VAR`: only the variable NAME is saved (`tokenEnv`) and
 *     the token is not written to disk at all.
 *
 *   Up to 0.7.0 this was ONE connection per machine (config.json +
 *   credentials.json), so connecting a second agent folder re-pointed the
 *   first. Nothing in this module writes those two files any more, and nothing
 *   here reads them to identify a folder; credentialsPath/readCredentials
 *   remain for reporting the legacy connection only.
 *
 * NO CHICKEN AND EGG. {@link ensureConnection} is what every harness verb calls
 * first: with a saved connection it returns it without a prompt; without one it
 * asks the same questions `suite init` asks, inline, and saves the answers. So
 * `suite init` then `suite claude`, and `suite claude` straight away, both work.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentConfig,
  canonicalDir,
  legacyConnection,
  readAgentConnection,
  readAgentRecordExact,
  readAgentSecrets,
  writeAgentConnection,
} from "./agent_connections.ts";
import type { SuiteConfig } from "./config.ts";
import { configDir } from "./paths.ts";
import { solicitCredentials, TOKEN_KEY, type CredentialStore, type Prompter } from "./secrets.ts";
import { row } from "./ui.ts";

type Env = Record<string, string | undefined>;

/** The LEGACY machine-level secrets file. Read for reporting only; never written. */
export const CREDENTIALS_FILENAME = "credentials.json";

export function credentialsPath(env: Env = process.env): string {
  return resolve(configDir(env), CREDENTIALS_FILENAME);
}

export interface SavedCredentials {
  token: string;
  headers: Record<string, string>;
}

/**
 * The LEGACY machine-level secrets, or null when there are none. Never throws.
 * For reporting only: no folder is identified or wired from it.
 */
export function readCredentials(env: Env = process.env): SavedCredentials | null {
  const target = credentialsPath(env);
  if (!existsSync(target)) return null;
  try {
    const raw = JSON.parse(readFileSync(target, "utf8")) as { token?: unknown; headers?: unknown };
    const headers: Record<string, string> = {};
    if (typeof raw.headers === "object" && raw.headers !== null) {
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v === "string" && v !== "") headers[k] = v;
      }
    }
    return { token: typeof raw.token === "string" ? raw.token : "", headers };
  } catch {
    return null;
  }
}

/** True when the config names an install: a URL and a runtime id. */
export function hasConnection(config: SuiteConfig | null): config is SuiteConfig {
  return config !== null && config.suiteUrl !== "" && config.runtimeId !== "";
}

export const FEDERATE_HINT = [
  "  Open Suite in a browser, go to Agent Resources, and click Federate on this",
  "  runtime. Copy the URL, the runtime id and the token it shows you.",
].join("\n");

export interface ConnectionDeps {
  env: Env;
  prompter: Prompter;
  store: CredentialStore;
  out(line: string): void;
}

export interface ConnectOptions {
  /** `--token-from-env VAR`: record the name, keep the token off disk. */
  tokenFromEnv?: string;
}

/**
 * Ask for `dir`'s whole connection — URL, runtime id, token, extra headers —
 * and save it as `dir`'s record. What `suite init` runs, and what a harness
 * verb runs inline when the folder has nothing saved yet.
 *
 * DEFAULTS. The URL may default from this folder's own record, else from the
 * legacy machine connection (a URL names an install, not an agent). The
 * runtime id defaults ONLY from this folder's own record: offering the legacy
 * or a neighbour's id is how one agent ends up connecting as another.
 */
export async function promptConnection(
  deps: ConnectionDeps,
  dir: string,
  options: ConnectOptions = {},
): Promise<{ config: SuiteConfig; configPath: string; credentialsPath: string }> {
  const own = readAgentRecordExact(deps.env, dir)?.record ?? null;
  const urlDefault = own?.suiteUrl || legacyConnection(deps.env)?.suiteUrl || "";
  const idDefault = own?.runtimeId ?? "";
  deps.out("");
  deps.out(FEDERATE_HINT);
  deps.out("");
  const suiteUrl = (await deps.prompter.ask(`suite url${urlDefault ? ` [${urlDefault}]` : ""}: `)).trim() || urlDefault;
  const runtimeId = (await deps.prompter.ask(`runtime id${idDefault ? ` [${idDefault}]` : ""}: `)).trim() || idDefault;
  if (suiteUrl === "" || runtimeId === "") throw new Error("suite url and runtime id are both required");
  const { headerNames } = await solicitCredentials(deps.prompter, deps.store);
  // A blank token on a re-run keeps THIS FOLDER's saved token, the way a blank
  // URL keeps the saved URL — rather than overwriting a working token with
  // nothing. Never another folder's, and never the legacy one.
  const previous = own === null ? "" : (readAgentSecrets(deps.env, dir)?.token ?? "");
  if ((deps.store.get(TOKEN_KEY) ?? "") === "" && previous !== "") {
    deps.store.set(TOKEN_KEY, previous);
    deps.out(row("token", "kept", "blank answer; the saved token is unchanged"));
  }

  const config: SuiteConfig = {
    ...agentConfig(deps.env, own),
    suiteUrl,
    runtimeId,
    headerNames,
  };
  if (options.tokenFromEnv !== undefined) config.tokenEnv = options.tokenFromEnv;
  else delete config.tokenEnv;
  const paths = saveConnection(deps, dir, config);
  return { config, ...paths };
}

/** Persist `dir`'s record and what the store holds for it. The token is skipped for an env reference. */
function saveConnection(deps: ConnectionDeps, dir: string, config: SuiteConfig): { configPath: string; credentialsPath: string } {
  const headers: Record<string, string> = {};
  for (const name of config.headerNames) {
    const value = deps.store.get(name);
    if (value !== undefined && value !== "") headers[name] = value;
  }
  const token = config.tokenEnv === undefined ? (deps.store.get(TOKEN_KEY) ?? "") : "";
  return writeAgentConnection(deps.env, dir, config, { token, headers });
}

/** Load `dir`'s saved secrets into the store. Returns whether a token was found. */
export function loadSavedSecrets(env: Env, dir: string, config: SuiteConfig, store: CredentialStore): boolean {
  const creds = readAgentSecrets(env, dir);
  if (creds !== null) {
    if (creds.token !== "") store.set(TOKEN_KEY, creds.token);
    for (const name of config.headerNames) {
      const value = creds.headers[name];
      if (value !== undefined) store.set(name, value);
    }
  }
  return (store.get(TOKEN_KEY) ?? "") !== "";
}

export interface EnsuredConnection {
  config: SuiteConfig;
  /** The folder whose record answered: `dir`, or its git work tree root. */
  dir: string;
  /** True when the operator was asked for the connection during this call. */
  prompted: boolean;
}

/**
 * The connection the agent in `dir` runs on: its saved record, or — when the
 * folder has none — the init prompts, inline, right now, saved as `dir`'s
 * record. Never "run suite init first", and never another folder's or the
 * legacy machine connection.
 *
 * Saved secrets are loaded into `deps.store` either way.
 */
export async function ensureConnection(deps: ConnectionDeps, dir: string): Promise<EnsuredConnection> {
  const found = readAgentConnection(deps.env, dir).connection;
  if (found !== null && hasConnection(agentConfig(deps.env, found.record))) {
    const config = agentConfig(deps.env, found.record);
    loadSavedSecrets(deps.env, found.record.dir, config, deps.store);
    return { config, dir: found.record.dir, prompted: false };
  }
  deps.out(row("suite", "not connected", `${dir} has no Suite connection yet; connecting it now`));
  const { config, configPath } = await promptConnection(deps, dir);
  deps.out(row("config", configPath));
  return { config, dir: canonicalDir(dir), prompted: true };
}

/**
 * The token, asked for ONLY when a harness needs to write it and none is saved
 * for this folder. URL and runtime id are not asked again. The answer is saved
 * to `dir`'s record, so this happens at most once.
 */
export async function ensureToken(deps: ConnectionDeps, dir: string, config: SuiteConfig): Promise<SuiteConfig> {
  if (config.tokenEnv !== undefined) return config;
  if ((deps.store.get(TOKEN_KEY) ?? "") !== "") return config;
  deps.out(row("token", "not saved", "needed once to write the harness entries"));
  const { headerNames } = await solicitCredentials(deps.prompter, deps.store);
  const next: SuiteConfig = { ...config, headerNames };
  saveConnection(deps, dir, next);
  return next;
}
