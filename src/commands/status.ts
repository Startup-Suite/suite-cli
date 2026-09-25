/**
 * `suite status` — what this box IS right now, in one screen.
 *
 * Three questions, and deliberately no diagnosis: `suite doctor` is the verb
 * that tells you what is wrong and how to fix it, and duplicating its
 * remediation here would give two places to keep true.
 *
 *  1. WHICH RUNTIME IS THIS BOX FEDERATED AS. The runtime id, from config —
 *     NEVER the token. The id is what Suite shows in its own UI, so it is the
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
import { channelStatus, liveDoctorDeps, type DoctorDeps } from "./doctor.ts";
import { emptyConfig } from "../config.ts";
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
    case "claude":
      return AGENT_NAME;
  }
}

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
  const config = deps.config ?? emptyConfig();
  const say = deps.out;
  const roster = readRoster(deps);
  say("");

  // 1. Federation identity. The token is not read, let alone printed.
  if (config.runtimeId === "") {
    say(row("runtime", "not federated", deps.configFile));
    say("");
    say("suite init");
    // A stamped agent carries its own identity in its root, so it is listed
    // even on a box that `suite init` never federated.
    await sayAgents(deps, roster, options);
    return 1;
  }
  say(row("runtime", config.runtimeId, config.suiteUrl));

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
  deps.out(row("agents", String(agents.length)));
  for (const agent of agents) deps.out(agentLine(agent, options));
  return agents.every((a) => a.state === "live");
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
