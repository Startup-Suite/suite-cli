/**
 * `suite init` — connect this machine to a Suite install. Harness-neutral.
 *
 * An INSTALL is the server: a URL, a runtime id and a token. `suite init`
 * records those (plus bun, tmux and the watchdog, which every harness needs)
 * and nothing else — it never runs `claude`, `dsh`, `hermes` or `openclaw`, so
 * it cannot fail because one of them is missing. See {@link runInit}.
 *
 *     bun               1.2.4                 present
 *     tmux              3.5a                  present
 *     config            ~/.config/suite/config.json
 *
 * Each harness verb then does its OWN wiring from what init saved, lazily and
 * idempotently: `suite claude` clones the channel plugin, writes CLAUDE.md and
 * registers both MCP entries (`src/claude_wiring.ts`). This module still holds
 * the Claude MCP primitives that wiring uses, and their two rules:
 *
 *  1. MCP ENTRIES ARE WRITTEN BY `claude mcp add`, NEVER BY HAND, AT LOCAL
 *     SCOPE. Hand-rolling `.mcp.json` means owning a file format we do not
 *     control and cannot see change. The scope is `-s local` (passed
 *     explicitly): an entry private to THIS agent directory, stored in
 *     `~/.claude.json` under the directory's key, never in the directory
 *     itself. It used to be `-s user`, which is ONE entry for every Claude on
 *     the machine, so installing a second agent re-pointed the first one at the
 *     second one's Suite and runtime. See {@link registerServers}.
 *  2. WRITTEN IS NOT CONNECTED. After writing, the wiring health-checks. An
 *     entry that was written perfectly and cannot connect is the exact failure
 *     this tool exists to stop someone debugging by hand, so a green result
 *     requires seeing the word from `claude mcp list`, and a line we cannot
 *     parse is a FAILURE that prints the raw line — never a false green.
 */
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  createStore,
  spawnWithSecrets,
  type CredentialStore,
  type Prompter,
  type SpawnResult,
} from "../secrets.ts";
import { dataDir } from "../paths.ts";
import { promptConnection } from "../connection.ts";
import { nextCommand, row } from "../ui.ts";
import {
  type SupervisorIo,
  type SupervisorResult,
  installSupervisor,
  restoreUnitPlan,
  supervisorPlan,
  writeRestoreUnit,
} from "../supervisor.ts";

/* ------------------------------------------------------------------------- */
/* Empirical finding — ${ENV_VAR} interpolation                               */
/* ------------------------------------------------------------------------- */

/**
 * VERIFIED against Claude Code 2.1.228 on macOS, with a stub stdio server that
 * recorded its own environment:
 *
 *   - `claude mcp add x -e K='${V}'` stores the LITERAL `${V}` in the config.
 *   - When `V` IS set in the environment that launches `claude`, the spawned
 *     server receives the EXPANDED value. So interpolation is real, and it
 *     happens at spawn time, not at write time.
 *   - When `V` is NOT set, the server receives the LITERAL string `${V}` — not
 *     an empty value, and not an error.
 *
 * That last case decides the default. An env reference that silently delivers
 * the four characters `${V}` as your bearer token produces a channel that
 * authenticates with garbage and reports no cause — the same class of silent
 * failure this CLI exists to prevent. So the DEFAULT is an inline value at local
 * scope (`~/.claude.json`, mode-protected, outside any repo), and an env
 * reference is available for operators who want their secret in a secret
 * manager instead: {@link InitOptions.tokenFromEnv}. Documented, not implicit.
 */
export const ENV_INTERPOLATION_SUPPORTED = true;

/** Renders the reference form for a variable name, e.g. `SUITE_TOKEN` → `${SUITE_TOKEN}`. */
export function envReference(variable: string): string {
  return `\${${variable}}`;
}

/* ------------------------------------------------------------------------- */
/* Dependencies, all injectable so init is testable off this box              */
/* ------------------------------------------------------------------------- */

export type Runner = (
  argv: string[],
  options?: { cwd?: string; allowSecretsInArgv?: boolean; env?: Record<string, string | undefined> },
) => Promise<SpawnResult>;

export interface InitDeps {
  env: Record<string, string | undefined>;
  prompter: Prompter;
  store: CredentialStore;
  run: Runner;
  platform: NodeJS.Platform;
  isTTY: boolean;
  /** Where a starting CLAUDE.md is written. The agent's working directory. */
  cwd: string;
  /**
   * How the session watchdog reaches the filesystem and the service manager.
   *
   * Injected rather than imported so `init` has no unmockable side effect: a
   * caller that supplies nothing installs nothing. That is what keeps the test
   * suite from writing real unit files and shelling out to systemctl, and it is
   * why this is optional rather than defaulted to the live implementation.
   */
  supervisorIo?: SupervisorIo;
  out(line: string): void;
}

export interface InitOptions {
  /**
   * Accepted and IGNORED: the Claude channel plugin checkout is now part of
   * `suite claude`'s wiring, at the default location. Said out loud when given,
   * rather than silently dropped.
   */
  checkout?: string;
  /**
   * Record that the harness wiring should write `SUITE_TOKEN=${VAR}` instead of
   * the value, and keep the token off disk. Opt-in: see
   * {@link ENV_INTERPOLATION_SUPPORTED} for why this is not the default.
   */
  tokenFromEnv?: string;
  /**
   * Skip installing the session watchdog.
   *
   * Installing is the DEFAULT and that is the whole point: a watchdog an
   * operator has to find out about is one that is not running on the morning it
   * was needed. This flag exists for boxes where clearing a session
   * automatically is not wanted, not as a way to defer the decision.
   */
  noSupervisor?: boolean;
}

export const PLUGIN_REPO = "https://github.com/Startup-Suite/claude-code-suite-channel.git";
export const PLUGIN_DIRNAME = "claude-code-suite-channel";
export const CHANNEL_SERVER = "suite-channel";
export const TOOLS_SERVER = "startup-suite";

/**
 * The scope both MCP entries are registered at. `local`, NOT `user`.
 *
 * MEASURED against Claude Code 2.1.281 on a throwaway HOME (2026-09-26):
 *   - `claude mcp add NAME -s local` writes `~/.claude.json` (mode 600) under
 *     `projects[<dir>].mcpServers`, where <dir> is the working directory, or
 *     the enclosing git work tree's root when there is one. Nothing is written
 *     into the directory itself.
 *   - In that directory the local entry WINS over a user-scope entry of the
 *     same name; a sibling directory still sees the user-scope one.
 *   - It needs no approval, unlike a project-scope `.mcp.json`.
 *
 * WHY NOT `user`: user scope is one entry per machine. Installing a second
 * agent replaced the first agent's entries with the second one's Suite and
 * runtime, so the first agent's next restart would have federated as the
 * wrong runtime into the wrong install (found on a real host, 2026-09-26).
 *
 * WHY NOT `project` (`<dir>/.mcp.json`): that file carries the token INSIDE the
 * agent directory, where a repository can commit it — the one write this CLI
 * refuses everywhere else (see `src/paths.ts`) — and each server then needs
 * approving before it loads.
 *
 * Every `claude mcp` call that reads or writes these entries runs with the
 * agent directory as its cwd, because that is what `local` is keyed by.
 */
export const MCP_SCOPE = "local";

export function defaultCheckout(env: Record<string, string | undefined>): string {
  return resolve(dataDir(env), PLUGIN_DIRNAME);
}

/* ------------------------------------------------------------------------- */
/* PATH detection                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Resolve a binary against PATH ourselves rather than asking a shell.
 *
 * `which` is not guaranteed present, `command -v` needs a shell, and both make
 * the scrubbed-PATH test depend on the host. A direct scan is what the test
 * needs to be honest: strip a stub out of the fixture PATH and this returns
 * null for the same reason it would on a machine that never had the tool.
 */
export function whichBin(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = resolve(dir, name);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

export interface ToolState {
  present: boolean;
  version: string;
  path: string | null;
}

async function probeVersion(deps: InitDeps, name: string, args: string[]): Promise<ToolState> {
  const path = whichBin(name, deps.env);
  if (path === null) return { present: false, version: "", path: null };
  const r = await deps.run([path, ...args]);
  const first = `${r.stdout}${r.stderr}`.trim().split("\n")[0] ?? "";
  const semver = /\d+\.\d+[\w.-]*/.exec(first);
  return { present: true, version: semver?.[0] ?? first, path };
}

export function detectBun(deps: InitDeps): Promise<ToolState> {
  return probeVersion(deps, "bun", ["--version"]);
}

export function detectTmux(deps: InitDeps): Promise<ToolState> {
  return probeVersion(deps, "tmux", ["-V"]);
}

/* ------------------------------------------------------------------------- */
/* Offering an install — a prompt, never an unasked mutation                  */
/* ------------------------------------------------------------------------- */

export interface InstallPlan {
  /** Human name of the mechanism, for the prompt and the report line. */
  manager: string;
  argv: string[];
}

/**
 * How this platform installs a package. Returns null when we have no idea, in
 * which case we say so rather than guessing at a command that may do something
 * else entirely on an unfamiliar distribution.
 */
export function packageInstall(
  pkg: string,
  deps: Pick<InitDeps, "platform" | "env">,
): InstallPlan | null {
  if (deps.platform === "win32") return null;
  if (deps.platform === "darwin") {
    return whichBin("brew", deps.env) === null ? null : { manager: "brew", argv: ["brew", "install", pkg] };
  }
  if (whichBin("apt-get", deps.env) !== null) {
    return { manager: "apt", argv: ["apt-get", "install", "-y", pkg] };
  }
  if (whichBin("dnf", deps.env) !== null) return { manager: "dnf", argv: ["dnf", "install", "-y", pkg] };
  if (whichBin("apk", deps.env) !== null) return { manager: "apk", argv: ["apk", "add", pkg] };
  return null;
}

/** The canonical bun installer, run through sh only when the user says yes. */
export function bunInstallPlan(deps: Pick<InitDeps, "platform" | "env">): InstallPlan | null {
  const viaPackageManager = packageInstall("bun", deps);
  if (viaPackageManager !== null) return viaPackageManager;
  if (deps.platform === "win32") return null;
  return { manager: "bun.sh", argv: ["sh", "-c", "curl -fsSL https://bun.sh/install | bash"] };
}

/** The manager name {@link bunInstallPlan} uses for the curl|bash fallback. */
export const BUN_SH_MANAGER = "bun.sh";

/**
 * What `curl -fsSL https://bun.sh/install | bash` needs before it can work: it
 * fetches with curl, runs under bash, and unpacks a ZIP release with unzip.
 * The launcher (`bin/suite.template`) checks the same three; this is the same
 * precondition on the other entrypoint, because which one a user reaches
 * should not decide whether they get a clear refusal or a broken half-install.
 */
export const BUN_SH_REQUIRED_TOOLS = ["curl", "bash", "unzip"] as const;

/**
 * Which of the bun.sh installer's prerequisites are missing, as a pure
 * function of the plan and the environment — so the decision can be asserted
 * directly instead of inferred from whether an install happened.
 *
 * A package-manager plan (`apt-get install -y bun`, `brew install bun`, …)
 * returns `[]` UNCONDITIONALLY: it unpacks a distro package and needs none of
 * these tools, so the guard must stay silent there even on a box with no unzip.
 */
export function missingBunInstallTools(
  plan: InstallPlan,
  deps: Pick<InitDeps, "env">,
): string[] {
  if (plan.manager !== BUN_SH_MANAGER) return [];
  return BUN_SH_REQUIRED_TOOLS.filter((tool) => whichBin(tool, deps.env) === null);
}

export async function confirm(prompter: Prompter, question: string): Promise<boolean> {
  const answer = (await prompter.ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/* ------------------------------------------------------------------------- */
/* Spinners — only where the wait is genuinely unbounded                      */
/* ------------------------------------------------------------------------- */

/**
 * A spinner on a 40ms step is decoration pretending to be feedback, and off a
 * TTY it is line noise in a log file. So: only the clone and `bun install` get
 * one, and only when stdout is a terminal. Either way it collapses into the
 * same finished line, so the transcript reads identically.
 */
export function spinner(label: string, deps: Pick<InitDeps, "isTTY">): { stop(): void } {
  if (!deps.isTTY) return { stop() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${label.padEnd(18)}${frames[i++ % frames.length]}`);
  }, 80);
  return {
    stop() {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
    },
  };
}

/* ------------------------------------------------------------------------- */
/* The plugin checkout                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Why a `git pull --ff-only` failed, as far as its own output will say.
 *
 * THE MESSAGE MUST NOT ASSERT A CAUSE IT DID NOT DETERMINE. The first version
 * of this error printed git's stderr and then, unconditionally, "it has local
 * commits or a diverged history". On a real host that line was false: the
 * checkout was clean and exactly level with origin, and the pull had failed
 * because the HTTPS remote had no usable credential. The operator was handed
 * git's own "Authentication failed" and a sentence telling them to go resolve a
 * divergence that did not exist.
 */
export type PullFailureKind = "auth" | "diverged" | "unknown";

export function classifyPullFailure(detail: string): PullFailureKind {
  const d = detail.toLowerCase();
  if (
    d.includes("authentication failed") ||
    d.includes("invalid username or token") ||
    d.includes("could not read username") ||
    d.includes("permission denied (publickey)") ||
    d.includes("terminal prompts disabled")
  ) {
    return "auth";
  }
  if (d.includes("non-fast-forward") || d.includes("diverged") || d.includes("not possible to fast-forward")) {
    return "diverged";
  }
  return "unknown";
}

/** What to tell the operator to do, given what actually went wrong. */
export function pullRemedyLines(kind: PullFailureKind, dir: string): string[] {
  switch (kind) {
    case "auth":
      return [
        `  git could not authenticate to the remote. The checkout itself is probably fine.`,
        `  Either give git a credential — \`gh auth setup-git\` — or point it at SSH:`,
        `    git -C ${dir} remote set-url origin git@github.com:Startup-Suite/claude-code-suite-channel.git`,
      ];
    case "diverged":
      return [
        `  it has local commits or a diverged history. Resolve it there, or move it aside.`,
        `  init will not force, reset or delete a checkout it did not create.`,
      ];
    default:
      return [
        `  init could not tell why from git's output above, so it is not guessing.`,
        `  init will not force, reset or delete a checkout it did not create.`,
      ];
  }
}

export class PullFailed extends Error {
  readonly exitCode = 4;
  readonly kind: PullFailureKind;
  constructor(dir: string, detail: string) {
    const kind = classifyPullFailure(detail);
    super(
      [
        `the plugin checkout at ${dir} could not be fast-forwarded:`,
        detail.trim(),
        ...pullRemedyLines(kind, dir),
      ].join("\n"),
    );
    this.name = "PullFailed";
    this.kind = kind;
  }
}

export type CheckoutOutcome = "cloned" | "updated";

/**
 * Never let git ask the operator a question here.
 *
 * These git calls run underneath a spinner. When the remote wants credentials
 * git writes "Username for 'https://github.com':" straight to the terminal, the
 * spinner repaints over it, and what the operator sees is a corrupted line —
 * observed for real as `plugin  ⠹anername for 'https://github.com':`. A prompt
 * nobody can read is worse than a refusal: with the prompt disabled git fails
 * immediately and says why, which `classifyPullFailure` can then act on.
 */
export function noGitPrompt(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  // MERGED, not replaced. `spawnWithSecrets` uses `options.env` as the whole
  // environment rather than an overlay, so handing it the one variable would
  // run git with no PATH, no HOME and therefore no credential helper or SSH
  // config — turning "cannot authenticate" into a different, stranger failure.
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Clone the plugin, or fast-forward an existing checkout.
 *
 * `--ff-only` and then STOP on failure. The alternative — a reset or a force —
 * silently destroys whatever the user was doing in that directory, and this
 * command was invoked to set up a tool, not to arbitrate their git state.
 */
export async function cloneOrUpdate(dir: string, deps: Pick<InitDeps, "run" | "env">): Promise<CheckoutOutcome> {
  if (existsSync(resolve(dir, ".git"))) {
    const r = await deps.run(["git", "pull", "--ff-only"], { cwd: dir, env: noGitPrompt(deps.env) });
    if (r.exitCode !== 0) throw new PullFailed(dir, r.stderr || r.stdout);
    return "updated";
  }
  await mkdir(resolve(dir, ".."), { recursive: true });
  const r = await deps.run(["git", "clone", PLUGIN_REPO, dir], { env: noGitPrompt(deps.env) });
  if (r.exitCode !== 0) {
    throw new Error(`git clone failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return "cloned";
}

/** Count of installed packages, when bun says; empty string when it does not. */
export function packageCount(bunInstallOutput: string): string {
  const m = /(\d+)\s+packages?\s+installed/i.exec(bunInstallOutput);
  return m === null ? "" : `${m[1]} packages`;
}

/* ------------------------------------------------------------------------- */
/* MCP entries                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The channel plugin speaks WebSocket to the runtime endpoint, while the tools
 * MCP is plain HTTP at `/mcp`. Both are derived from the one URL the user
 * pasted, so they cannot drift apart by a typo in one of them.
 */
/**
 * Whether the pasted URL is secure, whichever family it was written in.
 *
 * The operator may paste either the browser URL or the runtime WebSocket URL —
 * both name the same Suite — so both derivations have to work from either, and
 * neither may inherit the scheme it was handed.
 *
 * THIS IS WHAT WENT WRONG. `toolsHttpUrl` used to leave the protocol alone.
 * Given the runtime URL (`wss://…/runtime/ws`) it emitted `wss://…/mcp` into
 * the HTTP MCP slot, and the client refused it with
 * `ERR_INVALID_ARG_VALUE: protocol must be http:, https: or s3:` — an error
 * naming neither Suite nor the URL that produced it. Observed on a real setup.
 *
 * The second bug was quieter and in the other function: `channelWsUrl` mapped
 * `http:` to `ws:` and EVERYTHING ELSE to `wss:`, so a deliberate local
 * `ws://localhost:4000` was silently upgraded to `wss://localhost:4000`, which
 * cannot complete a TLS handshake against a plain dev server.
 */
function isSecureScheme(protocol: string): boolean {
  switch (protocol) {
    case "https:":
    case "wss:":
      return true;
    case "http:":
    case "ws:":
      return false;
    default:
      throw new Error(
        `suite: ${protocol}// is not a Suite URL — paste the https:// address you open in a browser, or the wss:// runtime URL.`,
      );
  }
}

export function channelWsUrl(suiteUrl: string): string {
  const u = new URL(suiteUrl);
  u.protocol = isSecureScheme(u.protocol) ? "wss:" : "ws:";
  u.pathname = "/runtime/ws";
  u.search = "";
  return u.toString();
}

export function toolsHttpUrl(suiteUrl: string): string {
  const u = new URL(suiteUrl);
  u.protocol = isSecureScheme(u.protocol) ? "https:" : "http:";
  u.pathname = "/mcp";
  u.search = "";
  return u.toString();
}

export interface ChannelEntry {
  suiteUrl: string;
  runtimeId: string;
  /** Either the token itself, or `${VAR}` when the operator chose a reference. */
  tokenLiteral: string;
  indexPath: string;
}

/**
 * argv for the stdio channel entry. Pure, so a test asserts the flags without
 * spawning anything.
 *
 * The path to `src/index.ts` is ABSOLUTE. A relative one resolves against
 * whatever directory Claude happened to start in, so the channel works from the
 * directory you ran init in and silently fails everywhere else.
 */
export function channelAddArgs(entry: ChannelEntry): string[] {
  if (!entry.indexPath.startsWith("/")) {
    throw new Error(`the plugin entrypoint must be an absolute path, got: ${entry.indexPath}`);
  }
  return [
    "claude",
    "mcp",
    "add",
    CHANNEL_SERVER,
    "-s",
    MCP_SCOPE,
    "-e",
    `SUITE_URL=${channelWsUrl(entry.suiteUrl)}`,
    "-e",
    `SUITE_RUNTIME_ID=${entry.runtimeId}`,
    "-e",
    `SUITE_TOKEN=${entry.tokenLiteral}`,
    "-e",
    "SUITE_ALLOW_PERMISSION_RELAY=0",
    "--",
    "bun",
    entry.indexPath,
  ];
}

/**
 * Did `claude mcp add` refuse because the name is already registered?
 *
 * Matched on the message rather than the exit code, because exit 1 is also how
 * every other failure arrives — a bad flag, an unwritable config — and those
 * must NOT be answered by deleting the operator's entry and trying again.
 */
export function alreadyRegistered(output: string): boolean {
  return /already exists/i.test(output);
}

/** argv for the HTTP tools entry, with one `-H` per solicited header. */
export function toolsAddArgs(
  suiteUrl: string,
  tokenLiteral: string,
  headers: Array<{ name: string; value: string }>,
): string[] {
  const argv = [
    "claude",
    "mcp",
    "add",
    TOOLS_SERVER,
    "-s",
    MCP_SCOPE,
    "-t",
    "http",
    toolsHttpUrl(suiteUrl),
    "-H",
    `Authorization: Bearer ${tokenLiteral}`,
  ];
  for (const h of headers) argv.push("-H", `${h.name}: ${h.value}`);
  return argv;
}

/* ------------------------------------------------------------------------- */
/* Connection verification                                                    */
/* ------------------------------------------------------------------------- */

/**
 * `pending` IS ITS OWN TIER, deliberately, and is NEITHER green nor red.
 *
 * `⏸ Pending approval` in `claude mcp list` is a PROJECT-APPROVAL state, not a
 * connectivity verdict: it says this project has not yet approved a user-scope
 * server, and says NOTHING about whether that server works. Measured on a real
 * box, BOTH Suite servers reported pending while the channel was demonstrably
 * delivering messages.
 *
 * It used to fall into the `not-connected` alternation below, which made
 * `suite doctor` print a failure for a channel that was working. Calling it
 * connected would be the opposite lie. So it is neither: a third state, which
 * the callers render as `⋯ skipped` and which does not set an exit code.
 */
export type ServerState = "connected" | "pending" | "not-connected" | "unparseable" | "missing";

/** What clears a `pending` server. Shared so init and doctor say one thing. */
export const PENDING_APPROVAL_REMEDY = "run claude once in this project to approve";

export interface ServerStatus {
  name: string;
  state: ServerState;
  /** The raw line, so a failure can show exactly what we could not read. */
  raw: string;
}

/**
 * Read one server's health out of `claude mcp list`.
 *
 * Parsed tolerantly — server name, then a status marker — because the exact
 * glyphs and dashes are Claude Code's to change. But tolerance stops at
 * inventing a verdict: a line we recognise as this server's and cannot read is
 * `unparseable`, which the caller renders as a FAILURE printing the raw line.
 * Falling back to "assume connected" would turn every future format change into
 * a green run against a broken setup.
 */
export function parseServerStatus(listOutput: string, name: string): ServerStatus {
  for (const line of listOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${name}:`)) continue;
    const status = trimmed.slice(name.length + 1);
    if (/[✔✓]/.test(status) && /connected/i.test(status)) {
      return { name, state: "connected", raw: trimmed };
    }
    // Matched BEFORE the not-connected alternation, and removed from it: a
    // pending server is an unapproved one, not a broken one. See ServerState.
    if (/⏸/.test(status) || /pending/i.test(status)) {
      return { name, state: "pending", raw: trimmed };
    }
    if (/[✘✗x×]/i.test(status) || /fail|refus|error|timeout|disconnect/i.test(status)) {
      return { name, state: "not-connected", raw: trimmed };
    }
    return { name, state: "unparseable", raw: trimmed };
  }
  return { name, state: "missing", raw: "" };
}

export async function verifyConnections(deps: Pick<InitDeps, "run" | "cwd">): Promise<ServerStatus[]> {
  // In the agent directory: local-scope entries are only listed there.
  const r = await deps.run(["claude", "mcp", "list"], { cwd: deps.cwd });
  const text = `${r.stdout}\n${r.stderr}`;
  return [CHANNEL_SERVER, TOOLS_SERVER].map((n) => parseServerStatus(text, n));
}

export function connectionReport(statuses: ServerStatus[]): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const s of statuses) {
    if (s.state === "connected") {
      lines.push(row(s.name, "connected"));
      continue;
    }
    if (s.state === "pending") {
      // NOT a hard failure: the entry is written and may already be working.
      // `suite init` did its job; what is outstanding is a project approval.
      lines.push(row(s.name, "pending approval", PENDING_APPROVAL_REMEDY));
      continue;
    }
    ok = false;
    if (s.state === "missing") {
      lines.push(row(s.name, "not registered", "claude mcp list did not list it"));
    } else if (s.state === "unparseable") {
      lines.push(row(s.name, "unreadable status"));
      lines.push(row("", "", s.raw));
    } else {
      lines.push(row(s.name, "not connected", s.raw));
    }
  }
  return { ok, lines };
}

/* ------------------------------------------------------------------------- */
/* Registration                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Where Claude Code keeps user- and local-scope MCP entries. Read-only here:
 * this CLI never writes it except through `claude mcp`.
 */
export function claudeJsonPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== "" ? resolve(dir, ".claude.json") : resolve(env.HOME ?? "", ".claude.json");
}

/**
 * The runtime id a USER-scope channel entry names, or null when there is none.
 *
 * Reads exactly one field. The file holds tokens, so nothing else from it is
 * ever returned, logged or compared.
 */
export function userScopeChannelRuntime(text: string): { present: boolean; runtimeId: string | null } {
  try {
    const raw = JSON.parse(text) as { mcpServers?: Record<string, { env?: Record<string, unknown> }> };
    const entry = raw.mcpServers?.[CHANNEL_SERVER];
    if (entry === undefined) return { present: false, runtimeId: null };
    const id = entry.env?.SUITE_RUNTIME_ID;
    return { present: true, runtimeId: typeof id === "string" ? id : null };
  } catch {
    return { present: false, runtimeId: null };
  }
}

/**
 * What to say about a user-scope entry left behind by an older `suite init`.
 *
 * LEFT ALONE, NEVER REMOVED OR MIGRATED. Another agent directory on this
 * machine may have no entry of its own and be running on that one right now;
 * removing it would take that agent off Suite at its next restart, and nothing
 * in the file says which directory it belongs to, so it cannot be moved there.
 * This directory's local entry takes precedence here regardless.
 */
export function userScopeLines(found: { present: boolean; runtimeId: string | null }, runtimeId: string): string[] {
  if (!found.present) return [];
  const named = found.runtimeId === null ? "an unreadable runtime id" : `runtime ${found.runtimeId}`;
  if (found.runtimeId === runtimeId) {
    return [
      row("", "", `a user-scope ${CHANNEL_SERVER} entry (${named}) is also present; left alone`),
      row("", "", "this directory uses its own entry, which takes precedence here"),
    ];
  }
  return [
    row("warning", "", `a user-scope ${CHANNEL_SERVER} entry names ${named}, not ${runtimeId}; left alone`),
    row("", "", "this directory uses its own entry, which takes precedence here. Any other agent"),
    row("", "", "directory WITHOUT its own entry still runs as that runtime: run suite init there."),
  ];
}

/**
 * Register both entries at {@link MCP_SCOPE} in the agent directory.
 *
 * Returns the report lines. Never touches user scope: a clash is resolved by
 * removing THIS directory's local entry and re-adding, never anything wider.
 */
export async function registerServers(
  deps: Pick<InitDeps, "run" | "cwd" | "env">,
  invocations: string[][],
  runtimeId: string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const argv of invocations) {
    // A short-lived, directly spawned process: no shell, so no history, and the
    // command line is gone before anyone can read it out of `ps`. This is the
    // one place stage 2 sanctions a secret in argv, and the constructed command
    // line is NEVER logged — it carries the token.
    let r = await deps.run(argv, { allowSecretsInArgv: true, cwd: deps.cwd });

    // A SECOND `suite init` MUST CONVERGE, NOT FAIL. `claude mcp add` refuses a
    // name that is already registered in that scope, so once init had
    // succeeded it could never be run again — which is precisely when you run
    // it: after fixing a URL, rotating a token, or moving the checkout. The
    // values were just re-collected from the operator, so replacing THIS
    // directory's two entries is the intended outcome. The remove is scoped to
    // local, in this directory: it cannot reach another agent's entry.
    if (r.exitCode !== 0 && alreadyRegistered(r.stderr || r.stdout)) {
      const name = argv[3] as string;
      await deps.run(["claude", "mcp", "remove", name, "-s", MCP_SCOPE], { cwd: deps.cwd });
      r = await deps.run(argv, { allowSecretsInArgv: true, cwd: deps.cwd });
      if (r.exitCode === 0) lines.push(row(name, "replaced", "this directory already had an entry"));
    }

    if (r.exitCode !== 0) {
      // The argv is unlogged because it carries the token; claude's own stderr
      // does not, and it is the only thing that says WHY. Reporting the exit
      // code alone hands the operator a number and no next step — which is what
      // `claude mcp add suite-channel failed with exit 1` did on a real host.
      throw new Error(
        [`claude mcp add ${argv[3]} failed with exit ${r.exitCode}:`, (r.stderr || r.stdout).trim()]
          .filter((l) => l !== "")
          .join("\n"),
      );
    }
  }
  // Only what this call wrote: a caller that found one entry already current
  // passes one invocation, and must not be told both were registered.
  for (const argv of invocations) lines.push(row(argv[3] as string, "registered", `local scope: ${deps.cwd}`));

  let text: string | null = null;
  try {
    text = readFileSync(claudeJsonPath(deps.env), "utf8");
  } catch {
    text = null;
  }
  if (text !== null) lines.push(...userScopeLines(userScopeChannelRuntime(text), runtimeId));
  return lines;
}

/* ------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* ------------------------------------------------------------------------- */

export { FEDERATE_HINT } from "../connection.ts";

export interface InitResult {
  /** Null when the operator declined with --no-supervisor. */
  supervisor?: SupervisorResult | null;
  exitCode: number;
  /** True when tmux is unavailable — sessions will not outlive a terminal. */
  tmuxMissing: boolean;
  configPath: string;
}

/**
 * `suite init`: connect this machine to a Suite install. HARNESS-NEUTRAL.
 *
 * Every step here is one that any harness on this machine needs:
 *
 *     bun          the runtime this CLI itself runs on
 *     tmux         persistence for every harness's session
 *     connection   suite url, runtime id, token — for THIS folder (agents/<key>.json + .credentials.json)
 *     watchdog     session supervision, and the restore-on-boot unit
 *
 * NOTHING CLAUDE-SPECIFIC. The channel plugin clone, `claude mcp add` and
 * CLAUDE.md are Claude Code's wiring and are done by `suite claude`, from what
 * this saves (see `src/claude_wiring.ts`). They used to be steps 3-7 here,
 * which made init die with `ENOENT: claude` on a machine without Claude Code —
 * a fresh Mac, or a DeepSeek-only box. init now never runs a harness binary.
 */
export async function runInit(deps: InitDeps, options: InitOptions = {}): Promise<InitResult> {
  const say = deps.out;
  say("");

  // 1. bun --------------------------------------------------------------
  let bun = await detectBun(deps);
  if (!bun.present) {
    const plan = bunInstallPlan(deps);
    if (plan === null) {
      throw new Error("bun is not installed and this platform has no install path I know of");
    }
    // Refuse BEFORE the prompt, not after a failed download: the bun.sh script
    // curls, then unzips. Without unzip it exits having already written part of
    // its layout, and the user is left guessing. Nothing is mutated here.
    const missingTools = missingBunInstallTools(plan, deps);
    if (missingTools.length > 0) {
      throw new Error(
        `the ${plan.manager} installer needs ${missingTools.join(", ")}, ` +
          `${missingTools.length === 1 ? "which is" : "which are"} not on PATH. ` +
          `install ${missingTools.join(" and ")} with your system package manager, then re-run suite init`,
      );
    }
    if (await confirm(deps.prompter, `bun is not installed. install it with ${plan.manager}?`)) {
      const r = await deps.run(plan.argv);
      if (r.exitCode !== 0) throw new Error(`installing bun failed: ${(r.stderr || r.stdout).trim()}`);
      bun = await detectBun(deps);
    }
    if (!bun.present) {
      throw new Error("bun is required and is still not on PATH");
    }
    say(row("bun", bun.version, "installed"));
  } else {
    say(row("bun", bun.version, "present"));
  }

  // 2. tmux — first class, but never fatal ------------------------------
  let tmux = await detectTmux(deps);
  if (!tmux.present) {
    const plan = packageInstall("tmux", deps);
    if (plan !== null && (await confirm(deps.prompter, `tmux is not installed. install it with ${plan.manager}?`))) {
      await deps.run(plan.argv);
      tmux = await detectTmux(deps);
    }
  }
  if (tmux.present) {
    say(row("tmux", tmux.version, "present"));
  } else {
    say(row("tmux", "not installed"));
    say(row("", "", "agents will stop when you close the terminal; suite claude cannot persist them"));
    say(row("", "", "install tmux and re-run suite init to fix this"));
  }

  if (options.checkout !== undefined) {
    say(row("", "", "--checkout is ignored: suite claude sets up the plugin checkout, under the data dir"));
  }

  // 3. the install connection -------------------------------------------
  // Always asked: re-running init is how a URL is fixed or a token rotated.
  // The saved values are offered as defaults. A harness verb picks the change
  // up on its next launch — `suite claude` rewrites an entry that no longer
  // matches what is saved here.
  // Saved as THIS FOLDER's connection (deps.cwd): init in another folder can
  // never change it. See src/agent_connections.ts.
  const { configPath: configFile, credentialsPath: credentialsFile } = await promptConnection(
    { env: deps.env, prompter: deps.prompter, store: deps.store, out: say },
    deps.cwd,
    options.tokenFromEnv === undefined ? {} : { tokenFromEnv: options.tokenFromEnv },
  );
  say(row("config", configFile));
  say(row("credentials", credentialsFile, "mode 600"));
  if (options.tokenFromEnv !== undefined) {
    say(row("", "", `token read from ${options.tokenFromEnv} at launch and not saved; export it before starting an agent`));
  }

  // 4. the watchdog, installed unless explicitly declined ---------------
  let supervisor: SupervisorResult | null = null;
  if (!options.noSupervisor && deps.supervisorIo) {
    const home = deps.env.HOME ?? "";
    const plan = supervisorPlan({
      platform: deps.platform,
      home,
      // Absolute path: a service inherits a minimal PATH, and a bare name there
      // fails to start with no useful signal.
      binary: `${home}/.local/bin/suite`,
      inheritedPath: deps.env.PATH,
      inheritedLocale: deps.env.LANG ?? deps.env.LC_ALL,
      intervalSeconds: 60,
    });
    supervisor = await installSupervisor(deps.supervisorIo, plan);
    say(
      supervisor.installed
        ? `watchdog: ${supervisor.summary}`
        : `watchdog NOT running: ${supervisor.summary}`,
    );

    // Agent restore-on-boot: written, deliberately NOT enabled. An operator
    // opts in per machine; a host that silently starts agents after a reboot
    // would be a worse surprise than the missing agent this fixes.
    const restore = restoreUnitPlan({
      platform: deps.platform,
      home,
      binary: `${home}/.local/bin/suite`,
      inheritedPath: deps.env.PATH,
      intervalSeconds: 60,
    });
    if (restore) {
      writeRestoreUnit(deps.supervisorIo, restore);
      say(`agent restore-on-boot written (NOT enabled). To turn it on:`);
      say(`  ${restore.enableHint}`);
    }
  }

  say("");
  say("this machine is connected. now start an agent from its folder — each sets up its own harness:");
  say(nextCommand("suite claude"));

  return {
    supervisor,
    exitCode: 0,
    tmuxMissing: !tmux.present,
    configPath: configFile,
  };
}

/** Wire the real terminal, the real PATH and the real spawner. */
export function liveDeps(prompter: Prompter, store: CredentialStore = createStore()): InitDeps {
  return {
    env: process.env,
    prompter,
    store,
    platform: process.platform,
    isTTY: Boolean(process.stdout.isTTY),
    cwd: process.cwd(),
    out: (line) => void process.stdout.write(`${line}\n`),
    run: (argv, options) => spawnWithSecrets(argv, store, options),
    supervisorIo: {
      mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
      writeFile: (path, contents) => void writeFileSync(path, contents),
      run: async (argv) => ({ exitCode: (await spawnWithSecrets(argv, store)).exitCode }),
    },
  };
}
