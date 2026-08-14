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
 *
 * Layout and colour are the shared ones (design canvas revision 1): same
 * two-column grid, same glyphs, same `NO_COLOR`/off-TTY rules, so status and
 * doctor read as one program.
 */
import { SGR, glyphFor, paint, row } from "../ui.ts";
import { CHANNEL_SERVER, whichBin } from "./init.ts";
import { SESSION_PREFIX, TMUX, detectState, type SessionState } from "../tmux.ts";
import { channelStatus, type DoctorDeps } from "./doctor.ts";
import { emptyConfig } from "../config.ts";

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

/** A session's state is glyph-led, like every other status line in the CLI. */
export function sessionLine(
  session: SessionRow,
  state: SessionState,
  now: number,
  options: { color: boolean; utf8: boolean },
): string {
  const status = state === "live" ? "pass" : "fail";
  const glyph = paint(
    glyphFor(status, options.utf8),
    state === "live" ? SGR.green : SGR.red,
    options.color,
  );
  const age = paint(formatAge(now - session.created), SGR.faint, options.color);
  return `  ${glyph}  ${session.name.padEnd(28, " ")}${SESSION_WORDS[state].padEnd(34, " ")}${age}`.trimEnd();
}

export async function runStatus(deps: DoctorDeps, now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const options = { color: deps.color, utf8: deps.utf8 };
  const config = deps.config ?? emptyConfig();
  const say = deps.out;
  say("");

  // 1. Federation identity. The token is not read, let alone printed.
  if (config.runtimeId === "") {
    say(row("runtime", "not federated", deps.configFile));
    say("");
    say("suite init");
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

  // 3. Sessions — three-way state, never a bare name list.
  say("");
  if (deps.which(TMUX) === null) {
    say(row("sessions", "unavailable", "tmux is not installed"));
    return ok ? 0 : 1;
  }
  const listed = await deps.tmux.run(listSessionsArgv());
  const sessions = ownSessions(listed.exitCode === 0 ? parseSessions(listed.stdout) : []);
  if (sessions.length === 0) {
    say(row("sessions", "none", "suite claude starts one"));
    return ok ? 0 : 1;
  }
  say(row("sessions", String(sessions.length)));
  for (const session of sessions) {
    const state = await detectState(session.name, deps.tmux);
    say(sessionLine(session, state, now, options));
    if (state === "stale") ok = false;
  }
  return ok ? 0 : 1;
}

/** `suite status` shares doctor's live dependencies; kept as one seam. */
export { liveDoctorDeps as liveStatusDeps } from "./doctor.ts";

/** Re-exported so a caller can resolve a binary the same way status does. */
export { whichBin };
