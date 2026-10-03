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
 * WHERE EACH VALUE LIVES:
 *   - URL, runtime id, header NAMES: `config.json` (no secret, ever — see
 *     config.ts).
 *   - the token and header VALUES: `credentials.json` beside it, mode 0600,
 *     outside any repository (the same write guard config.json uses). Before
 *     this file existed the token was kept nowhere but inside Claude Code's MCP
 *     entries, so no other harness — and no later `suite claude` — could reuse
 *     it without asking again.
 *   - `--token-from-env VAR`: only the variable NAME is saved (config
 *     `tokenEnv`) and the token is not written to disk at all.
 *
 * NO CHICKEN AND EGG. {@link ensureConnection} is what every harness verb calls
 * first: with a saved connection it returns it without a prompt; without one it
 * asks the same questions `suite init` asks, inline, and saves the answers. So
 * `suite init` then `suite claude`, and `suite claude` straight away, both work.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readConfig, writeConfig, type SuiteConfig } from "./config.ts";
import { assertWritable, configDir, gitProbe } from "./paths.ts";
import { solicitCredentials, TOKEN_KEY, type CredentialStore, type Prompter } from "./secrets.ts";
import { row } from "./ui.ts";

type Env = Record<string, string | undefined>;

export const CREDENTIALS_FILENAME = "credentials.json";

export function credentialsPath(env: Env = process.env): string {
  return resolve(configDir(env), CREDENTIALS_FILENAME);
}

export interface SavedCredentials {
  token: string;
  headers: Record<string, string>;
}

/**
 * Write the secrets file, mode 0600, refusing a destination inside a repo.
 *
 * The mode is applied on create AND re-applied after, because `writeFileSync`'s
 * `mode` only takes effect when the file is created: a pre-existing file with
 * looser permissions would otherwise keep them.
 */
export function writeCredentials(env: Env, creds: SavedCredentials): string {
  const target = credentialsPath(env);
  assertWritable(target, gitProbe);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const body = { token: creds.token, headers: creds.headers };
  writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

/** The saved secrets, or null when there are none. Never throws on a bad file. */
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
 * Ask for the whole connection — URL, runtime id, token, extra headers — and
 * save it. What `suite init` runs, and what a harness verb runs inline when
 * there is nothing saved yet. Existing values are offered as defaults.
 */
export async function promptConnection(
  deps: ConnectionDeps,
  options: ConnectOptions = {},
): Promise<{ config: SuiteConfig; configPath: string }> {
  const existing = await readConfig({ env: deps.env });
  deps.out("");
  deps.out(FEDERATE_HINT);
  deps.out("");
  const suiteUrl =
    (await deps.prompter.ask(`suite url${existing?.suiteUrl ? ` [${existing.suiteUrl}]` : ""}: `)).trim() ||
    existing?.suiteUrl ||
    "";
  const runtimeId =
    (await deps.prompter.ask(`runtime id${existing?.runtimeId ? ` [${existing.runtimeId}]` : ""}: `)).trim() ||
    existing?.runtimeId ||
    "";
  if (suiteUrl === "" || runtimeId === "") throw new Error("suite url and runtime id are both required");
  const { headerNames } = await solicitCredentials(deps.prompter, deps.store);
  // A blank token on a re-run keeps the saved one, the way a blank URL keeps
  // the saved URL — rather than overwriting a working token with nothing.
  const previous = readCredentials(deps.env)?.token ?? "";
  if ((deps.store.get(TOKEN_KEY) ?? "") === "" && previous !== "") {
    deps.store.set(TOKEN_KEY, previous);
    deps.out(row("token", "kept", "blank answer; the saved token is unchanged"));
  }

  const config: SuiteConfig = {
    ...(existing ?? {}),
    suiteUrl,
    runtimeId,
    headerNames,
    sessionNaming: existing?.sessionNaming ?? "cwd",
  };
  if (options.tokenFromEnv !== undefined) config.tokenEnv = options.tokenFromEnv;
  else delete config.tokenEnv;
  const configPath = await writeConfig(config, { env: deps.env });
  saveSecrets(deps, config);
  return { config, configPath };
}

/** Persist what the store holds for this config. The token is skipped for an env reference. */
function saveSecrets(deps: ConnectionDeps, config: SuiteConfig): void {
  const headers: Record<string, string> = {};
  for (const name of config.headerNames) {
    const value = deps.store.get(name);
    if (value !== undefined && value !== "") headers[name] = value;
  }
  const token = config.tokenEnv === undefined ? (deps.store.get(TOKEN_KEY) ?? "") : "";
  writeCredentials(deps.env, { token, headers });
}

/** Load the saved secrets into the store. Returns whether a token was found. */
export function loadSavedSecrets(env: Env, config: SuiteConfig, store: CredentialStore): boolean {
  const creds = readCredentials(env);
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
  /** True when the operator was asked for the connection during this call. */
  prompted: boolean;
}

/**
 * The connection a harness verb runs on: the saved one, or — when this machine
 * has none — the init prompts, inline, right now. Never "run suite init first".
 *
 * Saved secrets are loaded into `deps.store` either way.
 */
export async function ensureConnection(deps: ConnectionDeps): Promise<EnsuredConnection> {
  const saved = await readConfig({ env: deps.env });
  if (hasConnection(saved)) {
    loadSavedSecrets(deps.env, saved, deps.store);
    return { config: saved, prompted: false };
  }
  deps.out(row("suite", "not connected", "this machine has no Suite install yet; connecting it now"));
  const { config, configPath } = await promptConnection(deps);
  deps.out(row("config", configPath));
  return { config, prompted: true };
}

/**
 * The token, asked for ONLY when a harness needs to write it and none is saved
 * — a machine set up by a CLI older than `credentials.json`. URL and runtime id
 * are not asked again. The answer is saved, so this happens at most once.
 */
export async function ensureToken(deps: ConnectionDeps, config: SuiteConfig): Promise<SuiteConfig> {
  if (config.tokenEnv !== undefined) return config;
  if ((deps.store.get(TOKEN_KEY) ?? "") !== "") return config;
  deps.out(row("token", "not saved", "needed once to write the harness entries"));
  const { headerNames } = await solicitCredentials(deps.prompter, deps.store);
  const next: SuiteConfig = { ...config, headerNames };
  await writeConfig(next, { env: deps.env });
  saveSecrets(deps, next);
  return next;
}
