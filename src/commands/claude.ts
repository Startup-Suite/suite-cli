/**
 * `suite claude` — run Claude Code inside a persistent tmux session.
 *
 * WHY THE WRAPPER EXISTS AT ALL. Channel plugins must be on Anthropic's
 * allowlist to load normally; until this one is approved, every session needs
 * `--dangerously-load-development-channels server:suite-channel`. The wrapper
 * injects it so that when the plugin IS allowlisted the flag disappears from
 * one place and nobody's muscle memory changes.
 *
 * Three rules carry the module:
 *
 *  1. PASSTHROUGH IS TOTAL. The wrapper parses the verb `new` and a single
 *     leading `--`, and nothing else. Every remaining argument reaches Claude
 *     verbatim and in order, after the injected flag — including `--resume`,
 *     `--version`, `-p`, arguments that look like wrapper flags, arguments
 *     containing spaces or quotes, and `$HOME`, which is never expanded because
 *     nothing here goes near a shell. See {@link agentArgv}.
 *  2. COMPOSITION GOES THROUGH STAGE 4. Every tmux argv is built by
 *     `src/tmux.ts` ({@link composeNewSession}, {@link attachArgv}, …). There is
 *     deliberately no second composition path here: quoting bugs are what a
 *     second path produces.
 *  3. NOTHING SILENT. A STALE session is named before it is recycled, a missing
 *     tmux is warned about by stage 4, and the `dangerously` flag is announced
 *     once per machine — see {@link NOTICE_BODY}.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SuiteConfig } from "../config.ts";
import { agentConfig, agentConfigFor, readAgentConnection } from "../agent_connections.ts";
import { resolveTmux } from "../halt.ts";
import { statePath } from "../paths.ts";
import { createStore, spawnWithSecrets, ttyPrompter, type CredentialStore, type Prompter } from "../secrets.ts";
import { ensureConnection, ensureToken, loadSavedSecrets } from "../connection.ts";
import { ensureClaudeWiring, localEntries, needsRegistration, planMcp } from "../claude_wiring.ts";
import { type RestoreDeps, liveRestoreDeps, recordLaunch } from "./restore.ts";
import type { RosterEntry } from "../roster.ts";
import { type SupervisorIo, ensureSupervision, liveSupervisorIo } from "../supervisor.ts";
import { CHANNEL_SERVER, TOOLS_SERVER, confirm, defaultCheckout, type InstallPlan, type Runner } from "./init.ts";
import { CLAUDE_CODE_URL } from "./doctor.ts";
import { colorEnabled } from "../ui.ts";
import { answerLaunchDialogs, liveDialogIo, sessionLogPath, type AnswerResult, type DialogIo } from "../claude_dialogs.ts";
import { launchRecordPath, writeLaunchRecord, type LaunchRecord } from "../claude_launch.ts";
import { authError } from "../claude_login.ts";
import { isUnattended, seedLogLine, seedOnboarding, type SeedOutcome } from "../claude_onboarding.ts";
import { claudeJsonPath } from "./init.ts";
import {
  attachArgv,
  composeNewSession,
  detectState,
  hasSessionArgv,
  killSessionArgv,
  liveTmuxDeps,
  nestingPlan,
  CONTINUE_WRAPPER_NAME,
  planLaunch,
  quoteArgv,
  sessionOptionsArgv,
  sessionNameFromConfig,
  TMUX,
  type NestingPlan,
  type SessionState,
  type TmuxDeps,
} from "../tmux.ts";

/* ------------------------------------------------------------------------- */
/* 1. The argv delivered to Claude                                            */
/* ------------------------------------------------------------------------- */

export const AGENT = "claude";

/**
 * How this machine installs Claude Code, or null when we have no path we trust.
 *
 * MECHANISM, verified against https://code.claude.com/docs/en/setup on
 * 2026-08-14 (docs.claude.com redirects there): the recommended install for
 * macOS, Linux and WSL is `curl -fsSL https://claude.ai/install.sh | bash`,
 * which puts a launcher at `~/.local/bin/claude` with versions under
 * `~/.local/share/claude/versions/`. It is USER-OWNED and needs no sudo.
 *
 * DECISION — the native installer, not brew and not npm. Homebrew
 * (`brew install --cask claude-code`) and npm
 * (`npm install -g @anthropic-ai/claude-code`) both exist and both work, but
 * each covers only part of our audience and each adds a second thing that can
 * be missing. One mechanism spans macOS and Linux, so one is what we offer.
 * `sudo npm install -g` is not offered at all: the docs warn against it.
 *
 * Windows returns null — the Windows install is a different script
 * (`install.ps1` / `install.cmd`) run from a different shell, and guessing
 * which one the user is sitting in is how you print a command that cannot run.
 */
export function claudeInstallPlan(deps: Pick<ClaudeDeps, "platform">): InstallPlan | null {
  if (deps.platform !== "darwin" && deps.platform !== "linux") return null;
  return { manager: "claude.ai", argv: ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"] };
}

/**
 * What the installer itself needs. It fetches with curl and runs under bash;
 * on a box missing either, curl's own error is not the whole story, so we name
 * the missing tool and refuse rather than letting a pipe fail obscurely. Same
 * posture as the bun offer's precondition check in `init.ts`.
 */
export const CLAUDE_INSTALL_REQUIRED_TOOLS = ["curl", "bash"] as const;

export function missingClaudeInstallTools(deps: Pick<ClaudeDeps, "tmux">): string[] {
  return CLAUDE_INSTALL_REQUIRED_TOOLS.filter((tool) => deps.tmux.which(tool) === null);
}

/** Exit code when the agent is missing and was not installed. Non-zero, always. */
export const MISSING_AGENT_EXIT = 4;

/** The session was created and did not survive. Distinct so scripts can tell. */
export const SESSION_DIED_EXIT = 5;

/** Claude Code's Suite wiring (plugin, MCP entries, CLAUDE.md) could not be set up. */
export const WIRING_FAILED_EXIT = 6;

/**
 * How long to let a freshly created agent settle before judging it.
 *
 * Measured against the real failure: Claude printed its refusal and exited
 * about half a second in. A check with no wait at all reads the pane during the
 * window where every launch looks identical.
 */
export const SETTLE_MS = 1500;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The offer, printed BEFORE the question — so a user who declines has already
 * read it.
 *
 * LOGIN IS NOT OURS. We install a binary; we never touch anybody's
 * authentication. Saying so at the moment of the offer is the difference
 * between a tool that set you up and a tool that left you at a login screen
 * you did not expect.
 */
export function installOfferLines(plan: InstallPlan): string[] {
  return [
    `${AGENT} is not on PATH. ${CLAUDE_CODE_URL}`,
    `  suite can install it with the ${plan.manager} installer (no sudo; it lands in ~/.local/bin).`,
    `  you will still have to log in yourself: running ${AGENT} opens the browser login.`,
  ];
}

/** Said when the agent is still missing — refused, unavailable, or failed. */
export function missingAgentMessage(detail: string): string {
  return `${AGENT} is not installed: ${detail}. see ${CLAUDE_CODE_URL} — and note that logging in stays your step.`;
}

/**
 * Detect the agent; when it is absent, offer, install, and RE-DETECT.
 *
 * Returns null to mean "carry on" and an exit code to mean "stop". Nothing is
 * half-done: either `claude` answers `which` at the end of this function, or
 * the caller returns non-zero having said which thing is missing. This mirrors
 * the bun offer in `runInit` deliberately — a second style of asking would be a
 * second style to get wrong.
 *
 * NOTE it is called once, before EITHER exec path. The `-p` caller is a script
 * and reaches the direct exec without touching tmux; it must hit the same gate.
 */
export async function ensureAgent(deps: ClaudeDeps): Promise<number | null> {
  if (deps.tmux.which(AGENT) !== null) return null;

  const plan = claudeInstallPlan(deps);
  if (plan === null) {
    deps.err(missingAgentMessage(`no install path I know of for ${deps.platform}`));
    return MISSING_AGENT_EXIT;
  }

  const missing = missingClaudeInstallTools(deps);
  if (missing.length > 0) {
    // Refuse BEFORE the prompt: offering an install we already know cannot run
    // buys the user a download failure instead of an answer.
    deps.err(missingAgentMessage(`the ${plan.manager} installer needs ${missing.join(" and ")}, not on PATH`));
    return MISSING_AGENT_EXIT;
  }

  for (const line of installOfferLines(plan)) deps.out(line);
  if (!(await confirm(deps.prompter, `install ${AGENT} with the ${plan.manager} installer?`))) {
    deps.err(missingAgentMessage("declined"));
    return MISSING_AGENT_EXIT;
  }

  const r = await deps.tmux.run(plan.argv);
  if (r.exitCode !== 0) {
    deps.err(missingAgentMessage(`the ${plan.manager} installer failed: ${(r.stderr || r.stdout).trim()}`));
    return MISSING_AGENT_EXIT;
  }

  if (deps.tmux.which(AGENT) === null) {
    deps.err(missingAgentMessage("the installer reported success but it is still not on PATH"));
    return MISSING_AGENT_EXIT;
  }
  return null;
}

/** The injected flag, as separate argv elements. Removed once allowlisted. */
export const DEV_CHANNEL_ARGS = ["--dangerously-load-development-channels", "server:suite-channel"] as const;

/**
 * The Suite participation flags.
 *
 * WHY. A Suite runtime is an agent nobody is sitting in front of. Without
 * `--dangerously-skip-permissions` it stops on the first tool-call prompt and
 * waits for a human who is not there — the task looks hung when it is only
 * asking. Without `--continue` every launch is a cold session, so re-attaching
 * to a runtime loses everything it knew. Both are what the live runtimes are
 * already invoked with by hand; this makes the wrapper produce that argv
 * instead of requiring everyone to remember it.
 *
 * NOT SAFE ON ITS OWN in an interactive session. `claude --continue -p …` in an
 * empty directory answers normally (Claude Code 2.1.232, 2026-08-14), but the
 * INTERACTIVE form prints "No conversation found to continue" and exits 1
 * (reproduced 2026-09-26 on 2.1.281). So an interactive launch is wrapped in
 * {@link continueFallbackArgv}, which relaunches without the flag when the
 * `--continue` attempt fails; `-p` is left bare.
 *
 * `--resume` is the one conflict: it and `--continue` both choose a session, so
 * a user who names one must not be handed the other. See {@link agentArgv}.
 */
export const CONTINUE_ARG = "--continue";
export const SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";

/** Arguments that already choose a session, so `--continue` must stand down. */
const SESSION_SELECTORS = new Set([CONTINUE_ARG, "-c", "--resume", "-r", "--from-pr", "--teleport"]);

/**
 * Which Suite flags still need injecting, given what the user already passed.
 *
 * Exported so the decision is asserted directly rather than through a launch:
 * a test can pin "user said --resume ⇒ no --continue" without composing tmux.
 */
export function suiteArgs(userArgs: string[]): string[] {
  const args = stripTerminator(userArgs);
  const out: string[] = [];
  if (!args.some((a) => a === SKIP_PERMISSIONS_ARG)) out.push(SKIP_PERMISSIONS_ARG);
  if (!args.some((a) => SESSION_SELECTORS.has(a))) out.push(CONTINUE_ARG);
  return out;
}

/**
 * Drop the single leading `--`, if present.
 *
 * `--` terminates wrapper options. The wrapper HAS no options today, which is
 * exactly why the terminator is honoured now: a user who writes
 * `suite claude -- --resume` must get the same result once the wrapper grows
 * one, and a user who wants to send the literal word `new` to Claude needs a
 * way to say so. Only the FIRST `--` is ours; any later one is Claude's.
 */
export function stripTerminator(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

/**
 * (user arguments) → the exact argv delivered to Claude.
 *
 * Pure, and an ARRAY: it reaches execve without a shell, so `$HOME`, quotes,
 * spaces and a leading `-` are all literal bytes. The injected flag goes first
 * so that a user argument can never be absorbed as its value.
 */
export function agentArgv(userArgs: string[]): string[] {
  return [AGENT, ...DEV_CHANNEL_ARGS, ...suiteArgs(userArgs), ...stripTerminator(userArgs)];
}

/**
 * How long a failed `--continue` attempt may have run and still be retried
 * fresh. Seconds, measured in the pane from launch to exit.
 *
 * WHY A WINDOW AT ALL. The fallback exists for "there was nothing to continue",
 * which fails as soon as Claude looks — right after any pre-launch dialog is
 * answered. An agent that ran for an hour on a continued conversation and THEN
 * exited non-zero is a crash, not a first run; relaunching it fresh would keep
 * the pane up while silently dropping the conversation, where today the session
 * ends and the next `suite claude` continues it. The window keeps that case
 * exactly as it was. Five minutes covers a human reading the development-
 * channels and workspace-trust dialogs, which `suite claude` attaches them to
 * immediately; a dialog left unanswered longer than that gets today's
 * behaviour (the session ends) and the next launch retries.
 */
export const CONTINUE_FALLBACK_WINDOW_S = 300;

/**
 * The pane command's shell program. Static text: every value it touches
 * arrives as a positional parameter, so nothing is ever interpolated into it
 * (the only interpolations are our own two constants).
 *
 *   - exit 0, or death by signal (> 128): pass the status through, no retry;
 *   - a non-zero exit after {@link CONTINUE_FALLBACK_WINDOW_S}: pass through;
 *   - otherwise drop the FIRST `--continue` — ours, since the injected flags
 *     precede every user argument — and `exec` the rest, so the relaunched
 *     claude replaces the shell and a failure there ends the pane as before.
 *
 * `date +%s` is not POSIX but is on macOS, GNU and busybox; if it yields
 * nothing, the run is treated as inside the window.
 */
export const CONTINUE_FALLBACK_SCRIPT = [
  "t0=$(date +%s 2>/dev/null)",
  '"$@"',
  "rc=$?",
  '[ "$rc" -eq 0 ] && exit 0',
  '[ "$rc" -gt 128 ] && exit "$rc"',
  "t1=$(date +%s 2>/dev/null)",
  `[ -n "$t0" ] && [ -n "$t1" ] && [ $((t1 - t0)) -ge ${CONTINUE_FALLBACK_WINDOW_S} ] && exit "$rc"`,
  "found=0",
  `for a in "$@"; do shift; if [ "$found" = 0 ] && [ "$a" = ${CONTINUE_ARG} ]; then found=1; else set -- "$@" "$a"; fi; done`,
  '[ "$found" = 1 ] || exit "$rc"',
  `echo "suite: exit $rc with ${CONTINUE_ARG}; starting a fresh session (no conversation here to continue)" >&2`,
  'exec "$@"',
].join("; ");

/**
 * (agent argv) → the pane command, with the no-conversation fallback built in.
 *
 * WHY IN THE PANE, NOT IN THE WRAPPER. The first fix (PR #21) retried from
 * `runClaude` when the session was dead after SETTLE_MS. That is keyed on
 * timing, and any pre-launch dialog defeats it: Claude's development-channels
 * warning (and, in a new directory, the workspace-trust prompt) holds the
 * process alive for as long as nobody answers, so at 1.5 s the session reads
 * LIVE, the retry never fires, and the `--continue` failure comes later. The
 * shell in the pane sees the actual exit, whenever it happens.
 *
 * `sh -c SCRIPT NAME ARG…` — the argv stays an argv: each argument is a
 * positional parameter and reaches claude via `"$@"`, never through shell
 * text, so spaces, quotes and `$HOME` stay literal exactly as in the unwrapped
 * form. NAME ({@link CONTINUE_WRAPPER_NAME}) is `$0`, which is how restore's
 * adoption recognises the shell and skips it.
 *
 * Only wraps when `--continue` was injected by us: a user who chose a session
 * gets exactly what they asked for.
 */
export function continueFallbackArgv(command: string[], injected: boolean): string[] {
  if (!injected || !command.includes(CONTINUE_ARG)) return [...command];
  return ["/bin/sh", "-c", CONTINUE_FALLBACK_SCRIPT, CONTINUE_WRAPPER_NAME, ...command];
}

/** The pane command for an interactive launch. */
export function paneCommand(userArgs: string[]): string[] {
  return continueFallbackArgv(agentArgv(userArgs), suiteArgs(userArgs).includes(CONTINUE_ARG));
}

/**
 * Is this a one-shot, non-interactive call?
 *
 * DECISION, stated rather than implicit: `-p` / `--print` BYPASSES tmux and
 * execs Claude directly. `suite claude -p '…'` is a scripted call whose output
 * the caller captures; forcing it through an interactive attach hands it a
 * terminal it does not want, hides its stdout inside a pane, and leaves a
 * session behind for a process that had nothing to persist. There is no session
 * to keep alive, so there is nothing for tmux to buy.
 *
 * The scan covers arguments after `--` too, because Claude reads them as print
 * mode regardless of where they sit; the wrapper's job is to agree with the
 * program it is wrapping, not with its own parser.
 */
export function isNonInteractive(userArgs: string[]): boolean {
  return stripTerminator(userArgs).some((a) => a === "-p" || a === "--print");
}

/* ------------------------------------------------------------------------- */
/* 2. The first-run notice                                                    */
/* ------------------------------------------------------------------------- */

/**
 * ONE line, once per machine.
 *
 * A wrapper that silently hides a flag containing the word "dangerously"
 * trains people not to look at the next one. So it is said out loud — once,
 * and then never again, because a warning repeated on every run is a warning
 * nobody reads.
 *
 * DESIGN (design canvas revision 1, binding): a leading `!` in attention yellow
 * (ANSI 3), body at default weight, then one blank line and silence forever.
 * NO BOX, NO BORDER, NO RULE — a box is recurring chrome and reads as a
 * permanent banner; this appears once in the life of the machine and should
 * look like something that HAPPENED, not something that LIVES there. Yellow is
 * reserved for this notice and is used nowhere else in `suite claude`.
 */
export const NOTICE_BODY =
  "loading a development channel plugin that is not yet on Anthropic's allowlist, via --dangerously-load-development-channels, and running with --dangerously-skip-permissions so an unattended Suite runtime does not stop on a tool-call prompt nobody is there to answer.";

const YELLOW = "[33m";
const RESET = "[0m";

/** The notice as printed. Trailing blank line included; no box characters. */
export function noticeLines(color: boolean): string[] {
  const bang = color ? `${YELLOW}!${RESET}` : "!";
  return [`${bang} ${NOTICE_BODY}`, ""];
}

export interface ClaudeState {
  /** True once the first-run notice has been shown on this machine. */
  noticeSeen: boolean;
}

const STATE_KEY = "claudeNoticeSeen";

export function parseState(text: string): ClaudeState {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return { noticeSeen: raw[STATE_KEY] === true };
  } catch {
    // A corrupt state file means "not seen": showing the notice once more is
    // harmless, while crashing the launcher over a scratch file is not.
    return { noticeSeen: false };
  }
}

export function serializeState(state: ClaudeState): string {
  return `${JSON.stringify({ [STATE_KEY]: state.noticeSeen }, null, 2)}\n`;
}

/**
 * The seen-flag lives in the user config dir (`state.json`), NOT in the repo:
 * it is a property of this machine, it is not repeatable-install input, and a
 * file written into a checkout is a file that gets committed.
 */
export async function readState(path: string): Promise<ClaudeState> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { noticeSeen: false };
  return parseState(await file.text());
}

export async function writeState(path: string, state: ClaudeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, serializeState(state));
}

/* ------------------------------------------------------------------------- */
/* 3. The plan                                                                */
/* ------------------------------------------------------------------------- */

/**
 * What a STALE session gets, and why it is not an attach.
 *
 * DECISION: stale sessions are RECYCLED — killed by name and recreated — and
 * the recycle is announced. Attaching to the corpse would present a dead agent
 * as a healthy one (the user sees a shell prompt, Suite sees nothing). Leaving
 * it alone and creating a second session under a derived name would break the
 * one property the naming rule exists to give: one context, one session.
 * `tmux kill-session -t <name>` is scoped to that single name — never
 * `kill-server`, which would take down every other agent on the box.
 */
export function staleNotice(session: string): string {
  return [
    `stale session ${session}: the shell is alive but Claude is not.`,
    `  recycling it — the old session is killed and a fresh agent starts.`,
  ].join("\n");
}

export function attachedNotice(session: string): string {
  return `attaching to ${session} — detach with your prefix key then d; the agent keeps running.`;
}

export function createdNotice(session: string): string {
  return `started ${session} — it survives this terminal; suite claude re-attaches.`;
}

/**
 * A name not already taken. Used ONLY by the explicit `suite claude new`.
 *
 * The derived name is deliberately stable everywhere else; forcing a second
 * agent in one context is the one case where a different name is the request,
 * so the suffix is applied here and nowhere else.
 */
export function uniqueSessionName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  throw new Error(`cannot find a free session name based on ${base}`);
}

export interface DecideInput {
  session: string;
  userArgs: string[];
  cwd: string;
  state: SessionState;
  /** `suite claude new`: create regardless of what exists. */
  force: boolean;
  env: Record<string, string | undefined>;
  store: CredentialStore;
}

export interface ClaudePlan {
  /** Lines printed on stdout before anything runs. Never empty for STALE. */
  notes: string[];
  /** Printed only once the created session is confirmed alive. */
  created?: string;
  /** `tmux kill-session` argv, when a stale session is recycled. */
  kill?: string[];
  /** `tmux new-session -d` argv, when a session must be created. */
  create?: string[];
  /**
   * `tmux set-option` argvs applied to a freshly created session.
   *
   * Only ever set alongside {@link ClaudePlan.create}: an existing session the
   * user has been working in keeps whatever options it has, so reattaching
   * never silently re-configures a session under them.
   */
  configure?: string[][];
  /** How to reach the session once it exists. */
  enter?: NestingPlan;
  /** Direct exec: `-p`, or tmux absent. No session, no attach. */
  direct?: string[];
  /** Warning emitted when persistence is lost (tmux absent). */
  warning?: string;
}

/**
 * Decide everything before doing anything.
 *
 * Sync and side-effect free apart from `deps.which`, so every branch — live,
 * stale, none, forced, nested, tmux-absent — is asserted directly instead of
 * through a test that launches an agent.
 */
export function decide(input: DecideInput, deps: TmuxDeps): ClaudePlan {
  if (isNonInteractive(input.userArgs)) {
    return { notes: [], direct: agentArgv(input.userArgs) };
  }
  // Interactive: tmux or not, the pane (or the direct exec) carries the
  // no-conversation fallback. See continueFallbackArgv.
  const command = paneCommand(input.userArgs);

  const notes: string[] = [];
  const wantsExisting = !input.force && input.state === "live";

  if (wantsExisting) {
    notes.push(attachedNotice(input.session));
    return { notes, enter: nestingPlan(input.session, input.env) };
  }

  const kill = !input.force && input.state === "stale" ? killSessionArgv(input.session) : undefined;
  if (kill !== undefined) notes.push(staleNotice(input.session));

  const warnings: string[] = [];
  const launch = planLaunch(
    { session: input.session, command, cwd: input.cwd, warn: (line) => warnings.push(line), store: input.store },
    deps,
  );

  if (launch.kind === "direct") {
    return { notes, kill, direct: launch.argv, warning: launch.warning };
  }

  // NOT pushed into `notes`. Notes are printed before the plan is executed, so
  // announcing the start there says "started" before anything has been tried —
  // which is how a real host got "started suite-… — it survives this terminal"
  // one line above tmux reporting no such session. This one is held back until
  // the session is confirmed to exist.
  return {
    notes,
    kill,
    created: createdNotice(input.session),
    create: launch.argv,
    configure: sessionOptionsArgv(input.session),
    enter: nestingPlan(input.session, input.env),
  };
}

/* ------------------------------------------------------------------------- */
/* 4. Execution                                                               */
/* ------------------------------------------------------------------------- */

/** Exit code for a refusal to nest tmux inside itself. Non-zero, always. */
export const NESTED_REFUSAL_EXIT = 3;

export interface ClaudeDeps {
  tmux: TmuxDeps;
  env: Record<string, string | undefined>;
  cwd: string;
  /**
   * How launches are recorded for restore-on-boot. Optional by construction:
   * a caller that supplies nothing records nothing, which is what keeps the
   * test suite from writing a real roster into a developer's home directory.
   */
  restore?: RestoreDeps;
  /**
   * How supervision reaches the filesystem and service manager. Optional for
   * the same reason `restore` is: a caller that supplies nothing installs
   * nothing, which is what keeps the test suite from writing real units.
   */
  supervisorIo?: SupervisorIo;
  store: CredentialStore;
  config: SuiteConfig;
  statePath: string;
  color: boolean;
  /** `process.platform`, so {@link claudeInstallPlan} is decided not sniffed. */
  platform: string;
  /**
   * Used by the install offer, and — on a machine with no saved Suite
   * connection — by the same URL / runtime id / token prompts `suite init`
   * asks. Claude Code's own login is never prompted here.
   */
  prompter: Prompter;
  /**
   * How Claude Code's Suite wiring runs its children (git, bun, `claude mcp`).
   *
   * Optional for the same reason `restore` is: a caller that supplies nothing
   * wires nothing, which keeps the launch tests from cloning, prompting or
   * touching `~/.claude.json`. The live deps always supply it.
   */
  wiring?: WiringIo;
  /**
   * How a freshly created session's pre-launch dialogs are answered (see
   * `src/claude_dialogs.ts`). Optional for the same reason `restore` is: a
   * caller that supplies nothing answers nothing, so the launch tests never
   * poll a pane. The live deps always supply it.
   */
  dialogs?: DialogIo;
  /**
   * Seeds Claude Code's `hasCompletedOnboarding` before an UNATTENDED launch
   * (`SUITE_UNATTENDED=1`, see claude_onboarding.ts). Optional for the same
   * reason `dialogs` is: a caller that supplies nothing seeds nothing, so the
   * launch tests never write a ~/.claude.json.
   */
  seedOnboarding?(claudeJson: string): SeedOutcome;
  /**
   * Writes the session's launch record (claude_launch.ts), which pane-status
   * reads. Optional: a caller that supplies nothing records nothing.
   */
  writeLaunch?(path: string, record: LaunchRecord): void;
  /**
   * Injected so the settle wait is instant in tests and real on a machine.
   * Optional: a caller that supplies nothing gets the real one.
   */
  sleep?(ms: number): Promise<void>;
  out(line: string): void;
  err(line: string): void;
  /**
   * Run a child with the PARENT'S stdio — the attach and the direct exec both
   * need the real TTY, or Claude renders into a pipe and reads no keys. Returns
   * the child's exit code, which is the wrapper's exit code.
   */
  exec(argv: string[]): Promise<number>;
}

/** Session names currently on the tmux server. Empty when tmux is absent. */
export async function listSessionNames(deps: TmuxDeps): Promise<string[]> {
  if (deps.which(TMUX) === null) return [];
  const r = await deps.run([TMUX, "list-sessions", "-F", "#{session_name}"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export interface ClaudeOptions {
  userArgs: string[];
  force: boolean;
  /** `--session NAME`, honoured by stage 4's naming rule. */
  explicitSession?: string;
}

export async function runClaude(deps: ClaudeDeps, options: ClaudeOptions): Promise<number> {
  const state = await readState(deps.statePath);
  if (!state.noticeSeen) {
    for (const line of noticeLines(deps.color)) deps.out(line);
    await writeState(deps.statePath, { noticeSeen: true });
  }

  // The agent must exist before EITHER path execs it. Placed here, above the
  // -p branch, so the scripted caller and the tmux caller get one gate.
  const missing = await ensureAgent(deps);
  if (missing !== null) return missing;

  // Then this folder's wiring to the install, from the saved connection — or,
  // on a machine that has none, after asking for it right here. Both orders
  // work: `suite init` then `suite claude`, or `suite claude` straight away.
  let config = deps.config;
  if (deps.wiring !== undefined) {
    const wired = await wireClaude(deps, deps.wiring);
    if (typeof wired === "number") return wired;
    config = wired;
  }

  // A non-interactive call touches tmux NOT AT ALL — not even to detect state.
  // Probing a server it will never use is latency a scripted caller pays for
  // nothing, and on a box without tmux it would be a spawn that cannot succeed.
  if (isNonInteractive(options.userArgs)) {
    return deps.exec(agentArgv(options.userArgs));
  }

  const base = sessionNameFromConfig(config, deps.cwd, options.explicitSession);
  const session = options.force ? uniqueSessionName(base, await listSessionNames(deps.tmux)) : base;

  const sessionState = options.force ? "none" : await detectState(session, deps.tmux);

  const plan = decide(
    {
      session,
      userArgs: options.userArgs,
      cwd: deps.cwd,
      state: sessionState,
      force: options.force,
      env: deps.env,
      store: deps.store,
    },
    deps.tmux,
  );

  if (plan.warning !== undefined) deps.err(plan.warning);
  for (const note of plan.notes) deps.out(note);

  if (plan.direct !== undefined) return deps.exec(plan.direct);

  if (plan.kill !== undefined) await deps.tmux.run(plan.kill);
  if (plan.create !== undefined && isUnattended(deps.env) && deps.seedOnboarding !== undefined) {
    // Nobody will see Claude's first-run screens, so mark them done first.
    const claudeJson = claudeJsonPath(deps.env);
    deps.err(seedLogLine(deps.seedOnboarding(claudeJson), claudeJson));
  }
  if (plan.create !== undefined) {
    const created = await deps.tmux.run(plan.create);
    if (created.exitCode !== 0) {
      deps.err(`tmux could not create ${session}: ${created.stderr.trim()}`);
      return created.exitCode;
    }

    // A ZERO FROM `new-session` IS NOT A SESSION. tmux reports success once it
    // has forked and exec'd; if the agent then exits immediately the session is
    // gone a moment later, and everything after this point — the roster entry,
    // the notice, the mouse option — is written about something that no longer
    // exists. Observed on a real host as:
    //
    //     started suite-chabrielle-ecb3ba97 — it survives this terminal
    //     tmux could not apply mouse on: no such session
    //     can't find session: suite-chabrielle-ecb3ba97
    //
    // Three lines, the first of which was a lie. The cause there was a tmux
    // SERVER whose own working directory had been deleted, so every new pane
    // was born unable to getcwd() and Claude refused to start — a condition no
    // exit code from `new-session` will ever report.
    // SETTLE BEFORE ASKING, or the check proves nothing.
    //
    // The first version of this guard ran `has-session` immediately after
    // `new-session` and therefore always passed: tmux has forked, the pane
    // exists, and the agent has not got as far as failing yet. It shipped, and
    // the very next run on the affected host printed "started … survives this
    // terminal" exactly as before — a guard that fires green while the thing it
    // guards against is happening in front of it.
    //
    // So: wait, then ask whether the AGENT is running, not merely whether a
    // pane exists. `detectState` already draws that distinction — a session
    // whose agent has exited reads "stale", and a session started with a
    // command that died instantly reads "stale" or "none". This catches a
    // startup failure; an agent that dies an hour later is the watchdog's job,
    // not this one's.
    await (deps.sleep ?? realSleep)(SETTLE_MS);
    const state = await detectState(session, deps.tmux);

    // A FIRST RUN HAS NOTHING TO CONTINUE — handled in the pane itself, not
    // here. This check used to retry without `--continue` when the session was
    // dead at SETTLE_MS, which any pre-launch dialog defeats (the process is
    // alive while the dialog is up). See continueFallbackArgv. What remains
    // here is the instant-death check, for failures that no retry can fix.
    if (state !== "live") {
      const injectedContinue = suiteArgs(options.userArgs).includes(CONTINUE_ARG);
      deps.err(
        [
          `${session} was created and exited immediately — the agent did not stay up.`,
          `  Nothing was recorded for restore-on-boot, because there is nothing running to restore.`,
          // The last thing the pane ran: without --continue when we injected it,
          // since the fallback already tried that form. Printing the --continue
          // form would send a new agent's operator to "No conversation found".
          `  Run the command by hand in this directory to see what it printed:`,
          `    ${quoteArgv(agentArgv(options.userArgs).filter((a) => !(injectedContinue && a === CONTINUE_ARG)))}`,
          `  If it says the working directory was deleted, the tmux SERVER's own cwd is gone —`,
          `  every new pane inherits it. \`tmux kill-server\` fixes that, and kills every session on this box.`,
        ].join("\n"),
      );
      return SESSION_DIED_EXIT;
    }
    if (plan.created !== undefined) deps.out(plan.created);
    // Record for restore-on-boot. A by-product of launching, never a list the
    // operator maintains — a hand-curated roster is wrong exactly when needed.
    //
    // INJECTED, not imported: a caller that supplies no restore deps records
    // nothing. That is what stops the test suite writing a real roster into the
    // developer's home directory, which is exactly what it did before this.
    if (deps.restore) {
      recordLaunch(deps.restore, deps.env.HOME ?? "", {
        session,
        command: plan.create,
        cwd: deps.cwd,
        kind: "claude",
      });
    }

    // A session started on an unsupervised box is the one that dies quietly
    // overnight, so creating one also guarantees the watchdog exists. Only on
    // CREATE — re-attaching to a live session changes nothing about the host.
    if (deps.supervisorIo) {
      const home = deps.env.HOME ?? "";
      const sup = await ensureSupervision(deps.supervisorIo, {
        // ClaudeDeps types platform as a plain string (it is injected in tests
        // as arbitrary values); supervisorPlan only branches on darwin/linux
        // and treats anything else as unsupported, so narrowing here is safe.
        platform: deps.platform as NodeJS.Platform,
        home,
        binary: `${home}/.local/bin/suite`,
        inheritedPath: deps.env.PATH,
        inheritedLocale: deps.env.LANG ?? deps.env.LC_ALL,
        intervalSeconds: 60,
      });
      deps.err(`watchdog: ${sup.watchdog}`);
      if (sup.restore) deps.err(`restore-on-boot written (not enabled): ${sup.restore}`);
    }
    /*
     * A display option that will not apply is not a reason to refuse the agent
     * the user asked for — but it is not allowed to fail quietly either, or the
     * next person debugging their scroll wheel has nothing to read.
     */
    for (const argv of plan.configure ?? []) {
      const set = await deps.tmux.run(argv);
      if (set.exitCode !== 0) {
        deps.err(`tmux could not apply ${argv.slice(4).join(" ")} to ${session}: ${set.stderr.trim()}`);
      }
    }
  }

  // ANSWER THE PRE-LAUNCH DIALOGS — only for a session this call created, and
  // CONCURRENTLY with the attach, so a person who is watching sees it happen
  // rather than staring at a delay. The attach returning (a detach, a nested
  // switch-client, or no terminal at all) does not cancel it: the dialogs are
  // there whether or not anyone is looking, which is the whole point.
  let answering: Promise<AnswerResult> | null = null;
  let answeringDone = false;
  if (plan.create !== undefined && deps.dialogs !== undefined) {
    const home = deps.env.HOME ?? "";
    const recordPath = launchRecordPath(home, session);
    const startedAt = new Date().toISOString();
    const record = (r: LaunchRecord): void => {
      try {
        deps.writeLaunch?.(recordPath, r);
      } catch (error) {
        deps.err(`suite: could not write ${recordPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    record({ version: 1, session, outcome: "pending", started_at: startedAt });
    answering = answerLaunchDialogs(deps.dialogs, {
      session,
      cwd: deps.cwd,
      home: deps.env.HOME,
      apiKey: deps.env.ANTHROPIC_API_KEY,
    })
      .then((result) => {
        // What the launch saw, for pane-status: a timeout turns a lasting
        // `starting` into `stuck`; the baseline keeps a pre-restart auth error
        // (re-rendered by --continue) from reading as a new one.
        record({
          version: 1,
          session,
          outcome: result.outcome,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          answered: result.answered.map((a) => a.dialog),
          baseline: result.pane === undefined ? null : (authError(result.pane)?.signature ?? null),
        });
        return result;
      })
      .finally(() => {
        answeringDone = true;
      });
  }
  const finish = async (code: number): Promise<number> => {
    if (answering === null) return code;
    if (!answeringDone) deps.err(`suite: still watching ${session} for Claude's launch dialogs…`);
    const result = await answering;
    if (result.answered.length > 0) {
      const list = result.answered.map((a) => `${a.dialog} (${a.keys.join(" ")})`).join(", ");
      deps.err(`suite: answered Claude's launch dialogs in ${session}: ${list} — logged to ${sessionLogPath(deps.env.HOME ?? "", session)}`);
    }
    return code;
  };

  const enter = plan.enter;
  if (enter === undefined) return finish(0);
  if (enter.kind === "refuse") {
    deps.err(enter.message);
    return finish(NESTED_REFUSAL_EXIT);
  }
  return finish(await deps.exec(enter.argv));
}

export interface WiringIo {
  run: Runner;
  /** Whether a spinner may draw (stdout AND stderr are terminals). */
  isTTY: boolean;
  /**
   * Whether there is a person to answer a prompt (stdin is a terminal). Off a
   * terminal a missing connection cannot be asked for, so Claude is launched
   * unwired with a warning — exactly what it did before wiring existed —
   * rather than failing a script, a service or a test harness.
   */
  canPrompt: boolean;
}

/**
 * Connect (if needed) and wire this folder's Claude Code to ITS install.
 *
 * The connection is THIS FOLDER's record (src/agent_connections.ts), never the
 * machine-level one: a machine hosts several agents, each federated as its own
 * runtime, and planning against one machine connection is what rewrote one
 * agent's entries with another's runtime and token.
 *
 *   (a) the folder has a record: plan against it; register what is missing or
 *       stale, from it.
 *   (b) no record, but the folder already has Suite entries (or ~/.claude.json
 *       cannot be read): register NOTHING. Those entries may be the only
 *       correct statement of who this agent is; launch with them as they are.
 *   (c) no record, no entries, a person to ask: prompt inline, save this
 *       folder's record, wire.
 *   (d) no record, no entries, nobody to ask: launch unwired, as before.
 *
 * Returns the connection to launch with, or an exit code to stop with. All
 * output goes to stderr, so a `-p` caller's captured stdout stays Claude's.
 */
export type WireDeps = Pick<ClaudeDeps, "env" | "cwd" | "prompter" | "store" | "err" | "config">;

export async function wireClaude(deps: WireDeps, wiring: WiringIo): Promise<SuiteConfig | number> {
  const io = { env: deps.env, prompter: deps.prompter, store: deps.store, out: deps.err };
  // Every unwired launch names the folder: several agents share a machine, and
  // a warning that says only "this folder" cannot be told apart in a log that
  // restore or a supervisor wrote for all of them.
  const unwired = (why: string): SuiteConfig => {
    deps.err(`suite: ${why}; starting Claude Code without Suite wiring.`);
    deps.err(`suite: run \`suite init\` in ${deps.cwd}, or \`suite claude\` from a terminal there, to connect it.`);
    return deps.config;
  };
  try {
    const found = readAgentConnection(deps.env, deps.cwd).connection;
    let config: SuiteConfig;
    let dir: string;
    if (found !== null) {
      // (a)
      config = agentConfig(deps.env, found.record);
      dir = found.record.dir;
      loadSavedSecrets(deps.env, dir, config, deps.store);
    } else {
      const entries = localEntries(deps.env, deps.cwd);
      if (entries === null || entries[CHANNEL_SERVER] !== undefined || entries[TOOLS_SERVER] !== undefined) {
        // (b)
        deps.err(
          `suite: no saved connection for ${deps.cwd}; its Claude entries were left as they are. Run suite init in ${deps.cwd}`,
        );
        return deps.config;
      }
      // (d)
      if (!wiring.canPrompt) {
        return unwired(`${deps.cwd} is not connected to a Suite install and there is no terminal to ask in`);
      }
      // (c)
      const ensured = await ensureConnection(io, deps.cwd);
      config = ensured.config;
      dir = ensured.dir;
    }
    // The token is needed only to WRITE an entry. Asked for at most once, and
    // only for a folder whose record has none — never on a wired folder.
    const plan = planMcp({ env: deps.env, cwd: deps.cwd, store: deps.store }, config, defaultCheckout(deps.env));
    if (needsRegistration(plan) && plan.want.tokenLiteral === null) {
      if (!wiring.canPrompt) return unwired(`the Claude MCP entries for ${deps.cwd} need writing and no token is saved for it`);
      config = await ensureToken(io, dir, config);
    }
    await ensureClaudeWiring(
      { env: deps.env, run: wiring.run, cwd: deps.cwd, isTTY: wiring.isTTY, store: deps.store, out: deps.err },
      config,
    );
    return config;
  } catch (error) {
    deps.err(`suite: could not set up Claude Code for Suite: ${error instanceof Error ? error.message : String(error)}`);
    return WIRING_FAILED_EXIT;
  }
}

/**
 * `suite restore`'s wiring step for one recorded `claude` agent.
 *
 * WHY RESTORE NEEDS IT. The roster records the tmux `new-session` argv, and
 * the pane in it runs `claude` itself, not `suite claude` — so replaying it
 * would start the agent on whatever its local MCP entries say, without ever
 * comparing them to the folder's saved connection. A folder a 0.7.0 CLI
 * cross-wired would come back up as the wrong runtime on every boot. So before
 * each replay restore runs exactly the check `suite claude` runs, for that
 * entry's folder, with nobody to ask (off a terminal): a recorded folder is
 * put right from ITS record; a folder with no record keeps its entries as they
 * are and is never stamped (I2).
 *
 * Returns null to go ahead, or the exit code `suite claude` would have
 * stopped with.
 */
export function restoreWirer(
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  run?: Runner,
): (entry: Pick<RosterEntry, "session" | "cwd">) => Promise<number | null> {
  return async (entry) => {
    const store = createStore();
    const refuse = async (question: string): Promise<string> => {
      throw new Error(`restore cannot ask: ${question}`);
    };
    const wired = await wireClaude(
      {
        env,
        cwd: entry.cwd,
        prompter: { ask: refuse, askSecret: refuse, say: () => {} },
        store,
        err: (line) => log(`${entry.session}: ${line}`),
        config: agentConfig(env, null),
      },
      {
        run: run ?? ((argv, options) => spawnWithSecrets(argv, store, { ...options, env })),
        isTTY: false,
        canPrompt: false,
      },
    );
    return typeof wired === "number" ? wired : null;
  };
}

/* ------------------------------------------------------------------------- */
/* Live dependencies                                                          */
/* ------------------------------------------------------------------------- */

export async function liveClaudeDeps(
  env: Record<string, string | undefined> = process.env,
  prompter: Prompter = ttyPrompter(),
): Promise<ClaudeDeps> {
  // Session naming: the machine's sessionNaming, this folder's runtime id.
  const config = agentConfigFor(env, process.cwd());
  const store = createStore();
  return {
    wiring: {
      run: (argv, options) => spawnWithSecrets(argv, store, options),
      // Spinners draw on stdout; a `-p` caller capturing it must get none.
      isTTY: Boolean(process.stdout.isTTY && process.stderr.isTTY),
      canPrompt: Boolean(process.stdin.isTTY),
    },
    restore: liveRestoreDeps(),
    supervisorIo: liveSupervisorIo(),
    // File only, no echo: while the attach owns the terminal, a line on stderr
    // would draw across the tmux client. The summary is printed after it.
    dialogs: liveDialogIo(liveTmuxDeps(env), env.HOME ?? "", () => {}),
    seedOnboarding: (claudeJson) => seedOnboarding(claudeJson),
    writeLaunch: writeLaunchRecord,
    tmux: liveTmuxDeps(env),
    platform: process.platform,
    prompter,
    env,
    cwd: process.cwd(),
    store,
    config,
    statePath: statePath(env),
    color: colorEnabled(env),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async exec(argv) {
      const proc = Bun.spawn(argv, {
        env: env as Record<string, string>,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return proc.exited;
    },
  };
}
