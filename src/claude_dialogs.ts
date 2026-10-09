/**
 * Answering Claude Code's pre-launch dialogs, so an agent comes back after a
 * restart or a reboot without anybody ssh-ing in to press Enter.
 *
 * `suite claude` launches with `--dangerously-load-development-channels`, and
 * Claude Code then shows a full-screen warning on EVERY launch. In a folder it
 * has not seen it first asks whether the folder is trusted, and on a machine
 * that has not accepted bypass-permissions mode it asks about that too. Until
 * someone answers, the process is alive and doing nothing: Suite sees an agent
 * that never replies.
 *
 * THREE RULES CARRY THIS MODULE.
 *
 *  1. ONLY A SCREEN WE KNOW, WORD FOR WORD. A dialog is recognised by its whole
 *     text, not by a keyword: the block between the last horizontal rule and
 *     the "Enter to confirm · Esc to cancel" footer, whitespace-collapsed (the
 *     pane re-wraps it to its width), must equal a template below exactly,
 *     with a placeholder only where the text names this launch (the folder,
 *     the channel, the MCP server) — and those placeholders are checked too.
 *     The footer must be the LAST line on the screen, so an agent that merely
 *     prints a dialog's text in its transcript is not a dialog. Anything else —
 *     a new dialog, a reworded one, half a redraw — gets no keys at all, and an
 *     unrecognised dialog is logged once so the operator can see why the agent
 *     is waiting.
 *  2. THE KEY DEPENDS ON WHERE THE CURSOR IS. Two of these dialogs default to
 *     "No, exit", so a blind Enter would quit Claude. Each step reads the
 *     cursor and sends one move or one confirm, then waits for the screen to
 *     change before deciding again. A stale capture never earns a second key.
 *  3. ONE SESSION, BY EXACT NAME. Every tmux call targets `=NAME:` — tmux's
 *     exact-match form. A bare `-t NAME` falls back to a PREFIX match, which
 *     would type into `NAME-2` (another agent) if NAME were gone.
 *
 * The screens were captured from Claude Code 2.1.288 on Linux, and are kept as
 * fixtures under test/fixtures/claude-code-2.1.288-dialogs/. When Claude Code
 * rewords one, it stops being answered (rule 1) and the fixture test says
 * which.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { TMUX, type TmuxDeps } from "./tmux.ts";
import { resolveTmux } from "./halt.ts";

/** The last line of every dialog this module answers. */
export const DIALOG_FOOTER = "Enter to confirm · Esc to cancel";

/** The channel `suite claude` loads. The dev-channels warning must name only it. */
export const SUITE_CHANNEL = "server:suite-channel";

/** What the cursor glyph looks like in Claude Code's select lists. */
const CURSOR = "❯";

export type DialogName = "trust-folder" | "dev-channels" | "bypass-permissions" | "mcp-server" | "theme";

export interface DialogContext {
  /** The folder the agent was launched in. The trust dialog must name it. */
  cwd?: string;
  /** `$HOME`, so a `~/…` rendering of the folder also matches. */
  home?: string;
}

interface DialogSpec {
  name: DialogName;
  /** The whole block, whitespace-collapsed, with `{x}` placeholders. */
  template: string;
  /** Every option label, in screen order. The cursor must sit on one of them. */
  options: string[];
  /** Placeholder values that must hold, or the dialog is not ours to answer. */
  check(fields: Record<string, string>, ctx: DialogContext): boolean;
  /** Keys for this cursor position, or null to send nothing. */
  keys(cursor: string): string[] | null;
}

const squash = (s: string): string => s.replace(/\s+/g, "");

/**
 * The folder in the trust dialog is the folder we launched in, or we do not
 * vouch for it. Compared with all whitespace removed, because a long path is
 * hard-wrapped across lines.
 */
function folderMatches(shown: string, ctx: DialogContext): boolean {
  if (ctx.cwd === undefined) return false;
  const want = [squash(ctx.cwd)];
  if (ctx.home && (ctx.cwd === ctx.home || ctx.cwd.startsWith(`${ctx.home}/`))) {
    want.push(squash(`~${ctx.cwd.slice(ctx.home.length)}`));
  }
  return want.includes(squash(shown));
}

/**
 * The known dialogs, exactly as Claude Code 2.1.288 draws them.
 *
 * Keys, and why each is the safe continue:
 *
 *  - trust-folder: the cursor starts on "No, exit". Down moves it to
 *    "Yes, I trust this folder"; Enter confirms only once it is there. The
 *    folder must be the one we launched in.
 *  - dev-channels: "1" selects "I am using this for local development"
 *    wherever the cursor is (verified: pressing 1 with the cursor on "2. Exit"
 *    continues). The channel list must be exactly suite's own channel — a
 *    second development channel is a decision for a human.
 *  - bypass-permissions: as trust-folder. `suite claude` already chose
 *    `--dangerously-skip-permissions` and says so once per machine; this
 *    accepts the consequence of that choice, it does not make it.
 *  - mcp-server: "Continue without using this MCP server", the default, and
 *    only when the cursor is on it. Approving an unknown project MCP server is
 *    a grant, so it is never sent; continuing without it grants nothing.
 *    (suite registers its own MCP entries in local scope, which does not raise
 *    this dialog, and with `--dangerously-skip-permissions` 2.1.288 did not
 *    show it at all — it is here so a project `.mcp.json` cannot park an
 *    agent.)
 */
export const DIALOGS: readonly DialogSpec[] = [
  {
    name: "trust-folder",
    template:
      "Accessing workspace: {folder} Quick safety check: Is this a project you created or one you trust? " +
      "(Like your own code, a well-known open source project, or work from your team). If not, take a moment " +
      "to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here. " +
      `Security guide No, exit Yes, I trust this folder ${DIALOG_FOOTER}`,
    options: ["No, exit", "Yes, I trust this folder"],
    check: (f, ctx) => folderMatches(f.folder ?? "", ctx),
    keys: (cursor) => (cursor === "No, exit" ? ["Down"] : ["Enter"]),
  },
  {
    name: "dev-channels",
    template:
      "WARNING: Loading development channels --dangerously-load-development-channels is for local channel " +
      "development only. Do not use this option to run channels you have downloaded off the internet. " +
      "Please use --channels to run a list of approved channels. Channels: {channels} " +
      `1. I am using this for local development 2. Exit ${DIALOG_FOOTER}`,
    options: ["1. I am using this for local development", "2. Exit"],
    check: (f) => f.channels === SUITE_CHANNEL,
    keys: () => ["1"],
  },
  {
    name: "bypass-permissions",
    template:
      "WARNING: Claude Code running in Bypass Permissions mode In Bypass Permissions mode, Claude Code will " +
      "not ask for your approval before running potentially dangerous commands. This mode should only be used " +
      "in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged. " +
      "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode. " +
      `https://code.claude.com/docs/en/security No, exit Yes, I accept ${DIALOG_FOOTER}`,
    options: ["No, exit", "Yes, I accept"],
    check: () => true,
    keys: (cursor) => (cursor === "No, exit" ? ["Down"] : ["Enter"]),
  },
  {
    name: "mcp-server",
    template:
      "New MCP server found in this project: {server} MCP servers may execute code or access system resources. " +
      "All tool calls require approval. Learn more in the MCP documentation. Use this MCP server " +
      `Use this and all future MCP servers in this project Continue without using this MCP server ${DIALOG_FOOTER}`,
    options: ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"],
    check: (f) => /^\S+$/.test(f.server ?? ""),
    keys: (cursor) => (cursor === "Continue without using this MCP server" ? ["Enter"] : null),
  },
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Template → anchored regex with one named lazy group per `{placeholder}`. */
function templateRegex(template: string): RegExp {
  const parts = template.split(/(\{[a-z]+\})/);
  const body = parts
    .map((p) => {
      const m = /^\{([a-z]+)\}$/.exec(p);
      return m ? `(?<${m[1]}>.+?)` : escapeRe(p);
    })
    .join("");
  return new RegExp(`^${body}$`);
}

const COMPILED = DIALOGS.map((d) => ({ spec: d, re: templateRegex(d.template) }));

const RULE = /^─{10,}$/;

export type DialogStep =
  | { kind: "answer"; dialog: DialogName; keys: string[] }
  /** A known dialog in a state we will not act on (cursor elsewhere, or a placeholder that did not check out). */
  | { kind: "hold"; dialog: DialogName; reason: string }
  /** Something with the dialog footer that is not one of ours. */
  | { kind: "unknown"; title: string }
  /** Claude's input box is up: there is nothing left to answer. */
  | { kind: "ready" }
  /** No dialog, no input box — still drawing, or something else entirely. */
  | { kind: "none" };

/**
 * The input box: a line starting with the cursor at column 0, between two
 * horizontal rules. Dialogs indent their cursor, so none of them looks like
 * this. If a future Claude Code draws it differently, the only cost is that
 * the poll runs to its deadline instead of stopping early.
 */
export function isReady(lines: string[]): boolean {
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i]!.startsWith(`${CURSOR}`) && RULE.test(lines[i - 1]!.trim()) && RULE.test(lines[i + 1]!.trim())) {
      return true;
    }
  }
  return false;
}

/**
 * (captured pane) → what to do about it. Pure: every decision this module
 * makes is asserted against the recorded screens without a terminal.
 */
export function classifyPane(pane: string, ctx: DialogContext = {}): DialogStep {
  const lines = pane.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { kind: "none" };

  const theme = classifyThemePicker(lines);
  if (theme !== null) return theme;

  const last = lines[lines.length - 1]!.trim();
  if (last !== DIALOG_FOOTER) return isReady(lines) ? { kind: "ready" } : { kind: "none" };

  let top = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (RULE.test(lines[i]!.trim())) {
      top = i;
      break;
    }
  }
  const block = lines.slice(top + 1).filter((l) => l.trim() !== "");
  const title = (block[0] ?? "").trim();
  if (top === -1) return { kind: "unknown", title };

  const cursorLines = block.filter((l) => l.trim().startsWith(`${CURSOR} `));
  const cursor = cursorLines.length === 1 ? cursorLines[0]!.trim().slice(CURSOR.length).trim() : null;
  const text = block
    .map((l) => l.replace(CURSOR, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  for (const { spec, re } of COMPILED) {
    const m = re.exec(text);
    if (m === null) continue;
    if (cursor === null || !spec.options.includes(cursor)) {
      return { kind: "hold", dialog: spec.name, reason: "no cursor on a known option" };
    }
    if (!spec.check({ ...m.groups }, ctx)) {
      return { kind: "hold", dialog: spec.name, reason: "names something other than this launch" };
    }
    const keys = spec.keys(cursor);
    if (keys === null) return { kind: "hold", dialog: spec.name, reason: `cursor is on "${cursor}"` };
    return { kind: "answer", dialog: spec.name, keys };
  }
  return { kind: "unknown", title };
}

/* ------------------------------------------------------------------------- */
/* The first-run theme picker                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The text-style picker Claude Code shows on the very FIRST launch under a
 * home it has not seen, before the login screens. It has no
 * "Enter to confirm" footer, so the dialog table above cannot see it, and an
 * agent nobody can type into (a native agent run by Suite's agent host) would
 * sit on it forever.
 *
 * Choosing a colour scheme grants nothing and consents to nothing, so it is
 * answered: Enter, which keeps whichever entry is highlighted (the default).
 * Recognised by the same rule as every dialog here — the heading, the hint
 * line and the seven options word for word, in order, with exactly one cursor
 * on one of them. Anything else is not answered.
 *
 * Captured from Claude Code 2.1.295 at 80 and 120 columns; fixtures under
 * test/fixtures/claude-code-2.1.295-login/.
 */
export const THEME_HEADING = "Choose the text style that looks best with your terminal";
export const THEME_HINT = "To change this later, run /theme";
export const THEME_OPTIONS = [
  "Auto (match terminal)",
  "Dark mode",
  "Light mode",
  "Dark mode (colorblind-friendly)",
  "Light mode (colorblind-friendly)",
  "Dark mode (ANSI colors only)",
  "Light mode (ANSI colors only)",
] as const;

/** The check mark Claude Code puts before the currently applied theme. */
const APPLIED = "✔";

function classifyThemePicker(lines: string[]): DialogStep | null {
  const start = lines.findIndex((l) => l.trim() === THEME_HEADING);
  if (start === -1) return null;
  const rest = lines.slice(start + 1).filter((l) => l.trim() !== "");
  if (rest[0]?.trim() !== THEME_HINT) return null;
  const optionLines = rest.slice(1, 1 + THEME_OPTIONS.length);
  if (optionLines.length !== THEME_OPTIONS.length) return null;
  let cursors = 0;
  for (let i = 0; i < THEME_OPTIONS.length; i++) {
    let text = optionLines[i]!.trim();
    if (text.startsWith(`${CURSOR} `)) {
      cursors++;
      text = text.slice(CURSOR.length).trim();
    }
    if (text.startsWith(`${APPLIED} `)) text = text.slice(APPLIED.length).trim();
    if (text !== THEME_OPTIONS[i]) return null;
  }
  if (cursors !== 1) return { kind: "hold", dialog: "theme", reason: "no single cursor on a known option" };
  return { kind: "answer", dialog: "theme", keys: ["Enter"] };
}

/* ------------------------------------------------------------------------- */
/* Driving a real pane                                                        */
/* ------------------------------------------------------------------------- */

/**
 * How long to keep looking after a launch. Milliseconds.
 *
 * MEASURED on hive (Linux, load ~1.5, Claude Code 2.1.288): from
 * `tmux new-session` to Claude's input box took 2.7 s and 3.1 s for a fresh
 * folder with `--continue` — trust prompt, dev-channels warning, the
 * "No conversation found" exit, the fallback relaunch, and the dev-channels
 * warning a SECOND time. The first dialog was on screen 0.3–0.5 s in.
 *
 * 60 s is ~20× that. The slow case is a boot, when `suite restore` starts
 * every agent at once on a cold cache, each loading its MCP servers. Erring
 * long costs nothing: the poll stops as soon as the input box is up, and it
 * only ever answers exact matches. Erring short is the failure this exists to
 * remove — an agent parked at a dialog until someone ssh-es in.
 */
export const DIALOG_WINDOW_MS = 60_000;

/** Between captures. Each one is a `tmux capture-pane`; cheap. */
export const DIALOG_POLL_MS = 400;

/**
 * After sending keys, how long to wait for the screen to change before the
 * same screen may be answered again. Measured: a capture 400 ms after a Down
 * could still show the old cursor, and acting on it sent a second Down.
 */
export const DIALOG_RESEND_MS = 3_000;

export interface DialogIo {
  tmux: TmuxDeps;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** One line about this session: written to its session log. */
  log(session: string, line: string): void;
}

export interface AnswerOptions {
  session: string;
  cwd: string;
  home?: string;
  windowMs?: number;
  pollMs?: number;
}

export interface Answer {
  dialog: DialogName;
  keys: string[];
}

export interface AnswerResult {
  outcome: "ready" | "timeout" | "gone";
  answered: Answer[];
}

/** tmux's exact-match target for a session's active pane. See rule 3. */
export function exactTarget(session: string): string {
  return `=${session}:`;
}

export function dialogCaptureArgv(session: string, tmux: string = TMUX): string[] {
  return [tmux, "capture-pane", "-p", "-t", exactTarget(session)];
}

/** Key NAMES, deliberately without `-l`: "Down" and "Enter" are keys, not words. */
export function dialogKeysArgv(session: string, keys: string[], tmux: string = TMUX): string[] {
  return [tmux, "send-keys", "-t", exactTarget(session), ...keys];
}

/**
 * Watch one freshly launched session and answer the dialogs we know, until
 * Claude's input box is up, the session is gone, or the window closes.
 *
 * Never throws for a tmux failure: a capture that fails means the session is
 * gone, which is an outcome, not an error.
 */
export async function answerLaunchDialogs(io: DialogIo, opts: AnswerOptions): Promise<AnswerResult> {
  const tmux = resolveTmux(io.tmux.which);
  const windowMs = opts.windowMs ?? DIALOG_WINDOW_MS;
  const pollMs = opts.pollMs ?? DIALOG_POLL_MS;
  const ctx: DialogContext = { cwd: opts.cwd, home: opts.home };
  const deadline = io.now() + windowMs;
  const answered: Answer[] = [];
  let lastSent: { pane: string; at: number } | null = null;
  const reported = new Set<string>();

  for (;;) {
    const cap = await io.tmux.run(dialogCaptureArgv(opts.session, tmux));
    if (cap.exitCode !== 0) {
      io.log(opts.session, `launch dialogs: session ended (${answered.length} answered)`);
      return { outcome: "gone", answered };
    }
    // Any change since our last send means the send landed (or something else
    // happened); either way the next identical screen is a NEW screen. This is
    // what lets the dev-channels warning be answered a second time after the
    // --continue fallback relaunches Claude.
    if (lastSent !== null && cap.stdout !== lastSent.pane) lastSent = null;
    const step = classifyPane(cap.stdout, ctx);
    if (step.kind === "ready") return { outcome: "ready", answered };

    if (step.kind === "answer") {
      const fresh = lastSent === null || io.now() - lastSent.at >= DIALOG_RESEND_MS;
      if (fresh) {
        await io.tmux.run(dialogKeysArgv(opts.session, step.keys, tmux));
        answered.push({ dialog: step.dialog, keys: step.keys });
        io.log(opts.session, `launch dialogs: answered ${step.dialog} with ${step.keys.join(" ")}`);
        lastSent = { pane: cap.stdout, at: io.now() };
      }
    } else if (step.kind === "unknown" || step.kind === "hold") {
      const what = step.kind === "unknown" ? `unrecognised dialog "${step.title}"` : `${step.dialog}: ${step.reason}`;
      if (!reported.has(what)) {
        reported.add(what);
        io.log(opts.session, `launch dialogs: NOT answering ${what}`);
      }
    }

    if (io.now() >= deadline) {
      io.log(
        opts.session,
        `launch dialogs: gave up after ${Math.round(windowMs / 1000)}s without seeing Claude's input box ` +
          `(${answered.length} answered); the pane is left as it is`,
      );
      return { outcome: "timeout", answered };
    }
    await io.sleep(pollMs);
  }
}

/**
 * One look, one answer at most. For the watchdog's sweep, which comes round
 * again a minute later anyway — so it never needs to wait for a redraw.
 */
export async function answerOnce(io: DialogIo, opts: AnswerOptions): Promise<Answer | null> {
  const tmux = resolveTmux(io.tmux.which);
  const cap = await io.tmux.run(dialogCaptureArgv(opts.session, tmux));
  if (cap.exitCode !== 0) return null;
  const step = classifyPane(cap.stdout, { cwd: opts.cwd, home: opts.home });
  if (step.kind !== "answer") return null;
  await io.tmux.run(dialogKeysArgv(opts.session, step.keys, tmux));
  io.log(opts.session, `launch dialogs: answered ${step.dialog} with ${step.keys.join(" ")} (watchdog)`);
  return { dialog: step.dialog, keys: step.keys };
}

/* ------------------------------------------------------------------------- */
/* The session log                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Per-session log, next to the restore roster. Every key this module sends is
 * written here, so "why did my agent trust that folder" has an answer on disk.
 */
export function sessionLogPath(home: string, session: string): string {
  return `${home}/.local/state/suite/sessions/${session}.log`;
}

/**
 * Append a timestamped line to the session log, and mirror it to `echo`
 * (stderr for the CLI). A log that cannot be written must not stop an agent,
 * so a write failure is reported through `echo` and swallowed.
 */
export function sessionLogger(
  home: string,
  echo: (line: string) => void,
  now: () => Date = () => new Date(),
): (session: string, line: string) => void {
  return (session, line) => {
    echo(`${session}: ${line}`);
    const path = sessionLogPath(home, session);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${now().toISOString()} ${line}\n`);
    } catch (error) {
      echo(`${session}: could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** Live wiring for the poll. */
export function liveDialogIo(tmux: TmuxDeps, home: string, echo: (line: string) => void): DialogIo {
  return {
    tmux,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: sessionLogger(home, echo),
  };
}
