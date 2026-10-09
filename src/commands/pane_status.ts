/**
 * `suite pane-status --session NAME [--answer]` — one look at an agent's
 * Claude Code pane, as JSON.
 *
 * For a supervisor with no terminal (Suite's agent host), which needs to know
 * whether the agent is up, parked at a dialog, or waiting for a person to log
 * in, without classifying panes itself. Prints ONE JSON document on stdout and
 * writes the same document to the session's status file
 * (`sessionStatusPath`).
 *
 * `--answer` additionally answers ONE known launch dialog (the same answers
 * `suite claude` and `suite watch` give, through `answerOnce`) before
 * reporting. It never answers a login screen: logging in is the person's,
 * through Anthropic's own flow. The one confirmation it does answer is "use
 * this ANTHROPIC_API_KEY?", and only for the key in this process's own
 * environment (see `api-key-confirm` in claude_dialogs.ts).
 *
 * Exit status: 0 when the session exists, 1 when it is gone, 2 for bad usage.
 */
import { answerOnce, dialogCaptureArgv, sessionLogger, type DialogIo } from "../claude_dialogs.ts";
import { paneStatus, sessionStatusPath, writePaneStatus, type PaneStatus } from "../claude_login.ts";
import { resolveTmux } from "../halt.ts";
import { liveTmuxDeps, type TmuxDeps } from "../tmux.ts";

export interface PaneStatusOptions {
  session?: string;
  answer: boolean;
}

export function parsePaneStatusArgs(args: string[]): PaneStatusOptions | { error: string } {
  const out: PaneStatusOptions = { answer: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--session" && args[i + 1] !== undefined) {
      out.session = args[++i];
    } else if (arg === "--answer") {
      out.answer = true;
    } else {
      return { error: `unknown argument "${arg}"` };
    }
  }
  if (out.session === undefined || out.session === "") return { error: "--session NAME is required" };
  return out;
}

export interface PaneStatusDeps {
  tmux: TmuxDeps;
  env: Record<string, string | undefined>;
  cwd: string;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
  write(path: string, status: PaneStatus): void;
  dialogs: DialogIo;
}

export async function runPaneStatus(deps: PaneStatusDeps, args: string[]): Promise<number> {
  const parsed = parsePaneStatusArgs(args);
  if ("error" in parsed) {
    deps.err(`suite pane-status: ${parsed.error}`);
    return 2;
  }
  const session = parsed.session!;
  const home = deps.env.HOME ?? "";
  // The agent's own key, from its environment: compared, never printed.
  const apiKey = deps.env.ANTHROPIC_API_KEY;
  if (parsed.answer) await answerOnce(deps.dialogs, { session, cwd: deps.cwd, home, apiKey });

  const tmux = resolveTmux(deps.tmux.which);
  const cap = await deps.tmux.run(dialogCaptureArgv(session, tmux));
  const status = paneStatus(session, cap.exitCode === 0 ? cap.stdout : null, { cwd: deps.cwd, home, apiKey }, deps.now());
  try {
    deps.write(sessionStatusPath(home, session), status);
  } catch (error) {
    deps.err(`suite pane-status: could not write the status file: ${error instanceof Error ? error.message : String(error)}`);
  }
  deps.out(JSON.stringify(status));
  return status.state === "gone" ? 1 : 0;
}

export function livePaneStatusDeps(): PaneStatusDeps {
  const env = process.env;
  const tmux = liveTmuxDeps(env);
  const home = env.HOME ?? "";
  const log = sessionLogger(home, (line) => console.error(line));
  return {
    tmux,
    env,
    cwd: process.cwd(),
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    write: writePaneStatus,
    dialogs: { tmux, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log },
  };
}
