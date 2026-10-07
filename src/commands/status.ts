/**
 * `suite status` — what this box IS right now, in one screen.
 *
 * Three questions, and deliberately no diagnosis: `suite doctor` is the verb
 * that tells you what is wrong and how to fix it, and duplicating its
 * remediation here would give two places to keep true.
 *
 *  1. WHICH AGENTS ARE FEDERATED, AS WHICH RUNTIME. One line per agent in
 *     the inventory (src/agent_inventory.ts — the rows `status --json` emits):
 *     folder, runtime id, suite URL, and a marker for a folder with no record
 *     (src/agent_connections.ts) — NEVER the token. A 0.7.0 machine-level connection is reported as
 *     `legacy`, assigned to no folder, because it identifies none. The id is what Suite shows in its own UI, so it is the
 *     value that lets a human match this machine to a row on a screen; the
 *     token identifies nothing to a human and printing it puts a credential in
 *     a terminal scrollback, a screenshot and a pasted bug report.
 *  2. IS THE CHANNEL CONNECTED — health-checked, not merely configured.
 *  3. WHICH PERSISTENT SESSIONS EXIST, each with stage 4's THREE-WAY state and
 *     its age. Listing names alone would repeat the exact mistake the three-way
 *     detection exists to prevent: a stale session is present, answers
 *     `has-session`, and is dead.
 *  4. WHICH STAMPED AGENTS THIS BOX RUNS (`suite hermes`, `suite openclaw`):
 *     kind, root, session state and the last stamp verdict. These come from
 *     the roster, not from tmux, because a dead gateway leaves NO session
 *     behind — its pane runs the gateway relaunch directly, the relaunch exits
 *     with the gateway, and the pane closes. tmux alone would report that
 *     agent as `none`, i.e. as never having existed. An agent the roster says
 *     was started and that is not running is `stale`.
 *
 * Layout and colour are the shared ones (design canvas revision 1): same
 * two-column grid, same glyphs, same `NO_COLOR`/off-TTY rules, so status and
 * doctor read as one program.
 */
import { SGR, glyphFor, paint, row } from "../ui.ts";
import { CHANNEL_SERVER, whichBin } from "./init.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAME, SESSION_PREFIX, TMUX, detectState, type SessionState } from "../tmux.ts";
import { channelStatus, liveDoctorDeps, liveInventorySource, type DoctorDeps } from "./doctor.ts";
import {
  legacyConnection,
  listAgentConnections,
  readAgentConnection,
  type AgentConnection,
} from "../agent_connections.ts";
import {
  STAMPED_KINDS,
  inventoryRows,
  lastVerdict,
  recordedState,
  type InventoryRow,
  type InventorySource,
} from "../agent_inventory.ts";
import { VERSION } from "../version.ts";
import { parseRoster, rosterPath, type RosterEntry } from "../roster.ts";
import { STAMP_FILE } from "../stamp.ts";
import { HERMES_AGENT_COMM } from "./hermes.ts";
import { OPENCLAW_GATEWAY_COMM } from "./openclaw.ts";

/**
 * What `suite status` reads beyond doctor's dependencies. Both optional: with
 * neither, there is no roster to read and the stamped-agents section is empty,
 * which is what every pre-existing caller gets.
 */
export interface StatusDeps extends DoctorDeps {
  /** $HOME, for the roster path. */
  home?: string;
  /** A file's text, or null when it cannot be read. Never throws. */
  readFile?(path: string): string | null;
  /**
   * The per-folder records and the legacy machine connection. Optional: absent
   * reads both from `env` (see {@link connectionsOf}). Never the token.
   */
  connections?(): StatusConnections;
  /**
   * Everything the agent inventory reads (src/agent_inventory.ts), the SAME
   * source `status --json` lists its agents from. Optional: absent, it is the
   * live one ({@link liveInventorySource}) — or, when `connections` is
   * injected, those records and this roster with no Claude entries.
   */
  inventorySource?(): InventorySource;
}

export interface StatusConnections {
  records: AgentConnection[];
  legacy: { suiteUrl: string; runtimeId: string } | null;
}

/** Every folder record plus the legacy connection, from `env`. Never throws; nothing readable is none. */
export function connectionsOf(env: Record<string, string | undefined>): StatusConnections {
  let records: AgentConnection[] = [];
  let legacy: StatusConnections["legacy"] = null;
  try {
    records = listAgentConnections(env);
  } catch {
    records = [];
  }
  try {
    legacy = legacyConnection(env);
  } catch {
    legacy = null;
  }
  return { records, legacy };
}

/**
 * One agent row from the inventory, as a human reads it: folder, runtime,
 * install, and why it is not plainly a recorded folder. The rows are the SAME
 * ones `status --json` emits as `agents[]`. A stamped row is not printed here:
 * the stamped section lists it, once, with its session state and verdict.
 * Never a token: an inventory row holds none.
 */
export function agentIdentityLine(r: InventoryRow): string {
  const marks: string[] = [];
  if (!r.recorded) marks.push("(unrecorded — run suite init)");
  if (r.wiring === "cross_wired") marks.push("(cross-wired — run suite doctor)");
  const detail = [r.runtime_id ?? "no runtime id", r.suite_url ?? "", ...marks].filter((p) => p !== "").join("  ");
  return row("", r.root, detail);
}

/** The inventory rows `suite status` lists, from the same source and function as `status --json`. */
export async function statusInventory(
  deps: StatusDeps,
  records: AgentConnection[],
  roster: RosterEntry[],
): Promise<InventoryRow[]> {
  // Records and roster alone, no Claude entries: what status can say when
  // nothing else is readable. Status never throws on an unreadable machine.
  const bare: InventorySource = {
    records,
    roster,
    claudeJson: { projects: {}, userScope: [] },
    sessionNaming: "cwd",
    readFile: deps.readFile ?? (() => null),
  };
  let src: InventorySource = bare;
  try {
    if (deps.inventorySource !== undefined) src = deps.inventorySource();
    // The live machine, but this status's own roster read (deps.home), so the
    // stamped section below and these rows describe one roster.
    else if (deps.connections === undefined) src = { ...liveInventorySource(deps.env), records, roster };
  } catch {
    src = bare;
  }
  // A human line shows no session state, so none is probed: tmux is not asked
  // anything twice, and the row SET does not depend on state.
  return inventoryRows(src, async () => "none");
}

/** The 0.7.0 machine connection, said to belong to no folder. */
export function legacyLine(legacy: { runtimeId: string; suiteUrl: string }): string {
  return row("legacy", legacy.runtimeId, `not assigned to any folder; run suite init in each agent folder (${legacy.suiteUrl})`);
}

/**
 * The process name `detectState` looks for, per verb. MEASURED names, pinned
 * where they were measured: hermes.ts {@link HERMES_AGENT_COMM} and openclaw.ts
 * {@link OPENCLAW_GATEWAY_COMM}. Asking for `claude` in a Hermes session would
 * call every live gateway stale.
 */
export function agentNameForKind(kind: RosterEntry["kind"]): string {
  switch (kind) {
    case "hermes":
      return HERMES_AGENT_COMM;
    case "openclaw":
      return OPENCLAW_GATEWAY_COMM;
    case "deepseek":
      return "dsh";
    case "codex":
      // The pane runs `<bun> <cli.ts> codex --no-session`, and its child is
      // `codex app-server`; both carry `codex` as an argv word.
      return "codex";
    case "claude":
      return AGENT_NAME;
  }
}

// Shared with the agent inventory (status --json and doctor's `agents` check),
// which must not import this module: doctor is imported here.
export { STAMPED_KINDS, lastVerdict, recordedState } from "../agent_inventory.ts";

export interface StampedAgentRow {
  session: string;
  kind: RosterEntry["kind"];
  root: string;
  state: SessionState;
  verdict: string;
}

/** One stamped agent, glyph-led like every other status line. */
export function agentLine(agent: StampedAgentRow, options: { color: boolean; utf8: boolean }): string {
  const live = agent.state === "live";
  const glyph = paint(glyphFor(live ? "pass" : "fail", options.utf8), live ? SGR.green : SGR.red, options.color);
  return (
    `  ${glyph}  ${agent.session.padEnd(28, " ")}${agent.kind.padEnd(10, " ")}${agent.state.padEnd(7, " ")}` +
    `stamp ${agent.verdict.padEnd(12, " ")}${paint(agent.root, SGR.faint, options.color)}`
  ).trimEnd();
}

function readRoster(deps: StatusDeps): RosterEntry[] {
  if (deps.readFile === undefined || deps.home === undefined || deps.home === "") return [];
  const text = deps.readFile(rosterPath(deps.home));
  return text === null ? [] : parseRoster(text);
}

/** Every stamped agent in the roster, with its state and last verdict. */
export async function stampedAgents(deps: StatusDeps, roster: RosterEntry[]): Promise<StampedAgentRow[]> {
  const rows: StampedAgentRow[] = [];
  for (const entry of roster) {
    if (!STAMPED_KINDS.includes(entry.kind)) continue;
    const detected = await detectState(entry.session, deps.tmux, agentNameForKind(entry.kind));
    rows.push({
      session: entry.session,
      kind: entry.kind,
      root: entry.cwd,
      state: recordedState(detected),
      verdict: lastVerdict(deps.readFile?.(join(entry.cwd, STAMP_FILE)) ?? null),
    });
  }
  return rows;
}

/** Fields asked of `tmux list-sessions`, in order, tab separated. */
export const SESSION_FORMAT = "#{session_name}\t#{session_created}";

export function listSessionsArgv(): string[] {
  return [TMUX, "list-sessions", "-F", SESSION_FORMAT];
}

export interface SessionRow {
  name: string;
  /** Unix seconds the session was created, per tmux. */
  created: number;
}

/** Parse `tmux list-sessions -F`. Pure; malformed lines are dropped. */
export function parseSessions(stdout: string): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [name, created] = line.split("\t");
    const n = Number.parseInt(created ?? "", 10);
    if (name === undefined || name === "" || !Number.isInteger(n)) continue;
    rows.push({ name, created: n });
  }
  return rows;
}

/** Only OUR sessions. A user's own tmux sessions are none of our business. */
export function ownSessions(rows: SessionRow[]): SessionRow[] {
  return rows.filter((r) => r.name.startsWith(`${SESSION_PREFIX}-`));
}

/**
 * Age as a human reads it: coarse on purpose. "3h" answers the question a
 * reader actually has — is this the agent I started this morning — and a
 * seconds-precise duration would not.
 */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const SESSION_WORDS: Record<SessionState, string> = {
  live: "agent running",
  stale: "stale — shell alive, Claude dead",
  none: "no session",
};

/** A stale non-Claude session names its own program, not Claude. */
function sessionWords(state: SessionState, agentName: string): string {
  if (state === "stale" && agentName !== AGENT_NAME) return `stale — shell alive, ${agentName} dead`;
  return SESSION_WORDS[state];
}

/** A session's state is glyph-led, like every other status line in the CLI. */
export function sessionLine(
  session: SessionRow,
  state: SessionState,
  now: number,
  options: { color: boolean; utf8: boolean },
  agentName: string = AGENT_NAME,
): string {
  const status = state === "live" ? "pass" : "fail";
  const glyph = paint(
    glyphFor(status, options.utf8),
    state === "live" ? SGR.green : SGR.red,
    options.color,
  );
  const age = paint(formatAge(now - session.created), SGR.faint, options.color);
  return `  ${glyph}  ${session.name.padEnd(28, " ")}${sessionWords(state, agentName).padEnd(34, " ")}${age}`.trimEnd();
}

export async function runStatus(deps: StatusDeps, now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const options = { color: deps.color, utf8: deps.utf8 };
  const { records, legacy } = (deps.connections ?? (() => connectionsOf(deps.env)))();
  const say = deps.out;
  const roster = readRoster(deps);
  say("");

  // 1. Federation identity, per agent: the agent inventory's rows, the same
  // ones `status --json` emits, so a folder wired only by its Claude entries
  // (no record) is counted here too, marked unrecorded. The token is not read,
  // let alone printed.
  const agents = await statusInventory(deps, records, roster);
  if (agents.length === 0 && legacy === null) {
    say(row("agents", "not federated", "no agent folder has a saved connection"));
    say("");
    say("suite init");
    await sayAgents(deps, roster, options);
    return 1;
  }
  // Every inventory row is counted; a stamped one is listed under `stamped`
  // (section 4) rather than twice, so lines here + stamped lines = the count.
  const isStamped = (a: InventoryRow): boolean => a.kind !== null && STAMPED_KINDS.includes(a.kind);
  const stampedCount = agents.filter(isStamped).length;
  say(row("agents", String(agents.length), stampedCount === 0 ? "" : `${stampedCount} stamped, listed under stamped`));
  for (const a of agents) if (!isStamped(a)) say(agentIdentityLine(a));
  if (legacy !== null) say(legacyLine(legacy));
  if (records.length === 0 && legacy === null) {
    // Agents, but none with a saved connection: unfederated as before. A
    // stamped agent carries its own identity in its root, so it is listed
    // even on a box that `suite init` never federated.
    say(row("", "not federated", "no agent folder has a saved connection"));
    say("");
    say("suite init");
    await sayAgents(deps, roster, options);
    return 1;
  }

  // 2. The channel, health-checked.
  const claudePath = deps.which("claude");
  let ok = true;
  if (claudePath === null) {
    say(row("channel", "unknown", "claude is not on PATH"));
    ok = false;
  } else {
    const status = await channelStatus(deps, claudePath);
    if (status.state === "connected") {
      say(row("channel", "connected", CHANNEL_SERVER));
    } else {
      say(row("channel", status.state.replace("-", " "), status.raw));
      ok = false;
    }
  }

  // 3. Sessions — three-way state, never a bare name list. A stamped agent's
  // session is listed under 4, with the state that accounts for a vanished
  // pane, so it is not listed twice.
  say("");
  const stamped = new Set(roster.filter((e) => STAMPED_KINDS.includes(e.kind)).map((e) => e.session));
  const kindOf = new Map(roster.map((e) => [e.session, e.kind] as const));
  if (deps.which(TMUX) === null) {
    say(row("sessions", "unavailable", "tmux is not installed"));
  } else {
    const listed = await deps.tmux.run(listSessionsArgv());
    const sessions = ownSessions(listed.exitCode === 0 ? parseSessions(listed.stdout) : []).filter(
      (s) => !stamped.has(s.name),
    );
    if (sessions.length === 0) {
      say(row("sessions", "none", "suite claude starts one"));
    } else {
      say(row("sessions", String(sessions.length)));
      for (const session of sessions) {
        const kind = kindOf.get(session.name) ?? "claude";
        const agentName = agentNameForKind(kind);
        const state = await detectState(session.name, deps.tmux, agentName);
        say(sessionLine(session, state, now, options, agentName));
        if (state === "stale") ok = false;
      }
    }
  }

  // 4. Stamped agents.
  if (!(await sayAgents(deps, roster, options))) ok = false;
  return ok ? 0 : 1;
}

/** Print the stamped-agents section, if any. False when any of them is not live. */
async function sayAgents(
  deps: StatusDeps,
  roster: RosterEntry[],
  options: { color: boolean; utf8: boolean },
): Promise<boolean> {
  const agents = await stampedAgents(deps, roster);
  if (agents.length === 0) return true;
  deps.out("");
  // `stamped`, not `agents`: the agents header is the per-folder connections above.
  deps.out(row("stamped", String(agents.length)));
  for (const agent of agents) deps.out(agentLine(agent, options));
  return agents.every((a) => a.state === "live");
}

/* ------------------------------------------------------------------------- */
/* `suite status --json` — the machine contract                               */
/* ------------------------------------------------------------------------- */

/**
 * `contract_version` 1, ADDITIVE ONLY: a field may be added, never renamed,
 * retyped or removed without a bump. Field names MATCH the desktop branch's
 * StatusDocument (01a0d6b9, src/commands/status_json.ts at 054671a2), so the
 * suite-desktop-mac decoder (agents required with a String session, every
 * other field optional) reads this document unchanged.
 *
 * NO TOKEN VALUE AND NO TOKEN FIELD. NO RUNTIME ID FROM THE LEGACY CONNECTION:
 * the 0.7.0 machine connection appears only as `legacy_connection`.
 */
export const STATUS_CONTRACT_VERSION = 1 as const;

export interface StatusAgentRow {
  /** Always a string: a never-launched agent gets the name `suite claude` would give it. */
  session: string;
  /** From the roster, or null for an agent never launched. */
  kind: InventoryRow["kind"];
  root: string;
  /** The folder's record, else its own local Claude entry, else its suite.json. Never the legacy connection. */
  runtime_id: string | null;
  suite_url: string | null;
  state: InventoryRow["state"];
  /** `unknown`: the channel state-file read belongs to 01a0d6b9. */
  channel: "unknown";
  /** The last stamp verdict for stamped kinds, else null. */
  verdict: string | null;
  /** Whether the folder has a saved per-folder connection. */
  recorded: boolean;
  wiring: InventoryRow["wiring"];
}

export interface StatusDocument {
  contract_version: typeof STATUS_CONTRACT_VERSION;
  suite_version: string;
  /** The record for `--dir` (or the working directory), or null. */
  connection: { dir: string; suite_url: string; runtime_id: string } | null;
  /** A 0.7.0 machine-level connection, assigned to no folder, or null. */
  legacy_connection: { suite_url: string; runtime_id: string } | null;
  agents: StatusAgentRow[];
}

export const STATUS_FIELDS = [
  "contract_version",
  "suite_version",
  "connection",
  "legacy_connection",
  "agents",
] as const satisfies readonly (keyof StatusDocument)[];

export const AGENT_FIELDS = [
  "session",
  "kind",
  "root",
  "runtime_id",
  "suite_url",
  "state",
  "channel",
  "verdict",
  "recorded",
  "wiring",
] as const satisfies readonly (keyof StatusAgentRow)[];

export interface StatusJsonInput {
  source: InventorySource;
  /** The record `--dir` (or cwd) resolves to, or null. */
  connection: AgentConnection | null;
  legacy: { suiteUrl: string; runtimeId: string } | null;
  detect(session: string, kind: InventoryRow["kind"]): Promise<InventoryRow["state"]>;
}

/** The document. Pure given its input. */
export async function statusDocument(input: StatusJsonInput): Promise<StatusDocument> {
  const rows = await inventoryRows(input.source, input.detect);
  const c = input.connection?.record ?? null;
  return {
    contract_version: STATUS_CONTRACT_VERSION,
    suite_version: VERSION,
    connection: c === null ? null : { dir: c.dir, suite_url: c.suiteUrl, runtime_id: c.runtimeId },
    legacy_connection: input.legacy === null ? null : { suite_url: input.legacy.suiteUrl, runtime_id: input.legacy.runtimeId },
    agents: rows.map((r) => ({
      session: r.session,
      kind: r.kind,
      root: r.root,
      runtime_id: r.runtime_id,
      suite_url: r.suite_url,
      state: r.state,
      channel: r.channel,
      verdict: r.verdict,
      recorded: r.recorded,
      wiring: r.wiring,
    })),
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

/** `--dir PATH` out of `suite status` arguments. */
export function parseStatusArgs(args: string[]): { json: boolean; dir?: string } {
  const out: { json: boolean; dir?: string } = { json: args.includes("--json") };
  const i = args.indexOf("--dir");
  if (i !== -1 && args[i + 1] !== undefined) out.dir = args[i + 1];
  return out;
}

/** The live input for {@link statusDocument}. Reads; never writes; never reads a token. */
export function liveStatusJsonInput(
  env: Record<string, string | undefined>,
  dir: string,
  tmux: DoctorDeps["tmux"],
): StatusJsonInput {
  const { legacy } = connectionsOf(env);
  return {
    source: liveInventorySource(env),
    connection: readAgentConnection(env, dir).connection,
    legacy,
    detect: (session, kind) => detectState(session, tmux, agentNameForKind(kind ?? "claude")),
  };
}

/** The live file read: text, or null for anything unreadable. */
export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `suite status` shares doctor's live dependencies, plus the roster read. */
export async function liveStatusDeps(env: Record<string, string | undefined> = process.env): Promise<StatusDeps> {
  return { ...(await liveDoctorDeps(env)), home: env.HOME ?? "", readFile: readFileOrNull };
}

/** Re-exported so a caller can resolve a binary the same way status does. */
export { whichBin };
