/**
 * ONE CONNECTION PER AGENT FOLDER.
 *
 * A machine hosts more than one agent, and each agent folder is federated as
 * its own runtime — often on different Suite installs. Through 0.7.0 the CLI
 * kept ONE connection per machine (`config.json` + `credentials.json`), so
 * `suite init` in a second folder silently re-pointed the first: the next
 * `suite claude` there saw its own MCP entries as "stale" against the machine
 * connection and rewrote them with the other agent's runtime, URL and token.
 *
 * So the connection is keyed by the folder:
 *
 *   <configDir>/agents/<key>.json              {dir, suiteUrl, runtimeId, headerNames, tokenEnv?, tokenRef?, keychainService?}
 *   <configDir>/agents/<key>.credentials.json  {token, headers}, mode 0600
 *
 * where key = `<sanitized basename>-<sha256(canonical dir)[0:16]>` — the same
 * readable-half-plus-digest rule tmux session names use (see tmux.ts).
 *
 * WHY ONE FILE PAIR PER FOLDER rather than a map inside config.json:
 *   - `suite init` in folder B physically cannot change folder A's bytes, so
 *     isolation is structural rather than a read-modify-write discipline;
 *   - restore and watch can start N `suite claude` at once with no lost update;
 *   - one key names both the config and the secret, so they rotate and delete
 *     together.
 *
 * BOTH FILES LIVE OUTSIDE THE AGENT FOLDER, under the user config dir, and go
 * through the same git write guard as config.json — the token is never written
 * inside an agent folder.
 *
 * The legacy machine connection in config.json / credentials.json is never
 * written or deleted here, and never used to identify or wire a folder. It is
 * read only by {@link legacyConnection}, for reporting.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { projectKeys } from "./claude_wiring.ts";
import { DEFAULT_SESSION_NAMING, emptyConfig, parseConfig, type SuiteConfig } from "./config.ts";
import { assertWritable, configDir, configPath, gitProbe, type GitProbe } from "./paths.ts";
import { sanitizeSessionName } from "./tmux.ts";

type Env = Record<string, string | undefined>;

export const AGENTS_DIRNAME = "agents";

/** The identity of one agent folder's connection. Holds no secret, ever. */
export interface AgentRecord {
  /** The canonical folder this record belongs to. */
  dir: string;
  suiteUrl: string;
  runtimeId: string;
  headerNames: string[];
  tokenEnv?: string;
  tokenRef?: string;
  keychainService?: string;
}

export interface AgentSecrets {
  token: string;
  headers: Record<string, string>;
}

export interface AgentConnection {
  record: AgentRecord;
  /** The record path, `<configDir>/agents/<key>.json`. */
  path: string;
}

export interface AgentLookup {
  connection: AgentConnection | null;
  /** Record files found at a candidate's key whose stored `dir` is a different folder. Ignored. */
  mismatched: string[];
}

export function agentsDir(env: Env = process.env): string {
  return resolve(configDir(env), AGENTS_DIRNAME);
}

/** The folder as the store keys it: symlinks resolved when it exists, else just absolute. */
export function canonicalDir(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function agentKey(dir: string): string {
  const canon = canonicalDir(dir);
  return `${sanitizeSessionName(basename(canon))}-${createHash("sha256").update(canon).digest("hex").slice(0, 16)}`;
}

export function agentConfigPath(env: Env, dir: string): string {
  return resolve(agentsDir(env), `${agentKey(dir)}.json`);
}

export function agentCredentialsPath(env: Env, dir: string): string {
  return resolve(agentsDir(env), `${agentKey(dir)}.credentials.json`);
}

/* ------------------------------------------------------------------------- */
/* Serialisation — a whitelist, so no secret can land in the record           */
/* ------------------------------------------------------------------------- */

const isEnvName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
const isRefString = (v: unknown): v is string =>
  typeof v === "string" && (v.startsWith("file:") || v.startsWith("keychain:"));

/** The exact bytes of a record. Pure. */
export function serializeAgentRecord(record: AgentRecord): string {
  const out: Record<string, unknown> = {
    dir: record.dir,
    suiteUrl: record.suiteUrl,
    runtimeId: record.runtimeId,
    headerNames: [...record.headerNames].map((n) => n.trim()).filter((n) => n !== ""),
  };
  if (record.tokenEnv !== undefined) {
    if (!isEnvName(record.tokenEnv)) throw new Error("agent record tokenEnv must be an environment variable name");
    out.tokenEnv = record.tokenEnv;
  }
  if (record.tokenRef !== undefined) {
    if (!isRefString(record.tokenRef)) throw new Error("agent record tokenRef must be a file: or keychain: ref");
    out.tokenRef = record.tokenRef;
  }
  if (record.keychainService !== undefined && record.keychainService !== "") out.keychainService = record.keychainService;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Parse a record, or null when it is not one. Never throws. */
export function parseAgentRecord(text: string): AgentRecord | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw.dir !== "string" || raw.dir === "") return null;
  if (typeof raw.suiteUrl !== "string" || typeof raw.runtimeId !== "string") return null;
  const names = Array.isArray(raw.headerNames) ? raw.headerNames.filter((n): n is string => typeof n === "string") : [];
  return {
    dir: raw.dir,
    suiteUrl: raw.suiteUrl,
    runtimeId: raw.runtimeId,
    headerNames: names,
    ...(isEnvName(raw.tokenEnv) ? { tokenEnv: raw.tokenEnv } : {}),
    ...(isRefString(raw.tokenRef) ? { tokenRef: raw.tokenRef } : {}),
    ...(typeof raw.keychainService === "string" && raw.keychainService !== ""
      ? { keychainService: raw.keychainService }
      : {}),
  };
}

function parseSecrets(text: string): AgentSecrets | null {
  try {
    const raw = JSON.parse(text) as { token?: unknown; headers?: unknown };
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

/* ------------------------------------------------------------------------- */
/* Write                                                                      */
/* ------------------------------------------------------------------------- */

/** Write `body` to `target` via a sibling temp file and a rename, at `mode`. */
function atomicWrite(target: string, body: string, mode: number): void {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, body, { mode });
    // writeFileSync's mode applies only on create; re-apply in case it did not.
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  chmodSync(target, mode);
}

export interface AgentWriteOptions {
  probe?: GitProbe;
}

/**
 * Save `dir`'s connection: the record and its secrets. Both destinations are
 * checked by the write guard BEFORE anything is created, so a refused write
 * leaves nothing behind. Writes nothing for any other folder.
 */
export function writeAgentConnection(
  env: Env,
  dir: string,
  config: Pick<SuiteConfig, "suiteUrl" | "runtimeId" | "headerNames" | "tokenEnv" | "tokenRef" | "keychainService">,
  secrets: AgentSecrets,
  options: AgentWriteOptions = {},
): { configPath: string; credentialsPath: string } {
  const probe = options.probe ?? gitProbe;
  const canon = canonicalDir(dir);
  const recordPath = agentConfigPath(env, canon);
  const credsPath = agentCredentialsPath(env, canon);
  assertWritable(recordPath, probe);
  assertWritable(credsPath, probe);
  const record: AgentRecord = {
    dir: canon,
    suiteUrl: config.suiteUrl,
    runtimeId: config.runtimeId,
    headerNames: config.headerNames,
    ...(config.tokenEnv !== undefined ? { tokenEnv: config.tokenEnv } : {}),
    ...(config.tokenRef !== undefined ? { tokenRef: config.tokenRef } : {}),
    ...(config.keychainService !== undefined ? { keychainService: config.keychainService } : {}),
  };
  const recordBody = serializeAgentRecord(record);
  const credsBody = `${JSON.stringify({ token: secrets.token, headers: secrets.headers }, null, 2)}\n`;
  mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
  atomicWrite(credsPath, credsBody, 0o600);
  atomicWrite(recordPath, recordBody, 0o600);
  return { configPath: recordPath, credentialsPath: credsPath };
}

/* ------------------------------------------------------------------------- */
/* Read                                                                       */
/* ------------------------------------------------------------------------- */

/** The record stored at `dir`'s own key, if it names `dir`. No ancestor lookup. */
export function readAgentRecordExact(env: Env, dir: string): AgentConnection | null {
  const canon = canonicalDir(dir);
  const path = agentConfigPath(env, canon);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const record = parseAgentRecord(text);
  if (record === null || record.dir !== canon) return null;
  return { record, path };
}

/**
 * The connection the agent in `cwd` runs as.
 *
 * Candidates are the folders Claude Code keys local entries under — the folder
 * itself, then its enclosing git work tree's root (claude_wiring.ts
 * projectKeys). The first candidate whose record names exactly that candidate
 * wins. A record at a candidate's key that names some other folder is ignored
 * and reported in `mismatched`. Nothing here ever consults the legacy machine
 * connection.
 */
export function readAgentConnection(env: Env, cwd: string): AgentLookup {
  const mismatched: string[] = [];
  for (const candidate of projectKeys(canonicalDir(cwd))) {
    const path = agentConfigPath(env, candidate);
    if (!existsSync(path)) continue;
    let record: AgentRecord | null = null;
    try {
      record = parseAgentRecord(readFileSync(path, "utf8"));
    } catch {
      record = null;
    }
    if (record === null) continue;
    if (record.dir !== candidate) {
      mismatched.push(path);
      continue;
    }
    return { connection: { record, path }, mismatched };
  }
  return { connection: null, mismatched };
}

/** The secrets saved beside `dir`'s record, or null. Never throws. */
export function readAgentSecrets(env: Env, dir: string): AgentSecrets | null {
  const path = agentCredentialsPath(env, dir);
  if (!existsSync(path)) return null;
  try {
    return parseSecrets(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every well-formed record on this machine, sorted by folder. Never throws. */
export function listAgentConnections(env: Env = process.env): AgentConnection[] {
  const dir = agentsDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AgentConnection[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".credentials.json")) continue;
    const path = resolve(dir, name);
    try {
      const record = parseAgentRecord(readFileSync(path, "utf8"));
      if (record === null) continue;
      // A record copied to the wrong key is not that folder's record.
      if (`${agentKey(record.dir)}.json` !== name) continue;
      out.push({ record, path });
    } catch {
      // unreadable: skipped
    }
  }
  return out.sort((x, y) => (x.record.dir < y.record.dir ? -1 : x.record.dir > y.record.dir ? 1 : 0));
}

/* ------------------------------------------------------------------------- */
/* The machine config — settings, and the legacy connection for reporting      */
/* ------------------------------------------------------------------------- */

function readMachineConfig(env: Env): SuiteConfig | null {
  const path = configPath(env);
  if (!existsSync(path)) return null;
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The single machine-level connection a CLI up to 0.7.0 saved in config.json.
 * READ-ONLY and for REPORTING ONLY: it is assigned to no folder.
 */
export function legacyConnection(env: Env = process.env): { suiteUrl: string; runtimeId: string } | null {
  const machine = readMachineConfig(env);
  if (machine === null || machine.suiteUrl === "" || machine.runtimeId === "") return null;
  return { suiteUrl: machine.suiteUrl, runtimeId: machine.runtimeId };
}

/**
 * The SuiteConfig an agent folder runs on: identity from the folder's record
 * (or none), machine-level settings (session naming, telemetry) from
 * config.json. The legacy connection fields of config.json are never copied.
 */
export function agentConfig(env: Env, record: AgentRecord | null): SuiteConfig {
  const machine = readMachineConfig(env);
  const base: SuiteConfig = {
    ...emptyConfig(),
    sessionNaming: machine?.sessionNaming ?? DEFAULT_SESSION_NAMING,
    ...(machine?.telemetry ? { telemetry: machine.telemetry } : {}),
  };
  if (record === null) return base;
  return {
    ...base,
    suiteUrl: record.suiteUrl,
    runtimeId: record.runtimeId,
    headerNames: [...record.headerNames],
    ...(record.tokenEnv !== undefined ? { tokenEnv: record.tokenEnv } : {}),
    ...(record.tokenRef !== undefined ? { tokenRef: record.tokenRef } : {}),
    ...(record.keychainService !== undefined ? { keychainService: record.keychainService } : {}),
  };
}

/** {@link agentConfig} for whatever record `cwd` resolves to. */
export function agentConfigFor(env: Env, cwd: string): SuiteConfig {
  return agentConfig(env, readAgentConnection(env, cwd).connection?.record ?? null);
}
