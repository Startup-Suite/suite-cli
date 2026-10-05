/**
 * The crash-loop guard for the watchdog's restore pass.
 *
 * `suite watch` restores a recorded agent whose session has died (see
 * commands/crash_restore.ts). An agent that dies on every start — a bad
 * credential, a broken checkout, a harness that refuses to launch — would then
 * be restarted every tick forever, each start costing a launch, a dialog poll
 * and a line in the log. So: at most CRASH_LOOP_MAX_RESTARTS restarts per agent
 * in CRASH_LOOP_WINDOW_MS. The next death inside the window marks the agent
 * `crash_looping`, which `suite status --json` reports, and the pass leaves it
 * alone until a person runs `suite restore` (which clears the mark).
 *
 * Pure: state in, state out. The file lives beside the roster:
 * `~/.local/state/suite/restarts.json`. It holds session names and timestamps,
 * nothing else.
 */
import { CRASH_LOOP_MAX_RESTARTS, CRASH_LOOP_WINDOW_MS } from "./tuning.ts";

export interface GuardEntry {
  /** ISO timestamps of watchdog restarts still inside the window. */
  restarts: string[];
  crash_looping: boolean;
  /** When the agent was marked crash_looping; null otherwise. */
  since: string | null;
}

export interface GuardState {
  version: 1;
  agents: Record<string, GuardEntry>;
}

export function restartsPath(home: string): string {
  return `${home}/.local/state/suite/restarts.json`;
}

export function emptyGuard(): GuardState {
  return { version: 1, agents: {} };
}

/** Tolerant: an unreadable file is an empty guard, never a reason to stop restoring. */
export function parseGuard(text: string | null): GuardState {
  if (text === null) return emptyGuard();
  try {
    const raw = JSON.parse(text) as { agents?: Record<string, Partial<GuardEntry>> };
    const out = emptyGuard();
    for (const [session, e] of Object.entries(raw.agents ?? {})) {
      out.agents[session] = {
        restarts: Array.isArray(e.restarts) ? e.restarts.filter((t): t is string => typeof t === "string") : [],
        crash_looping: e.crash_looping === true,
        since: typeof e.since === "string" ? e.since : null,
      };
    }
    return out;
  } catch {
    return emptyGuard();
  }
}

export function serializeGuard(state: GuardState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function isCrashLooping(state: GuardState, session: string): boolean {
  return state.agents[session]?.crash_looping === true;
}

export interface GuardDecision {
  /** Restart now. */
  allow: boolean;
  /** This decision is the one that marked the agent crash_looping. */
  becameLooping: boolean;
  /** Restarts already inside the window before this one. */
  recent: number;
  next: GuardState;
}

/**
 * Whether a dead agent may be restarted at `now`. When allowed, the restart is
 * recorded in `next`; when it is the (max+1)th death in the window, `next`
 * marks it crash_looping and no restart is allowed.
 */
export function decideRestart(
  state: GuardState,
  session: string,
  now: Date,
  max: number = CRASH_LOOP_MAX_RESTARTS,
  windowMs: number = CRASH_LOOP_WINDOW_MS,
): GuardDecision {
  const prev = state.agents[session] ?? { restarts: [], crash_looping: false, since: null };
  if (prev.crash_looping) return { allow: false, becameLooping: false, recent: prev.restarts.length, next: state };
  const cutoff = now.getTime() - windowMs;
  const recent = prev.restarts.filter((t) => {
    const ms = Date.parse(t);
    return Number.isFinite(ms) && ms > cutoff;
  });
  const next: GuardState = { version: 1, agents: { ...state.agents } };
  if (recent.length >= max) {
    next.agents[session] = { restarts: recent, crash_looping: true, since: now.toISOString() };
    return { allow: false, becameLooping: true, recent: recent.length, next };
  }
  next.agents[session] = { restarts: [...recent, now.toISOString()], crash_looping: false, since: null };
  return { allow: true, becameLooping: false, recent: recent.length, next };
}

/** `suite restore`: a person has looked. Clear the mark and the history. */
export function clearGuard(state: GuardState, sessions?: string[]): { next: GuardState; cleared: string[] } {
  const next: GuardState = { version: 1, agents: { ...state.agents } };
  const cleared: string[] = [];
  for (const session of sessions ?? Object.keys(state.agents)) {
    const e = next.agents[session];
    if (e === undefined) continue;
    if (e.crash_looping) cleared.push(session);
    delete next.agents[session];
  }
  return { next, cleared };
}
