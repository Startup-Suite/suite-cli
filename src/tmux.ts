/**
 * The persistence engine: tmux session naming, state detection, and argv
 * composition. `suite claude` (stage 5) is the verb on top of this module.
 *
 * WHY THIS EXISTS. A Claude Code process that dies with its terminal is an
 * agent that stops mid-task, and from Suite's side that is indistinguishable
 * from an agent that is merely slow — the router keeps waiting on a runtime
 * that no longer exists. Running the agent inside tmux decouples the process
 * from the terminal that started it.
 *
 * SCOPE IS tmux, DELIBERATELY. There is no multiplexer abstraction here and no
 * screen/zellij backend. A second implementation is the thing that would earn
 * an interface; one implementation behind an interface is just indirection.
 *
 * Three ideas carry the module:
 *
 *  1. A SESSION NAME IS DERIVED, NOT REMEMBERED. See {@link sessionNameFor}.
 *  2. SESSION EXISTENCE CANNOT TELL LIVE FROM STALE. See {@link detectState}.
 *  3. ARGV COMPOSITION IS A PURE FUNCTION. See {@link newSessionArgv}. It is
 *     pure so the quoting behaviour — the stated failure mode — is asserted
 *     directly instead of only through a test that launches a real agent.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { assertNoSecretsInArgv, type CredentialStore } from "./secrets.ts";
import type { SuiteConfig } from "./config.ts";

export const TMUX = "tmux";

/* ------------------------------------------------------------------------- */
/* 1. Session naming                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Characters tmux itself gives meaning to inside a target.
 *
 * tmux addresses panes as `session:window.pane`, so a `:` or a `.` in a session
 * name makes `-t <name>` ambiguous: `-t my.project` asks for window `project`
 * of session `my`. Whitespace is excluded for the same class of reason — it
 * survives our argv composition, but it makes every hand-typed `tmux attach -t`
 * a quoting puzzle for the user. Everything outside the safe set collapses to
 * `-`, and the discriminating part of the name is a hash, so a collapse can
 * never merge two distinct projects.
 */
const SAFE_NAME = /[^A-Za-z0-9_-]+/g;

export function sanitizeSessionName(raw: string): string {
  const cleaned = raw.replace(SAFE_NAME, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "session" : cleaned;
}

/** Short, stable digest of an absolute path or id. Not a secret; not reversed. */
export function nameDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export const SESSION_PREFIX = "suite";

export interface SessionNameInput {
  /** Persisted preference from the stage-2 config. */
  naming: SuiteConfig["sessionNaming"];
  /** Working directory the user invoked `suite claude` from. */
  cwd: string;
  /** Runtime id this box is federated as. Used by the "runtime" rule. */
  runtimeId?: string;
  /** An explicit `--session NAME`, which beats both rules. */
  explicit?: string;
}

/**
 * Derive the session name.
 *
 * THE RULE IS PER WORKING DIRECTORY, and it is the default because it is the
 * only one of the three that satisfies both halves of the requirement on its
 * own: `suite claude` twice from the same directory finds the SAME session
 * (the name is a pure function of the resolved path, so nothing has to be
 * remembered or looked up), and two different projects cannot collide (the
 * name carries a digest of the absolute path).
 *
 * Per-RUNTIME naming is offered but not the default: one box is federated as
 * one runtime, so a runtime-scoped name gives every project on the box the
 * same session and the second project silently attaches to the first one's
 * agent — a collision that looks like a successful re-attach. It is the right
 * rule only when a box genuinely runs one agent, which is why it is a config
 * preference rather than a hardcoded choice.
 *
 * An explicit `--session` beats both, for the user who wants two agents in one
 * directory. It is sanitized identically; a name the user typed is still a
 * name tmux has to parse.
 *
 * The leading basename is decoration for humans reading `tmux ls`; the digest
 * is what makes the name unique. Two directories with the same basename get
 * the same readable half and different digests.
 */
export function sessionNameFor(input: SessionNameInput): string {
  if (input.explicit !== undefined && input.explicit.trim() !== "") {
    return sanitizeSessionName(input.explicit.trim());
  }
  if (input.naming === "runtime") {
    const id = (input.runtimeId ?? "").trim();
    if (id === "") throw new Error('sessionNaming is "runtime" but no runtimeId is configured; run suite init');
    return `${SESSION_PREFIX}-${sanitizeSessionName(id)}`;
  }
  const abs = resolve(input.cwd);
  return `${SESSION_PREFIX}-${sanitizeSessionName(basename(abs))}-${nameDigest(abs)}`;
}

/**
 * The naming rule as the persisted config expresses it.
 *
 * The preference lives in `config.json` (stage 2) rather than being decided
 * per invocation, because a rule that changed between runs would point the two
 * runs at two different sessions — the exact failure the rule exists to
 * prevent. `--session` remains a per-invocation override, deliberately, since
 * asking for a second agent HERE is a different request from changing the rule.
 */
export function sessionNameFromConfig(config: SuiteConfig, cwd: string, explicit?: string): string {
  return sessionNameFor({
    naming: config.sessionNaming,
    cwd,
    runtimeId: config.runtimeId,
    explicit,
  });
}

/* ------------------------------------------------------------------------- */
/* 2. Argv composition — pure                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The ONE audited shell-quoting helper.
 *
 * Nothing in the normal path uses it: every tmux invocation below is an argv
 * array, and an argv array reaches execve without a shell, so there is nothing
 * to quote. It exists for the two places a human-readable command string is
 * unavoidable — the remedy line `suite doctor` prints, and any future site that
 * genuinely needs a shell — and it is exported so those sites are greppable and
 * so this escaping is tested in one place instead of re-derived in three.
 *
 * Single quotes, with `'` closed and reopened (`'\''`), because inside single
 * quotes the shell expands nothing at all: `$VAR`, backticks, `!`, newlines and
 * backslashes are all literal.
 */
export function singleQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** A whole argv as one shell string. Display and remedy lines only. */
export function quoteArgv(argv: string[]): string {
  return argv.map(singleQuote).join(" ");
}

export interface NewSessionInput {
  session: string;
  /** The agent command and its arguments, already in argv form. */
  command: string[];
  /** Start directory for the session. */
  cwd?: string;
}

/**
 * (session, command argv) → the exact `tmux new-session` argv.
 *
 * PURE, so a test asserts the composition against arguments containing spaces,
 * quotes, `$VAR`, a leading `-` and newlines without spawning anything.
 *
 * The user's command is passed as SEPARATE argv elements. tmux ≥ 3.0 accepts
 * `new-session … shell-command [argument …]` and hands them to the pane
 * unchanged; folding them into one string would mean re-quoting them for a
 * shell that then re-splits them, which is precisely how an argument containing
 * a space or a quote gets corrupted.
 *
 * `-d` is not an optimisation. It creates the session DETACHED and attaching is
 * a separate step, which is what makes the caller's decision — attach, switch,
 * or leave it running — explicit rather than a side effect of creation, and is
 * what lets this run from inside tmux at all (see {@link nestingPlan}).
 *
 * The command is placed after all options, so tmux stops option parsing at it
 * and a user argument beginning with `-` is never mistaken for a tmux flag.
 */
export function newSessionArgv(input: NewSessionInput): string[] {
  if (input.command.length === 0) throw new Error("newSessionArgv requires a command");
  const argv = [TMUX, "new-session", "-d", "-s", input.session];
  if (input.cwd !== undefined && input.cwd !== "") argv.push("-c", input.cwd);
  argv.push(...input.command);
  return argv;
}

/** `tmux attach-session` for a session that already exists. */
export function attachArgv(session: string): string[] {
  return [TMUX, "attach-session", "-t", session];
}

/** `tmux switch-client`, the from-inside-tmux equivalent of attaching. */
export function switchClientArgv(session: string): string[] {
  return [TMUX, "switch-client", "-t", session];
}

/** `tmux kill-session` — scoped to ONE session, by name. Never kill-server. */
export function killSessionArgv(session: string): string[] {
  return [TMUX, "kill-session", "-t", session];
}

/**
 * Compose a new-session argv and refuse it if it carries a credential.
 *
 * A tmux command line sits in the process table for the life of the agent and
 * is readable by every user on the box via `ps`. Secrets reach Claude through
 * the MCP config written at `suite init` time, never through this argv — and
 * never through `send-keys`, which additionally types the value into a live
 * shell and its history.
 */
export function composeNewSession(input: NewSessionInput, store: CredentialStore): string[] {
  const argv = newSessionArgv(input);
  assertNoSecretsInArgv(argv, store);
  return argv;
}

/* ------------------------------------------------------------------------- */
/* 3. Three-way state detection                                               */
/* ------------------------------------------------------------------------- */

/**
 * LIVE — the session exists and an agent process is running in it.
 * STALE — the session exists, its shell is alive, the agent is gone.
 * NONE  — no session by that name.
 *
 * STALE is the state that has to be named. A tmux session routinely outlives
 * the process it was created for: the agent exits, the pane's shell stays, and
 * `tmux has-session` keeps answering yes forever. Attaching to that corpse is
 * WORSE than starting fresh, because it presents as a live agent and is not —
 * the user sees a prompt, Suite sees nothing, and nobody is told why.
 */
export type SessionState = "live" | "stale" | "none";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxDeps {
  run(argv: string[]): Promise<RunResult>;
  env: Record<string, string | undefined>;
  /** Absolute path of a binary on PATH, or null. */
  which(name: string): string | null;
}

/** Fields we ask tmux for, in order, tab separated. */
const PANE_FORMAT = "#{session_name}\t#{pane_pid}\t#{pane_current_command}";

export interface PaneRow {
  session: string;
  pid: number;
  command: string;
}

/** Parse `tmux list-panes -a -F` output. Pure; malformed lines are dropped. */
export function parsePanes(stdout: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [session, pid, ...rest] = line.split("\t");
    const n = Number.parseInt(pid ?? "", 10);
    if (session === undefined || !Number.isInteger(n)) continue;
    rows.push({ session, pid: n, command: (rest.join("\t") ?? "").trim() });
  }
  return rows;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Executable name as reported by ps (already a basename). */
  comm: string;
  /** Full command line. Read for matching; never logged. */
  args: string;
}

/** Parse `ps -Ao pid=,ppid=,comm=,args=`. Pure. */
export function parseProcesses(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m === null) continue;
    rows.push({
      pid: Number.parseInt(m[1] ?? "", 10),
      ppid: Number.parseInt(m[2] ?? "", 10),
      comm: basename(m[3] ?? ""),
      args: m[4] ?? "",
    });
  }
  return rows;
}

/** Default agent-process predicate: anything whose program name is `claude`. */
export const AGENT_NAME = "claude";

/**
 * Does this process look like the agent?
 *
 * Both the executable name and the words of the command line are checked,
 * because how Claude Code appears in `ps` depends on how it was installed: a
 * native binary reports `comm=claude`, while a JS entrypoint reports
 * `comm=node` (or `bun`) with `claude` appearing only as an argument. Matching
 * only `comm` would report STALE for a perfectly live agent, which sends the
 * user to start a second one on top of the first.
 */
export function looksLikeAgent(proc: ProcessRow, name: string = AGENT_NAME): boolean {
  if (proc.comm === name) return true;
  return proc.args.split(/\s+/).some((token) => token !== "" && basename(token) === name);
}

/**
 * Every descendant of `roots`, inclusive, from a process snapshot.
 *
 * The walk is why detection is honest. The pane's own `pane_current_command` is
 * the shell in every real case — the agent is a CHILD of that shell — so a
 * check that looked only at the pane command would call every live session
 * stale. Cycles are impossible in a pid tree but the visited set makes the walk
 * terminate regardless of what a snapshot happens to contain.
 */
export function descendants(processes: ProcessRow[], roots: number[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  const byPid = new Map<number, ProcessRow>();
  for (const p of processes) {
    byPid.set(p.pid, p);
    const siblings = byParent.get(p.ppid);
    if (siblings === undefined) byParent.set(p.ppid, [p]);
    else siblings.push(p);
  }
  const seen = new Set<number>();
  const out: ProcessRow[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = byPid.get(pid);
    if (self !== undefined) out.push(self);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return out;
}

/**
 * Decide the state from a pane listing and a process snapshot. Pure, so the
 * three-way decision is testable independently of the real tmux integration
 * test that produces those inputs.
 */
export function classify(
  panes: PaneRow[],
  processes: ProcessRow[],
  session: string,
  agentName: string = AGENT_NAME,
): SessionState {
  const mine = panes.filter((p) => p.session === session);
  if (mine.length === 0) return "none";
  if (mine.some((p) => basename(p.command) === agentName)) return "live";
  const tree = descendants(processes, mine.map((p) => p.pid));
  return tree.some((p) => looksLikeAgent(p, agentName)) ? "live" : "stale";
}

/**
 * The live query: list every pane on the server, snapshot the process table,
 * classify.
 *
 * `list-panes -a` rather than `has-session` on purpose. `has-session` answers
 * the question this function must NOT ask; it is the signal that cannot
 * distinguish LIVE from STALE.
 *
 * A tmux that is absent or has no server running is NONE, not an error: there
 * is genuinely no session by that name, and that is a state the caller already
 * handles.
 */
export async function detectState(
  session: string,
  deps: TmuxDeps,
  agentName: string = AGENT_NAME,
): Promise<SessionState> {
  if (deps.which(TMUX) === null) return "none";
  const panes = await deps.run([TMUX, "list-panes", "-a", "-F", PANE_FORMAT]);
  if (panes.exitCode !== 0) return "none";
  const rows = parsePanes(panes.stdout);
  if (!rows.some((r) => r.session === session)) return "none";
  const ps = await deps.run(["ps", "-Ao", "pid=,ppid=,comm=,args="]);
  return classify(rows, ps.exitCode === 0 ? parseProcesses(ps.stdout) : [], session, agentName);
}

/* ------------------------------------------------------------------------- */
/* 4. $TMUX nesting                                                           */
/* ------------------------------------------------------------------------- */

/** True when we are already running inside a tmux pane. */
export function insideTmux(env: Record<string, string | undefined>): boolean {
  const v = env.TMUX;
  return v !== undefined && v !== "";
}

export type NestingPlan =
  | { kind: "attach"; argv: string[] }
  | { kind: "switch"; argv: string[] }
  | { kind: "refuse"; message: string };

/**
 * How to reach an existing session, given where we are standing.
 *
 * From inside tmux we `switch-client` instead of attaching. `tmux attach` from
 * within a pane produces "sessions should be nested with care" and, when it is
 * forced, a session inside a session whose keys go to the wrong server — a
 * broken state that looks like the tool hanging. The one thing that must never
 * happen is arriving there silently: `refuse` names the command to run, and no
 * branch here falls through to a nested attach.
 */
export function nestingPlan(
  session: string,
  env: Record<string, string | undefined>,
  allowSwitch = true,
): NestingPlan {
  if (!insideTmux(env)) return { kind: "attach", argv: attachArgv(session) };
  if (allowSwitch) return { kind: "switch", argv: switchClientArgv(session) };
  return {
    kind: "refuse",
    message: [
      `already inside tmux: refusing to nest a session in itself.`,
      `  the session ${session} is running; reach it without leaving tmux:`,
      `  tmux switch-client -t ${session}`,
      `  or detach first with your prefix key then d, and re-run.`,
    ].join("\n"),
  };
}

/* ------------------------------------------------------------------------- */
/* 5. tmux absent                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The exact text emitted when we fall back to a direct exec.
 *
 * A SILENT FALLBACK IS FORBIDDEN. Running the agent directly reproduces the
 * failure this whole feature exists to prevent — the agent dies with the
 * terminal, mid-task, and Suite cannot tell that from slowness. The fallback is
 * still offered, because refusing to run at all on a box without tmux is worse
 * for the user than running without persistence; but it is never quiet, and the
 * warning names both the consequence and the remedy.
 */
export const TMUX_MISSING_WARNING = [
  "warning: tmux is not installed, so this agent will run directly in this terminal.",
  "  it will be KILLED when this terminal closes, mid-task, and Suite will keep",
  "  waiting on a runtime that no longer exists.",
  "  install tmux and re-run suite init to get persistent sessions.",
].join("\n");

export type LaunchPlan =
  | { kind: "tmux"; argv: string[]; session: string }
  | { kind: "direct"; argv: string[]; warning: string };

export interface LaunchInput {
  session: string;
  command: string[];
  cwd?: string;
  /** Where the warning goes. Required, so the fallback CANNOT be silent. */
  warn: (line: string) => void;
  store: CredentialStore;
}

/**
 * Decide how to start the agent, and say so out loud when persistence is lost.
 *
 * The warning sink is a required parameter rather than something the caller
 * remembers to print: a caller that forgets does not compile, which is the
 * only version of "never silent" that holds up over time.
 */
export function planLaunch(input: LaunchInput, deps: TmuxDeps): LaunchPlan {
  if (deps.which(TMUX) === null) {
    input.warn(TMUX_MISSING_WARNING);
    assertNoSecretsInArgv(input.command, input.store);
    return { kind: "direct", argv: [...input.command], warning: TMUX_MISSING_WARNING };
  }
  const argv = composeNewSession({ session: input.session, command: input.command, cwd: input.cwd }, input.store);
  return { kind: "tmux", argv, session: input.session };
}

/* ------------------------------------------------------------------------- */
/* Live dependencies                                                          */
/* ------------------------------------------------------------------------- */

function whichBin(name: string, env: Record<string, string | undefined>): string | null {
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = resolve(dir, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

export function liveTmuxDeps(env: Record<string, string | undefined> = process.env): TmuxDeps {
  return {
    env,
    which: (name) => whichBin(name, env),
    async run(argv) {
      const proc = Bun.spawn(argv, { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Session options                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Options applied to a session immediately after it is created.
 *
 * SCOPED TO THE SESSION, never `-g`. A global set would reach every tmux
 * session on the box including ones this CLI did not create, which is not ours
 * to change; a session-scoped set leaves the user's own tmux exactly as they
 * configured it.
 *
 * `mouse on` exists for one observable defect. With mouse mode OFF, tmux
 * translates a wheel event inside a full-screen application into arrow keys —
 * so scrolling an agent TUI walks its input history instead of its scrollback,
 * and the agent reports something like "scroll wheel is sending arrow keys".
 * With mouse mode ON the wheel reaches the pane's scrollback (or the
 * application, if it asked for mouse reporting) and the arrow-key translation
 * never happens.
 *
 * THE TRADE, stated because it is the reason not to do this blindly: mouse mode
 * also routes click-drag to tmux's own selection instead of the terminal's, so
 * a native selection needs the terminal's override modifier (Option on macOS,
 * Shift elsewhere) held down.
 */
export function sessionOptionsArgv(session: string): string[][] {
  return [[TMUX, "set-option", "-t", session, "mouse", "on"]];
}
