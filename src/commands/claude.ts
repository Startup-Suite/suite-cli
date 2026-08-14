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
import { readConfig, emptyConfig, type SuiteConfig } from "../config.ts";
import { statePath } from "../paths.ts";
import { createStore, ttyPrompter, type CredentialStore, type Prompter } from "../secrets.ts";
import { confirm, type InstallPlan } from "./init.ts";
import { CLAUDE_CODE_URL } from "./doctor.ts";
import { colorEnabled } from "../ui.ts";
import {
  attachArgv,
  composeNewSession,
  detectState,
  killSessionArgv,
  liveTmuxDeps,
  nestingPlan,
  planLaunch,
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
  return [AGENT, ...DEV_CHANNEL_ARGS, ...stripTerminator(userArgs)];
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
  "loading a development channel plugin that is not yet on Anthropic's allowlist, via --dangerously-load-development-channels.";

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
  /** `tmux kill-session` argv, when a stale session is recycled. */
  kill?: string[];
  /** `tmux new-session -d` argv, when a session must be created. */
  create?: string[];
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
  const command = agentArgv(input.userArgs);

  if (isNonInteractive(input.userArgs)) {
    return { notes: [], direct: command };
  }

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

  notes.push(createdNotice(input.session));
  return { notes, kill, create: launch.argv, enter: nestingPlan(input.session, input.env) };
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
  store: CredentialStore;
  config: SuiteConfig;
  statePath: string;
  color: boolean;
  /** `process.platform`, so {@link claudeInstallPlan} is decided not sniffed. */
  platform: string;
  /** Used ONLY by the install offer. Claude Code's own login is never prompted here. */
  prompter: Prompter;
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

  // A non-interactive call touches tmux NOT AT ALL — not even to detect state.
  // Probing a server it will never use is latency a scripted caller pays for
  // nothing, and on a box without tmux it would be a spawn that cannot succeed.
  if (isNonInteractive(options.userArgs)) {
    return deps.exec(agentArgv(options.userArgs));
  }

  const base = sessionNameFromConfig(deps.config, deps.cwd, options.explicitSession);
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
  if (plan.create !== undefined) {
    const created = await deps.tmux.run(plan.create);
    if (created.exitCode !== 0) {
      deps.err(`tmux could not create ${session}: ${created.stderr.trim()}`);
      return created.exitCode;
    }
  }

  const enter = plan.enter;
  if (enter === undefined) return 0;
  if (enter.kind === "refuse") {
    deps.err(enter.message);
    return NESTED_REFUSAL_EXIT;
  }
  return deps.exec(enter.argv);
}

/* ------------------------------------------------------------------------- */
/* Live dependencies                                                          */
/* ------------------------------------------------------------------------- */

export async function liveClaudeDeps(
  env: Record<string, string | undefined> = process.env,
  prompter: Prompter = ttyPrompter(),
): Promise<ClaudeDeps> {
  const config = (await readConfig({ env })) ?? emptyConfig();
  return {
    tmux: liveTmuxDeps(env),
    platform: process.platform,
    prompter,
    env,
    cwd: process.cwd(),
    store: createStore(),
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
