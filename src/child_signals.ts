/**
 * Run a child in the foreground and take it down with us.
 *
 * `suite hermes|openclaw --gateway-only --no-session` is a wrapper: this CLI
 * resolves refs, then spawns the gateway and waits for it. Without a handler,
 * a SIGTERM to the wrapper (a service manager stopping it, `timeout`, `kill`)
 * ends the wrapper and leaves the gateway running, reparented to init and
 * still holding its port and its runtime socket. MEASURED in the stage-5
 * review: two such orphans (a `hermes` gateway and an `openclaw-gateway`)
 * outlived their `timeout`-signalled wrappers and had to be killed by pid.
 *
 * So the wrapper forwards the signal to the child and then waits for it,
 * exiting only once the child has.
 *
 * SIGINT IS DIFFERENT. A Ctrl-C at a terminal is delivered by the kernel to
 * the whole foreground process group, the child included. Forwarding it as
 * well would hand the child a SECOND interrupt, which harnesses treat as
 * "force quit" (Claude Code exits on a double Ctrl-C). With a terminal on
 * stdin, SIGINT is therefore only caught (so the wrapper outlives the child
 * instead of orphaning it), never re-sent; without one, nothing else can have
 * delivered it to the child, so it is forwarded.
 */
import type { Subprocess } from "bun";

export const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export interface ForwardOptions {
  cwd: string;
  env: Record<string, string>;
  /** Whether stdin is a terminal. Decides SIGINT (see the module doc). */
  stdinIsTTY?: boolean;
  /** Called once the child exists, with its pid. For tests and logs. */
  onSpawn?(pid: number): void;
}

/** Whether a signal received by the wrapper should be re-sent to the child. */
export function shouldForward(signal: ForwardedSignal, stdinIsTTY: boolean): boolean {
  return signal !== "SIGINT" || !stdinIsTTY;
}

/** The shell convention for a child's exit: its code, or 128 + the signal that ended it. */
export function exitStatus(exitCode: number | null, signalCode: string | null): number {
  if (exitCode !== null) return exitCode;
  return 128 + (signalCode !== null ? (SIGNAL_NUMBERS[signalCode] ?? 0) : 0);
}

/**
 * Spawn `argv` with inherited stdio, forward termination signals to it, and
 * resolve with its exit status once it has exited. The handlers are removed
 * before resolving.
 */
export async function runForwardingSignals(argv: string[], options: ForwardOptions): Promise<number> {
  const child: Subprocess = Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const tty = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = (): void => {
      if (!shouldForward(signal, tty) || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  // Announce the child only once the handlers exist. Announcing first left a
  // window where a signal sent on seeing the pid hit the wrapper's DEFAULT
  // action, killing it and orphaning the child (CI: SIGINT or SIGHUP case
  // failing intermittently, 3s wait, child still alive).
  options.onSpawn?.(child.pid);
  try {
    await child.exited;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
  return exitStatus(child.exitCode, child.signalCode);
}
