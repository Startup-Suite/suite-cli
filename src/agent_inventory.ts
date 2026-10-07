/**
 * EVERY AGENT ON THIS MACHINE, AND WHETHER EACH IS WIRED AS ITSELF.
 *
 * One row per agent, from three sources that each know part of the answer:
 *
 *   the roster        (roster.ts)          what was started, as which kind, in which session
 *   the folder store  (agent_connections)  which runtime each folder is federated as
 *   ~/.claude.json    local-scope entries  which runtime each folder's Claude ACTUALLY joins as
 *
 * plus each folder's own `.mcp.json` and `suite.json`, read for comparison.
 *
 * THE INVENTORY IS PURE. Everything it reads arrives in an {@link InventorySource}
 * built by {@link liveInventorySource}; nothing here touches the disk, the
 * network, tmux or `claude`. That is what lets `suite doctor` call it under its
 * read-only rule and lets the tests feed it a machine that never existed.
 *
 * NO TOKEN IS EVER HELD. {@link parseClaudeJson} and {@link parseMcpJson} lift
 * runtime ids and hosts out of files that also carry credentials, and drop the
 * credentials on the floor, so no row, verdict or report line can contain one.
 *
 * NO RUNTIME ID COMES FROM THE LEGACY CONNECTION. A row's runtime id is the
 * folder's record, else its own local Claude entry, else its own `suite.json`.
 * The 0.7.0 machine connection identifies no folder, so it is reported beside
 * the rows (as `legacy`) and never inside one.
 *
 * `claude mcp get` / `claude mcp list` ARE NEVER RUN for this. They health-check
 * a stdio server by STARTING it, and starting the channel joins Suite as that
 * runtime a second time.
 */
import { join } from "node:path";
import type { AgentConnection } from "./agent_connections.ts";
import { parseConfig } from "./config.ts";
import type { RosterEntry } from "./roster.ts";
import { STAMP_FILE } from "./stamp.ts";
import { sessionNameFor, type SessionState } from "./tmux.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "./commands/init.ts";

/** The per-folder config file stamped and DeepSeek agents carry in their root. Mirrors deepseek.ts AGENT_CONFIG_FILE. */
export const ROOT_CONFIG_FILE = "suite.json";
export const MCP_JSON_FILE = ".mcp.json";

/* ------------------------------------------------------------------------- */
/* Shared with `suite status`                                                 */
/* ------------------------------------------------------------------------- */

/** The verbs whose agents are stamped (and so have a `.suite-stamp.json`). */
export const STAMPED_KINDS: readonly RosterEntry["kind"][] = ["hermes", "openclaw"];

/**
 * The state of a RECORDED agent. `none` from tmux means no session by that
 * name; for an agent the roster says was started, that is an agent that died,
 * not one that never was — so it is `stale`.
 */
export function recordedState(detected: SessionState): SessionState {
  return detected === "none" ? "stale" : detected;
}

/**
 * The last stamp verdict recorded in `<root>/.suite-stamp.json`. Only the
 * verdict is read out: the record also carries the token REF, and status has
 * no reason to print even that.
 */
export function lastVerdict(text: string | null): string {
  if (text === null) return "none";
  try {
    const v = (JSON.parse(text) as { verdict?: unknown }).verdict;
    return v === "pass" || v === "fail" || v === "unparseable" ? v : "unreadable";
  } catch {
    return "unreadable";
  }
}

/* ------------------------------------------------------------------------- */
/* What a Claude config file says, minus every secret                         */
/* ------------------------------------------------------------------------- */

/** One folder's Suite entries, as identity only. Never a token. */
export interface EntryIdentity {
  /** suite-channel env SUITE_RUNTIME_ID, or null. */
  runtimeId: string | null;
  /** suite-channel env SUITE_URL, or null. */
  channelUrl: string | null;
  /** startup-suite url, or null. */
  toolsUrl: string | null;
}

/** ~/.claude.json reduced to what the inventory may know. */
export interface ClaudeJsonView {
  /** Local-scope Suite entries, by the project key Claude Code stores them under. */
  projects: Record<string, EntryIdentity>;
  /** User-scope (top-level `mcpServers`) Suite entries: these apply to EVERY folder without local ones. */
  userScope: Array<{ name: string; runtimeId: string | null }>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The identity half of a `mcpServers` map, or null when it has no Suite entry. Drops every token. */
function identityOf(servers: unknown): EntryIdentity | null {
  if (typeof servers !== "object" || servers === null) return null;
  const map = servers as Record<string, unknown>;
  const channel = map[CHANNEL_SERVER] as { env?: Record<string, unknown> } | undefined;
  const tools = map[TOOLS_SERVER] as { url?: unknown } | undefined;
  const hasChannel = typeof channel === "object" && channel !== null;
  const hasTools = typeof tools === "object" && tools !== null;
  if (!hasChannel && !hasTools) return null;
  const env = hasChannel && typeof channel.env === "object" && channel.env !== null ? channel.env : {};
  return {
    runtimeId: str(env.SUITE_RUNTIME_ID),
    channelUrl: str(env.SUITE_URL),
    toolsUrl: hasTools ? str(tools.url) : null,
  };
}

/** Parse ~/.claude.json into a {@link ClaudeJsonView}, or null when it is not JSON. Never throws. */
export function parseClaudeJson(text: string): ClaudeJsonView | null {
  let raw: { projects?: unknown; mcpServers?: unknown };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    raw = parsed as typeof raw;
  } catch {
    return null;
  }
  const projects: Record<string, EntryIdentity> = {};
  if (typeof raw.projects === "object" && raw.projects !== null) {
    for (const [key, project] of Object.entries(raw.projects as Record<string, unknown>)) {
      const id = identityOf((project as { mcpServers?: unknown } | null)?.mcpServers);
      if (id !== null) projects[key] = id;
    }
  }
  const userScope: ClaudeJsonView["userScope"] = [];
  if (typeof raw.mcpServers === "object" && raw.mcpServers !== null) {
    const top = raw.mcpServers as Record<string, unknown>;
    for (const name of [CHANNEL_SERVER, TOOLS_SERVER]) {
      const entry = top[name];
      if (typeof entry !== "object" || entry === null) continue;
      const env = (entry as { env?: Record<string, unknown> }).env;
      userScope.push({ name, runtimeId: name === CHANNEL_SERVER ? str(env?.SUITE_RUNTIME_ID) : null });
    }
  }
  return { projects, userScope };
}

/** A folder's own `.mcp.json` as identity, or null. Same reduction: no token survives. */
export function parseMcpJson(text: string | null): EntryIdentity | null {
  if (text === null) return null;
  try {
    return identityOf((JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers);
  } catch {
    return null;
  }
}

/** The lowercased host of a URL, any scheme, or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    return new URL(url.trim()).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Wiring: do the sources agree on which runtime this folder is?              */
/* ------------------------------------------------------------------------- */

export type Wiring = "match" | "cross_wired" | "unrecorded" | "unknown";

/** One source's claim about a folder: the runtime it names and the Suite hosts it points at. */
export interface WiringClaim {
  source: "record" | "entry" | ".mcp.json";
  runtimeId: string | null;
  hosts: string[];
}

export interface FolderWiring {
  wiring: Wiring;
  claims: WiringClaim[];
}

function claimOf(source: WiringClaim["source"], id: EntryIdentity): WiringClaim {
  const hosts = [hostOf(id.channelUrl), hostOf(id.toolsUrl)].filter((h): h is string => h !== null);
  return { source, runtimeId: id.runtimeId, hosts };
}

/**
 * Compare what the record, the folder's local Claude entry and its `.mcp.json`
 * each say. Any two that name different runtimes, or different Suite hosts, is
 * `cross_wired`. Pure.
 *
 *  - `entry` null means ~/.claude.json could not be read: `unknown` unless the
 *    other two already disagree.
 *  - No record and nothing disagreeing: `unrecorded`.
 *  - A record and no other source to compare against: `unknown` — nothing is
 *    wired yet, so nothing can be said to match.
 */
export function folderWiring(
  record: AgentConnection["record"] | null,
  entry: EntryIdentity | null | undefined,
  mcpJson: EntryIdentity | null,
): FolderWiring {
  const claims: WiringClaim[] = [];
  if (record !== null) {
    claims.push({
      source: "record",
      runtimeId: record.runtimeId,
      hosts: [hostOf(record.suiteUrl)].filter((h): h is string => h !== null),
    });
  }
  if (entry !== null && entry !== undefined) claims.push(claimOf("entry", entry));
  if (mcpJson !== null) claims.push(claimOf(".mcp.json", mcpJson));

  const ids = new Set(claims.map((c) => c.runtimeId).filter((v): v is string => v !== null));
  const hosts = new Set(claims.flatMap((c) => c.hosts));
  if (ids.size > 1 || hosts.size > 1) return { wiring: "cross_wired", claims };
  if (record === null) return { wiring: "unrecorded", claims };
  if (entry === null) return { wiring: "unknown", claims };
  if (claims.length < 2) return { wiring: "unknown", claims };
  return { wiring: "match", claims };
}

/* ------------------------------------------------------------------------- */
/* The inventory                                                              */
/* ------------------------------------------------------------------------- */

/** Everything the inventory reads, already read. Built live by the caller. */
export interface InventorySource {
  records: AgentConnection[];
  roster: RosterEntry[];
  /** null: ~/.claude.json exists and could not be read or parsed. Absent file: empty view. */
  claudeJson: ClaudeJsonView | null;
  /** The machine-level session naming rule (config.json), for a never-launched agent's session name. */
  sessionNaming: "cwd" | "runtime";
  /** A file's text, or null. Never throws. Used for `.mcp.json`, `suite.json` and the stamp record. */
  readFile(path: string): string | null;
  /** The canonical form of a folder. Default: as given. */
  canon?(dir: string): string;
  /** The project keys Claude Code may store a folder's local entries under. Default: the folder alone. */
  keysFor?(dir: string): string[];
}

export interface InventoryRow {
  session: string;
  kind: RosterEntry["kind"] | null;
  root: string;
  runtime_id: string | null;
  suite_url: string | null;
  state: SessionState;
  channel: "unknown";
  verdict: string | null;
  recorded: boolean;
  wiring: Wiring;
  /** Not emitted in the contract: what doctor names when it reports cross-wiring. */
  claims: WiringClaim[];
}

/** How a row's session state is found. Injected: tmux is I/O. */
export type DetectState = (session: string, kind: RosterEntry["kind"] | null) => Promise<SessionState>;

function suiteUrlFromTools(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/mcp\/?$/, "") || "/";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function rootConfig(src: InventorySource, dir: string): { runtimeId: string; suiteUrl: string } | null {
  const text = src.readFile(join(dir, ROOT_CONFIG_FILE));
  if (text === null) return null;
  try {
    const c = parseConfig(text);
    return { runtimeId: c.runtimeId, suiteUrl: c.suiteUrl };
  } catch {
    return null;
  }
}

function neverLaunchedSession(src: InventorySource, dir: string, runtimeId: string | null): string {
  try {
    return sessionNameFor({ naming: src.sessionNaming, cwd: dir, runtimeId: runtimeId ?? undefined });
  } catch {
    // `runtime` naming with no runtime id: the per-folder rule still names it.
    return sessionNameFor({ naming: "cwd", cwd: dir });
  }
}

/**
 * Every agent: one row per roster entry, then one per folder that has a record
 * or Suite entries in ~/.claude.json and no roster entry. Rows are ordered by
 * root, then session. `session` is always a string.
 */
export async function inventoryRows(src: InventorySource, detect: DetectState): Promise<InventoryRow[]> {
  const canon = src.canon ?? ((d: string) => d);
  const keysFor = src.keysFor ?? ((d: string) => [d]);
  const projects = src.claudeJson?.projects ?? {};

  const recordFor = new Map<string, AgentConnection["record"]>();
  for (const c of src.records) recordFor.set(canon(c.record.dir), c.record);

  // The folders: roster cwds and records first, then any project key holding
  // Suite entries that is not already some folder's entry key.
  const folders = new Set<string>();
  for (const e of src.roster) folders.add(canon(e.cwd));
  for (const dir of recordFor.keys()) folders.add(dir);
  const claimedKeys = new Set<string>();
  const entryFor = (dir: string): { key: string; id: EntryIdentity } | null => {
    for (const key of keysFor(dir)) {
      const id = projects[key];
      if (id !== undefined) return { key, id };
    }
    return null;
  };
  for (const dir of folders) {
    const e = entryFor(dir);
    if (e !== null) claimedKeys.add(e.key);
  }
  for (const key of Object.keys(projects)) {
    if (!claimedKeys.has(key)) folders.add(canon(key));
  }

  const rows: InventoryRow[] = [];
  const rosterByDir = new Map<string, RosterEntry[]>();
  for (const e of src.roster) {
    const dir = canon(e.cwd);
    rosterByDir.set(dir, [...(rosterByDir.get(dir) ?? []), e]);
  }

  for (const dir of [...folders].sort()) {
    const record = recordFor.get(dir) ?? null;
    const entry = src.claudeJson === null ? null : (entryFor(dir)?.id ?? undefined);
    const mcpJson = parseMcpJson(src.readFile(join(dir, MCP_JSON_FILE)));
    const { wiring, claims } = folderWiring(record, entry, mcpJson);
    const own = rootConfig(src, dir);
    const runtimeId = record?.runtimeId || entry?.runtimeId || own?.runtimeId || null;
    const suiteUrl = record?.suiteUrl || own?.suiteUrl || suiteUrlFromTools(entry?.toolsUrl ?? null) || null;
    const base = { root: dir, runtime_id: runtimeId, suite_url: suiteUrl, channel: "unknown" as const, recorded: record !== null, wiring, claims };

    const launched = rosterByDir.get(dir) ?? [];
    if (launched.length === 0) {
      const session = neverLaunchedSession(src, dir, runtimeId);
      rows.push({ ...base, session, kind: null, state: await detect(session, null), verdict: null });
      continue;
    }
    for (const e of [...launched].sort((x, y) => (x.session < y.session ? -1 : x.session > y.session ? 1 : 0))) {
      rows.push({
        ...base,
        session: e.session,
        kind: e.kind,
        state: recordedState(await detect(e.session, e.kind)),
        verdict: STAMPED_KINDS.includes(e.kind) ? lastVerdict(src.readFile(join(e.cwd, STAMP_FILE))) : null,
      });
    }
  }
  return rows;
}

/** A row's claims as one human phrase: `recorded rt-a, entry rt-b, .mcp.json rt-a`. Ids only. */
export function claimsPhrase(claims: WiringClaim[]): string {
  return claims
    .map((c) => {
      const what = c.source === "record" ? "recorded" : c.source;
      const id = c.runtimeId ?? "no runtime id";
      return c.hosts.length === 0 ? `${what} ${id}` : `${what} ${id} (${[...new Set(c.hosts)].join(", ")})`;
    })
    .join(", ");
}
