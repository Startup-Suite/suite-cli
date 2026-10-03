/**
 * Bringing agents back after a reboot.
 *
 * A tmux session does not survive a power cycle, and nothing on the box knows
 * how to recreate one — the session NAME is a hash of the working directory,
 * so it is not reversible into the command that made it. An agent that goes
 * down in the night therefore stays down until a human notices, which is how a
 * host came back from a power cycle with one of its agents simply missing.
 *
 * So record what was started, at the moment it is started, and replay it.
 *
 * DELIBERATELY OPT-IN. The unit that runs this at boot is written by `suite
 * init` but NOT enabled: starting agent processes unattended is a decision an
 * operator makes per machine, not a default they discover after it happens.
 */

export interface RosterEntry {
  /** tmux session name — the identity, and the dedupe key. */
  session: string;
  /**
   * The FULL tmux argv that created the session, replayed verbatim with only
   * argv[0] re-resolved to the current tmux path.
   *
   * Stored whole rather than reconstructed from parts. Rebuilding the command
   * at restore time is where a recovery quietly starts something subtly
   * different from what was running — different flags, different quoting — and
   * the operator has no way to notice.
   */
  command: string[];
  /** Working directory the session was started in. */
  cwd: string;
  /** Which verb produced it. Recorded for the operator, not branched on. */
  kind: "claude" | "deepseek" | "hermes" | "openclaw" | "codex";
  /** ISO timestamp of the most recent launch. */
  recordedAt: string;
}

export const ROSTER_VERSION = 1;

export function rosterPath(home: string): string {
  return `${home}/.local/state/suite/agents.json`;
}

/**
 * Parse the roster, discarding anything malformed rather than throwing.
 *
 * A corrupt or half-written roster must not stop the CLI from launching an
 * agent — the roster is a convenience for recovery, and refusing to work
 * because the convenience is damaged inverts its purpose.
 */
export function parseRoster(text: string): RosterEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) return [];
  const out: RosterEntry[] = [];
  for (const item of list) {
    const e = item as Partial<RosterEntry>;
    if (typeof e.session !== "string" || e.session === "") continue;
    if (!Array.isArray(e.command) || e.command.some((c) => typeof c !== "string")) continue;
    if (e.command.length === 0) continue;
    if (typeof e.cwd !== "string" || e.cwd === "") continue;
    out.push({
      session: e.session,
      command: e.command as string[],
      cwd: e.cwd,
      kind: e.kind === "deepseek" || e.kind === "hermes" || e.kind === "openclaw" || e.kind === "codex" ? e.kind : "claude",
      recordedAt: typeof e.recordedAt === "string" ? e.recordedAt : "",
    });
  }
  return out;
}

export function serializeRoster(entries: RosterEntry[]): string {
  return `${JSON.stringify({ version: ROSTER_VERSION, agents: entries }, null, 2)}\n`;
}

/** Record a launch. Session name is the identity, so a relaunch replaces. */
export function upsertEntry(entries: RosterEntry[], entry: RosterEntry): RosterEntry[] {
  return [...entries.filter((e) => e.session !== entry.session), entry];
}

/** Drop an agent so a retired one does not resurrect at every boot. */
export function forgetEntry(entries: RosterEntry[], session: string): RosterEntry[] {
  return entries.filter((e) => e.session !== session);
}

export interface RestoreDecision {
  entry: RosterEntry;
  action: "start" | "skip";
  reason: string;
}

/**
 * What to do for each recorded agent, given the sessions that already exist.
 *
 * THE GUARD THAT MATTERS: never start a session that is already live. Two
 * agents in one working directory is not a duplicate that resolves itself —
 * they overwrite each other's edits, and the damage surfaces later as a compile
 * error nobody can attribute. Restore must be a no-op on a healthy box, which
 * also makes it safe to run by hand at any time.
 */
export function restorePlan(entries: RosterEntry[], liveSessions: string[]): RestoreDecision[] {
  const live = new Set(liveSessions);
  return entries.map((entry) =>
    live.has(entry.session)
      ? { entry, action: "skip" as const, reason: "already running" }
      : { entry, action: "start" as const, reason: "not running" },
  );
}

/* ------------------------------------------------------------------------- */
/* Adopting sessions that predate the roster                                  */
/* ------------------------------------------------------------------------- */

export interface RunningSession {
  session: string;
  cwd: string;
  /** argv of the agent process inside the pane, from the process table. */
  argv: string[];
}

/**
 * Build roster entries for agents that are already running.
 *
 * Without this the feature helps nobody: every agent currently on a box was
 * started before any recording existed, so a roster populated only by future
 * launches would restore nothing after the next reboot — while looking like it
 * was working.
 *
 * The reconstruction is honest but not identical. tmux does not retain the argv
 * that created a session, so the command is taken from the pane's live process
 * table. For an agent that is exactly what we want to re-run; for a session
 * whose pane holds something else, it would be wrong, which is why only
 * sessions this CLI named are eligible and why adoption is an explicit verb
 * rather than something that happens quietly.
 */
export function adoptEntries(
  running: RunningSession[],
  existing: RosterEntry[],
  now: string,
  prefix = "suite-",
): RosterEntry[] {
  const known = new Set(existing.map((e) => e.session));
  const out: RosterEntry[] = [];
  for (const r of running) {
    if (!r.session.startsWith(prefix)) continue;
    if (known.has(r.session)) continue;
    if (r.argv.length === 0 || r.cwd === "") continue;
    out.push({
      session: r.session,
      command: ["tmux", "new-session", "-d", "-s", r.session, "-c", r.cwd, ...r.argv],
      cwd: r.cwd,
      kind: kindFromArgv(r.argv),
      recordedAt: now,
    });
  }
  return out;
}

const programName = (arg: string): string => arg.slice(arg.lastIndexOf("/") + 1);

/**
 * This CLI's own gateway relaunch — the process a `suite hermes` or `suite
 * openclaw` session's pane actually runs:
 *
 *   <bun> <.../cli.ts> hermes   --root DIR --gateway-only --no-session ...
 *   <bun> <.../cli.ts> openclaw --root DIR --gateway-only --no-session ...
 *
 * `--gateway-only` is internal to that relaunch, so its presence is what marks
 * it. The verb is the first argument that is EXACTLY `hermes` or `openclaw`;
 * the verb precedes every flag, so a flag value (a `--hermes /path/hermes`
 * binary, a root named `openclaw`) can only come after it.
 */
export function stampRelaunchKind(argv: string[]): "hermes" | "openclaw" | null {
  if (!argv.includes("--gateway-only")) return null;
  for (const a of argv) {
    if (a === "--gateway-only") return null;
    if (a === "hermes" || a === "openclaw") return a;
  }
  return null;
}

/**
 * A gateway started directly rather than through the relaunch:
 * `<...>/hermes gateway run ...` or `<...>/openclaw gateway run ...`.
 *
 * NOT the running OpenClaw gateway's own argv. `gateway run` overwrites its
 * process title to `openclaw-gateway`, after which the args no longer name the
 * program or the subcommand; that argv could not be replayed, so it is
 * deliberately not recognised here. Adopting such a pane finds the relaunch
 * above it instead, or nothing.
 */
export function bareGatewayKind(argv: string[]): "hermes" | "openclaw" | null {
  const g = argv.indexOf("gateway");
  if (g <= 0 || argv[g + 1] !== "run") return null;
  const programs = argv.slice(0, g).map(programName);
  if (programs.includes("hermes")) return "hermes";
  if (programs.includes("openclaw")) return "openclaw";
  return null;
}

/**
 * Which verb an adopted argv belongs to. Recorded for the operator and for
 * `suite status`, which picks the process name to look for by it.
 *
 * The Hermes and OpenClaw shapes are checked FIRST: their argv carries a root
 * path, and a root whose path happens to contain `dsh` must not read as a
 * DeepSeek agent.
 */
export function kindFromArgv(argv: string[]): RosterEntry["kind"] {
  const stamped = stampRelaunchKind(argv) ?? bareGatewayKind(argv);
  if (stamped !== null) return stamped;
  // The `suite codex` bridge relaunch: `<bun> <cli.ts> codex … --no-session`.
  const verb = argv.indexOf("codex");
  if (verb > 0 && argv.includes("--no-session") && programName(argv[verb - 1] ?? "") !== "codex") return "codex";
  return argv.some((a) => a.includes("dsh")) ? "deepseek" : "claude";
}
