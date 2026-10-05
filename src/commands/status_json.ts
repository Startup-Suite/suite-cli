/**
 * `suite status --json` — the machine contract of `suite status`.
 *
 * ONE DOCUMENT on stdout, additive-only like the stamp contract
 * (`contract_version` 1; a field may be added, never renamed, retyped or
 * removed without a bump):
 *
 *   {contract_version: 1, suite_version,
 *    connection: {suite_url, runtime_id, token_ref|null,
 *                 token_at_rest: keychain|file|inline|env|none},
 *    watchdog: {installed, loaded},
 *    agents: [{session, kind, root, runtime_id, state: live|stale|none,
 *              channel: connected|not_connected|unknown, verdict,
 *              token_at_rest, token_in_child_env}]}
 *
 * NOTHING HERE READS A TOKEN VALUE. `token_at_rest` is decided from the SHAPE
 * of what is stored (a ref's scheme, an env reference, a non-empty literal),
 * and the literal itself is never kept, compared or printed.
 *
 * `token_at_rest` says where the credential sits on disk: `keychain` (a
 * keychain ref), `file` (a file ref, or Hermes's materialised 0600 token file
 * — hermes-suite-channel has no keychain resolver yet), `inline` (the value in
 * a config file: credentials.json, or a literal in ~/.claude.json), `env` (an
 * env reference), `none`. `token_in_child_env` is true when the running agent
 * process tree holds the VALUE in a child's environment: the codex bridge
 * (0.7.0 design), DeepSeek's dsh, and Claude in LITERAL mode (its channel's
 * `SUITE_TOKEN`). These are the exceptions that exist today, surfaced rather
 * than hidden.
 *
 * `state` is the three-way session state. A RECORDED agent whose session is
 * gone is `stale`, never `none` (see status.ts recordedState), so `none` does
 * not occur for a roster row today; it stays in the enum for the contract.
 *
 * `channel` is read from the state file the Claude channel plugin writes on
 * every join and disconnect (`<state>/suite/channel/<runtime>.json`, no
 * secret) and is `connected` only while that file says joined AND its pid is
 * alive. It is NOT read from `claude mcp list`, which health-checks a stdio
 * server by STARTING A SECOND COPY of it — a second channel joining Suite as
 * the same runtime, once per poll. Kinds whose channel writes no such file
 * report `unknown`.
 */
import { join, resolve } from "node:path";
import { parseConfig, type SuiteConfig } from "../config.ts";
import { projectKeys } from "../claude_wiring.ts";
import { readCredentials } from "../connection.ts";
import { parseRoster, rosterPath, type RosterEntry } from "../roster.ts";
import { STAMP_FILE } from "../stamp.ts";
import { LAUNCHD_LABEL, SERVICE_NAME } from "../supervisor.ts";
import { detectState, type SessionState, type TmuxDeps } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { AGENT_CONFIG_FILE, AGENT_STATE_FILE } from "./deepseek.ts";
import { CHANNEL_SERVER, claudeJsonPath } from "./init.ts";
import { agentNameForKind, lastVerdict, recordedState, STAMPED_KINDS } from "./status.ts";

type Env = Record<string, string | undefined>;

export const STATUS_CONTRACT_VERSION = 1 as const;

export type TokenAtRest = "keychain" | "file" | "inline" | "env" | "none";
export type ChannelState = "connected" | "not_connected" | "unknown";

export interface AgentRow {
  session: string;
  kind: RosterEntry["kind"];
  root: string;
  runtime_id: string | null;
  state: SessionState;
  channel: ChannelState;
  /** The last stamp verdict for stamped kinds (`pass`/`fail`/...), else null. */
  verdict: string | null;
  token_at_rest: TokenAtRest;
  token_in_child_env: boolean;
}

export interface StatusDocument {
  contract_version: typeof STATUS_CONTRACT_VERSION;
  suite_version: string;
  connection: { suite_url: string; runtime_id: string; token_ref: string | null; token_at_rest: TokenAtRest };
  watchdog: { installed: boolean; loaded: boolean };
  agents: AgentRow[];
}

export const STATUS_FIELDS = ["contract_version", "suite_version", "connection", "watchdog", "agents"] as const satisfies readonly (keyof StatusDocument)[];
export const AGENT_FIELDS = [
  "session",
  "kind",
  "root",
  "runtime_id",
  "state",
  "channel",
  "verdict",
  "token_at_rest",
  "token_in_child_env",
] as const satisfies readonly (keyof AgentRow)[];

export interface StatusJsonDeps {
  env: Env;
  platform: NodeJS.Platform;
  home: string;
  config: SuiteConfig | null;
  tmux: TmuxDeps;
  /** A file's text, or null. Never throws. */
  readFile(path: string): string | null;
  /** Whether the watchdog's service-manager unit is loaded (launchctl print / systemctl is-active). */
  watchdogLoaded(): Promise<boolean>;
  /** Whether a pid is alive. */
  pidAlive(pid: number): boolean;
}

/** Where a credential sits, from the SHAPE of a stored token slot. Never keeps the value. */
export function atRestOf(slot: string | null | undefined): TokenAtRest {
  if (slot === null || slot === undefined || slot === "") return "none";
  if (slot.startsWith("keychain:")) return "keychain";
  if (slot.startsWith("file:")) return "file";
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(slot)) return "env";
  return "inline";
}

/** The machine connection's at-rest class. */
export function connectionAtRest(config: SuiteConfig | null, env: Env): TokenAtRest {
  if (config === null) return "none";
  if (config.tokenRef !== undefined && config.tokenRef !== "") return atRestOf(config.tokenRef);
  if (config.tokenEnv !== undefined) return "env";
  let saved = "";
  try {
    saved = readCredentials(env)?.token ?? "";
  } catch {
    saved = "";
  }
  return saved === "" ? "none" : "inline";
}

/** Where the channel plugin writes its join state. Mirrors claude-code-suite-channel src/channel-state.ts. */
export function channelStatePath(env: Env, runtimeId: string): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && xdg !== "" && xdg.startsWith("/") ? xdg : resolve(env.HOME ?? "", ".local", "state");
  return join(base, "suite", "channel", `${runtimeId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** connected only while the file says joined AND its writer is alive. */
export function channelFromState(text: string | null, pidAlive: (pid: number) => boolean): ChannelState {
  if (text === null) return "unknown";
  try {
    const raw = JSON.parse(text) as { state?: unknown; pid?: unknown };
    const pid = typeof raw.pid === "number" ? raw.pid : -1;
    if (pid <= 0 || !pidAlive(pid)) return "not_connected";
    return raw.state === "joined" ? "connected" : "not_connected";
  } catch {
    return "unknown";
  }
}

function rootConfig(deps: StatusJsonDeps, root: string): SuiteConfig | null {
  const text = deps.readFile(join(root, AGENT_CONFIG_FILE));
  if (text === null) return null;
  try {
    return parseConfig(text);
  } catch {
    return null;
  }
}

/** One roster entry as a row. */
export async function agentRow(deps: StatusJsonDeps, entry: RosterEntry): Promise<AgentRow> {
  const machine = deps.config;
  const state = recordedState(await detectState(entry.session, deps.tmux, agentNameForKind(entry.kind)));
  const row: AgentRow = {
    session: entry.session,
    kind: entry.kind,
    root: entry.cwd,
    runtime_id: machine?.runtimeId || null,
    state,
    channel: "unknown",
    verdict: null,
    token_at_rest: "none",
    token_in_child_env: false,
  };
  switch (entry.kind) {
    case "claude": {
      let local: Record<string, { env?: Record<string, string> }> | null = null;
      try {
        const raw = JSON.parse(deps.readFile(claudeJsonPath(deps.env)) ?? "{}") as {
          projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string> }> }>;
        };
        for (const key of projectKeys(entry.cwd)) {
          const servers = raw.projects?.[key]?.mcpServers;
          if (servers !== undefined) {
            local = servers;
            break;
          }
        }
      } catch {
        local = null;
      }
      const env = local?.[CHANNEL_SERVER]?.env ?? {};
      row.runtime_id = env.SUITE_RUNTIME_ID ?? row.runtime_id;
      row.token_at_rest = atRestOf(env.SUITE_TOKEN);
      // Literal (or env-expanded) SUITE_TOKEN reaches the channel child's env as the value.
      row.token_in_child_env = row.token_at_rest === "inline" || row.token_at_rest === "env";
      if (row.runtime_id !== null && row.runtime_id !== "") {
        row.channel = channelFromState(deps.readFile(channelStatePath(deps.env, row.runtime_id)), deps.pidAlive);
      }
      break;
    }
    case "hermes": {
      // v3 architect note 2: hermes-suite-channel reads a 0600 token file.
      const rc = rootConfig(deps, entry.cwd);
      row.runtime_id = rc?.runtimeId || row.runtime_id;
      row.token_at_rest = "file";
      row.verdict = lastVerdict(deps.readFile(join(entry.cwd, STAMP_FILE)));
      break;
    }
    case "openclaw": {
      const rc = rootConfig(deps, entry.cwd);
      row.runtime_id = rc?.runtimeId || row.runtime_id;
      row.token_at_rest = atRestOf(rc?.tokenRef);
      row.verdict = lastVerdict(deps.readFile(join(entry.cwd, STAMP_FILE)));
      break;
    }
    case "codex":
      row.token_at_rest = connectionAtRest(machine, deps.env);
      row.token_in_child_env = true;
      break;
    case "deepseek": {
      const rc = rootConfig(deps, entry.cwd);
      if (rc !== null) {
        row.runtime_id = rc.runtimeId || row.runtime_id;
        row.token_at_rest = deps.readFile(join(entry.cwd, AGENT_STATE_FILE)) === null ? "none" : "inline";
      } else {
        row.token_at_rest = connectionAtRest(machine, deps.env);
      }
      row.token_in_child_env = true;
      break;
    }
  }
  if (STAMPED_KINDS.includes(entry.kind) && row.verdict === null) row.verdict = "none";
  return row;
}

export async function statusDocument(deps: StatusJsonDeps): Promise<StatusDocument> {
  const config = deps.config;
  const rosterText = deps.home === "" ? null : deps.readFile(rosterPath(deps.home));
  const roster = rosterText === null ? [] : parseRoster(rosterText);
  const unit =
    deps.platform === "darwin"
      ? `${deps.home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
      : `${deps.home}/.config/systemd/user/${SERVICE_NAME}.service`;
  const agents: AgentRow[] = [];
  for (const entry of roster) agents.push(await agentRow(deps, entry));
  return {
    contract_version: STATUS_CONTRACT_VERSION,
    suite_version: VERSION,
    connection: {
      suite_url: config?.suiteUrl ?? "",
      runtime_id: config?.runtimeId ?? "",
      token_ref: config?.tokenRef || null,
      token_at_rest: connectionAtRest(config, deps.env),
    },
    watchdog: { installed: deps.home !== "" && deps.readFile(unit) !== null, loaded: await deps.watchdogLoaded() },
    agents,
  };
}

/** The exact bytes: fields in contract order, indent 2, newline. */
export function renderStatusDocument(doc: StatusDocument): string {
  const ordered: Record<string, unknown> = {};
  for (const k of STATUS_FIELDS) ordered[k] = doc[k];
  ordered.agents = doc.agents.map((a) => {
    const o: Record<string, unknown> = {};
    for (const k of AGENT_FIELDS) o[k] = a[k];
    return o;
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** `launchctl print` / `systemctl --user is-active`, or the tmux fallback session. */
export async function liveWatchdogLoaded(platform: NodeJS.Platform, tmux: TmuxDeps): Promise<boolean> {
  const uid = process.getuid?.() ?? 501;
  const argv =
    platform === "darwin"
      ? ["launchctl", "print", `gui/${uid}/${LAUNCHD_LABEL}`]
      : ["systemctl", "--user", "is-active", "--quiet", `${SERVICE_NAME}.service`];
  try {
    const p = Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    if (p.exitCode === 0) return true;
  } catch {
    /* no service manager */
  }
  const fb = await tmux.run(["tmux", "has-session", "-t", `=${SERVICE_NAME}`]);
  return fb.exitCode === 0;
}

export function livePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

