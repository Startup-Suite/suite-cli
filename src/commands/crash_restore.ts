/**
 * The watchdog's crash-restore pass: every `suite watch` tick brings back a
 * RECORDED agent whose session has died, with no human in the loop.
 *
 * Before 0.8.0 the watchdog only recovered HALTED live sessions; an agent whose
 * process died stayed down until someone ran `suite restore`. This pass closes
 * that gap for agents in the roster (`~/.local/state/suite/agents.json`) — and
 * only those: a session this CLI never recorded is not ours to start.
 *
 *  - state `none` (the session is gone — what a killed agent leaves, since its
 *    pane exits with it): replayed through `startEntry`, the same code path as
 *    `suite restore`, so a Claude session's launch dialogs are answered exactly
 *    as in 0.6.1.
 *  - state `stale` (the session exists but its agent does not): that exact
 *    session (`=NAME`) is killed, then replayed. A pane left holding a shell is
 *    not an agent.
 *  - the crash-loop guard (crash_guard.ts): at most 3 restarts per agent per
 *    10 minutes; the 4th death marks it `crash_looping` and it is left down
 *    until `suite restore`.
 *
 * Every restore, refusal and crash-loop mark is written to the agent's own
 * session log (`~/.local/state/suite/sessions/<session>.log`).
 *
 * AN AGENT STOPPED ON PURPOSE IS RESTARTED TOO, while it stays in the roster —
 * from outside, a killed session and a crashed one look the same. Retire an
 * agent with `suite restore --forget NAME`.
 */
import type { AnswerResult } from "../claude_dialogs.ts";
import { decideRestart, parseGuard, restartsPath, serializeGuard } from "../crash_guard.ts";
import { resolveTmux } from "../halt.ts";
import { detectState } from "../tmux.ts";
import { loadRoster, startEntry, type RestoreDeps } from "./restore.ts";
import { agentNameForKind } from "./status.ts";

export interface CrashRestoreDeps extends RestoreDeps {
  readGuard(path: string): string | null;
  writeGuard(path: string, contents: string): void;
  /** Append one line to a session's own log. */
  sessionLog(session: string, line: string): void;
}

export interface CrashRestoreResult {
  restored: string[];
  crashLooping: string[];
  failed: string[];
}

export async function crashRestorePass(
  deps: CrashRestoreDeps,
  home: string,
  opts: { apply: boolean },
): Promise<CrashRestoreResult> {
  const result: CrashRestoreResult = { restored: [], crashLooping: [], failed: [] };
  const entries = loadRoster(deps, home);
  if (entries.length === 0) return result;
  let guard = parseGuard(deps.readGuard(restartsPath(home)));
  let guardChanged = false;
  const answering: Promise<AnswerResult>[] = [];

  for (const entry of entries) {
    const state = await detectState(entry.session, deps.tmux, agentNameForKind(entry.kind));
    if (state === "live") continue;

    const decision = decideRestart(guard, entry.session, deps.now());
    if (!decision.allow) {
      result.crashLooping.push(entry.session);
      if (decision.becameLooping) {
        guard = decision.next;
        guardChanged = true;
        const line = `crash_looping: died again after ${decision.recent} restarts in 10 minutes — not restarting until \`suite restore\``;
        deps.log(`${entry.session}: ${line}`);
        deps.sessionLog(entry.session, `suite watch: ${line}`);
      }
      continue;
    }
    if (!opts.apply) {
      deps.log(`${entry.session}: ${state} — would restore (dry run)`);
      continue;
    }

    if (state === "stale") {
      // Exact-match target: a bare name would prefix-match another agent's session.
      await deps.tmux.run([resolveTmux(deps.tmux.which), "kill-session", "-t", `=${entry.session}`]);
    }
    const started = await startEntry(deps, home, entry);
    const n = decision.recent + 1;
    // The session turned out to be there: nothing was restarted, so nothing
    // is counted against the crash-loop budget (review round 2).
    if (started.alreadyRunning === true) {
      deps.log(`${entry.session}: already running — not restarted, not counted`);
      continue;
    }
    // Counted only once a start was actually attempted on an absent session.
    guard = decision.next;
    guardChanged = true;
    if (started.ok) {
      result.restored.push(entry.session);
      const line = `restored by suite watch (session was ${state === "stale" ? "stale" : "gone"}; restart ${n} of at most 3 in 10 minutes) in ${entry.cwd}`;
      deps.log(`${entry.session}: ${line}`);
      deps.sessionLog(entry.session, `suite watch: ${line}`);
      if (started.answering !== null) answering.push(started.answering);
    } else {
      result.failed.push(entry.session);
      const line = `restore FAILED (restart ${n}): ${started.stderr.trim().slice(0, 160)}`;
      deps.log(`${entry.session}: ${line}`);
      deps.sessionLog(entry.session, `suite watch: ${line}`);
    }
  }

  if (guardChanged) {
    try {
      deps.writeGuard(restartsPath(home), serializeGuard(guard));
    } catch (error) {
      deps.log(`could not write ${restartsPath(home)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await Promise.all(answering);
  return result;
}
