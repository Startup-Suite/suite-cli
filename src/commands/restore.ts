/**
 * `suite restore` — bring recorded agents back up.
 *
 * Safe to run at any time: it starts only sessions that are absent, so on a
 * healthy box it does nothing at all. That property is what lets it be both the
 * boot action and something an operator can run by hand without thinking about
 * whether it is a good moment.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type RosterEntry,
  type RunningSession,
  adoptEntries,
  forgetEntry,
  parseRoster,
  restorePlan,
  rosterPath,
  serializeRoster,
  upsertEntry,
} from "../roster.ts";
import {
  type TmuxDeps,
  descendants,
  liveTmuxDeps,
  looksLikeAgent,
  parsePanes,
  parseProcesses,
} from "../tmux.ts";
import { resolveTmux } from "../halt.ts";

export interface RestoreDeps {
  tmux: TmuxDeps;
  readRoster(path: string): string | null;
  writeRoster(path: string, contents: string): void;
  now(): Date;
  log(line: string): void;
}

export function liveRestoreDeps(env = process.env): RestoreDeps {
  return {
    tmux: liveTmuxDeps(env),
    readRoster: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeRoster: (p, contents) => {
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, contents);
    },
    now: () => new Date(),
    log: (line) => console.log(`suite restore: ${line}`),
  };
}

/** Read the roster, tolerating absence — an empty roster is not an error. */
export function loadRoster(deps: RestoreDeps, home: string): RosterEntry[] {
  const text = deps.readRoster(rosterPath(home));
  return text === null ? [] : parseRoster(text);
}

/**
 * Record a launch. Called by the verbs that create sessions, so the roster is
 * a by-product of normal use rather than something an operator maintains — a
 * list that has to be curated by hand is a list that is wrong when it matters.
 */
export function recordLaunch(
  deps: RestoreDeps,
  home: string,
  entry: Omit<RosterEntry, "recordedAt">,
): void {
  try {
    const next = upsertEntry(loadRoster(deps, home), {
      ...entry,
      recordedAt: deps.now().toISOString(),
    });
    deps.writeRoster(rosterPath(home), serializeRoster(next));
  } catch {
    // Never let bookkeeping stop an agent from starting.
  }
}

/** Session names tmux currently knows about. */
export async function liveSessions(deps: RestoreDeps): Promise<string[]> {
  const res = await deps.tmux.run([
    resolveTmux(deps.tmux.which),
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_pid}\t#{pane_current_command}",
  ]);
  return [...new Set(parsePanes(res.stdout).map((p) => p.session))];
}

/**
 * Discover running agent sessions and the command inside each pane.
 *
 * The pane's own `pane_current_command` names the shell, not the agent — the
 * agent is a CHILD of it — so the process table is walked for a descendant that
 * looks like an agent. This is the same trap `detectState` documents.
 */
export async function runningSessions(deps: RestoreDeps): Promise<RunningSession[]> {
  const tmux = resolveTmux(deps.tmux.which);
  const panes = await deps.tmux.run([
    tmux,
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_pid}\t#{pane_current_path}",
  ]);
  // FOUR columns, because that is what `parseProcesses` parses. This read
  // `pid=,ppid=,args=` and the mismatch was silent in the worst direction: the
  // parser's `(\S+)` group ate argv[0], so every adopted agent was recorded
  // WITHOUT the program name — `tmux new-session … -c <cwd> --dangerously-…`.
  // `looksLikeAgent` still matched (comm === "claude"), so adoption reported
  // success and the roster looked entirely plausible, while replaying it gave
  // `command new-session: invalid flag --` and no session at all. Two agents on
  // a real host were unrestorable from the day they were adopted.
  const ps = await deps.tmux.run(["ps", "-eo", "pid=,ppid=,comm=,args="]);
  const procs = parseProcesses(ps.stdout);
  const out: RunningSession[] = [];
  const seen = new Set<string>();
  for (const line of panes.stdout.split("\n")) {
    const [session, pid, cwd] = line.split("\t");
    if (!session || !pid || !cwd || seen.has(session)) continue;
    seen.add(session);
    const kids = descendants(procs, [Number(pid)]);
    const agent = kids.find((k) => looksLikeAgent(k)) ?? kids.find((k) => k.args.includes("dsh"));
    if (!agent) continue;
    out.push({ session, cwd, argv: agent.args.split(/\s+/).filter((a) => a !== "") });
  }
  return out;
}

export interface RestoreResult {
  started: string[];
  skipped: string[];
  failed: string[];
  adopted?: string[];
}

export async function runRestore(
  deps: RestoreDeps,
  home: string,
  opts: { apply: boolean; forget?: string; adopt?: boolean } = { apply: true },
): Promise<RestoreResult> {
  if (opts.adopt) {
    const existing = loadRoster(deps, home);
    const found = adoptEntries(await runningSessions(deps), existing, deps.now().toISOString());
    if (found.length === 0) {
      deps.log("no unrecorded agent sessions found");
      return { started: [], skipped: [], failed: [], adopted: [] };
    }
    deps.writeRoster(rosterPath(home), serializeRoster([...existing, ...found]));
    for (const e of found) deps.log(`adopted ${e.session} (${e.cwd})`);
    return { started: [], skipped: [], failed: [], adopted: found.map((e) => e.session) };
  }

  if (opts.forget) {
    const next = forgetEntry(loadRoster(deps, home), opts.forget);
    deps.writeRoster(rosterPath(home), serializeRoster(next));
    deps.log(`forgot ${opts.forget}`);
    return { started: [], skipped: [], failed: [] };
  }

  const entries = loadRoster(deps, home);
  if (entries.length === 0) {
    deps.log("no agents recorded — nothing to restore");
    return { started: [], skipped: [], failed: [] };
  }

  const live = await liveSessions(deps);
  const result: RestoreResult = { started: [], skipped: [], failed: [] };
  const tmux = resolveTmux(deps.tmux.which);

  for (const { entry, action, reason } of restorePlan(entries, live)) {
    if (action === "skip") {
      result.skipped.push(entry.session);
      deps.log(`${entry.session}: skipped — ${reason}`);
      continue;
    }
    if (!opts.apply) {
      deps.log(`${entry.session}: would start (${reason})`);
      result.started.push(entry.session);
      continue;
    }
    // Replay verbatim; only the tmux binary is re-resolved, since its path can
    // differ from the machine state at record time.
    const argv = [tmux, ...entry.command.slice(1)];
    const { exitCode, stderr } = await deps.tmux.run(argv);
    if (exitCode === 0) {
      result.started.push(entry.session);
      deps.log(`${entry.session}: started in ${entry.cwd}`);
    } else {
      result.failed.push(entry.session);
      deps.log(`${entry.session}: FAILED — ${stderr.trim().slice(0, 160)}`);
    }
  }
  return result;
}
