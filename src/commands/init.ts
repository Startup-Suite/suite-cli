/**
 * `suite init` — the whole manual setup, automated.
 *
 * The plugin README (Startup-Suite/claude-code-suite-channel, v0.3.0) lists
 * about eight manual steps. This verb performs them, in order, and reports each
 * as a COMPLETED line rather than as running commentary:
 *
 *     bun               1.2.4                 installed
 *     tmux              3.5a                  present
 *     plugin            v0.3.0                cloned
 *     dependencies      4 packages            installed
 *
 * Two rules the rest of the file exists to keep:
 *
 *  1. MCP ENTRIES ARE WRITTEN BY `claude mcp add`, NEVER BY HAND. Hand-rolling
 *     `.mcp.json` means owning a file format we do not control and cannot see
 *     change. `claude mcp add` also decides scope, and its scope DEFAULT IS
 *     `local` — `-s user` is passed explicitly on every invocation because user
 *     scope is not what omission gives you.
 *  2. WRITTEN IS NOT CONNECTED. Step 7 health-checks. An entry that was written
 *     perfectly and cannot connect is the exact failure this tool exists to
 *     stop someone debugging by hand, so a green result requires seeing the
 *     word from `claude mcp list`, and a line we cannot parse is a FAILURE that
 *     prints the raw line — never a false green.
 */
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  createStore,
  solicitCredentials,
  spawnWithSecrets,
  TOKEN_KEY,
  type CredentialStore,
  type Prompter,
  type SpawnResult,
} from "../secrets.ts";
import { dataDir } from "../paths.ts";
import { readConfig, writeConfig, type SuiteConfig } from "../config.ts";
import { nextCommand, row } from "../ui.ts";

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
 * failure this CLI exists to prevent. So the DEFAULT is an inline value at user
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
  options?: { cwd?: string; allowSecretsInArgv?: boolean },
) => Promise<SpawnResult>;

export interface InitDeps {
  env: Record<string, string | undefined>;
  prompter: Prompter;
  store: CredentialStore;
  run: Runner;
  platform: NodeJS.Platform;
  isTTY: boolean;
  out(line: string): void;
}

export interface InitOptions {
  /** Override the plugin checkout location. Defaults under the data dir. */
  checkout?: string;
  /**
   * Write `SUITE_TOKEN=${VAR}` instead of the value. Opt-in: see
   * {@link ENV_INTERPOLATION_SUPPORTED} for why this is not the default.
   */
  tokenFromEnv?: string;
}

export const PLUGIN_REPO = "https://github.com/Startup-Suite/claude-code-suite-channel.git";
export const PLUGIN_DIRNAME = "claude-code-suite-channel";
export const CHANNEL_SERVER = "suite-channel";
export const TOOLS_SERVER = "startup-suite";

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

export class PullFailed extends Error {
  readonly exitCode = 4;
  constructor(dir: string, detail: string) {
    super(
      [
        `the plugin checkout at ${dir} could not be fast-forwarded:`,
        detail.trim(),
        `  it has local commits or a diverged history. Resolve it there, or move it aside.`,
        `  init will not force, reset or delete a checkout it did not create.`,
      ].join("\n"),
    );
    this.name = "PullFailed";
  }
}

export type CheckoutOutcome = "cloned" | "updated";

/**
 * Clone the plugin, or fast-forward an existing checkout.
 *
 * `--ff-only` and then STOP on failure. The alternative — a reset or a force —
 * silently destroys whatever the user was doing in that directory, and this
 * command was invoked to set up a tool, not to arbitrate their git state.
 */
export async function cloneOrUpdate(dir: string, deps: InitDeps): Promise<CheckoutOutcome> {
  if (existsSync(resolve(dir, ".git"))) {
    const r = await deps.run(["git", "pull", "--ff-only"], { cwd: dir });
    if (r.exitCode !== 0) throw new PullFailed(dir, r.stderr || r.stdout);
    return "updated";
  }
  await mkdir(resolve(dir, ".."), { recursive: true });
  const r = await deps.run(["git", "clone", PLUGIN_REPO, dir]);
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
export function channelWsUrl(suiteUrl: string): string {
  const u = new URL(suiteUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/runtime/ws";
  u.search = "";
  return u.toString();
}

export function toolsHttpUrl(suiteUrl: string): string {
  const u = new URL(suiteUrl);
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
    "user",
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
    "user",
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

export type ServerState = "connected" | "not-connected" | "unparseable" | "missing";

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
    if (/[✘✗x×]/i.test(status) || /fail|refus|error|timeout|pending|disconnect/i.test(status)) {
      return { name, state: "not-connected", raw: trimmed };
    }
    return { name, state: "unparseable", raw: trimmed };
  }
  return { name, state: "missing", raw: "" };
}

export async function verifyConnections(deps: InitDeps): Promise<ServerStatus[]> {
  const r = await deps.run(["claude", "mcp", "list"]);
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
/* Orchestration                                                              */
/* ------------------------------------------------------------------------- */

export const FEDERATE_HINT = [
  "  Open Suite in a browser, go to Agent Resources, and click Federate on this",
  "  runtime. Copy the URL, the runtime id and the token it shows you.",
].join("\n");

export interface InitResult {
  exitCode: number;
  /** True when tmux is unavailable — sessions will not outlive a terminal. */
  tmuxMissing: boolean;
  checkout: CheckoutOutcome;
  configPath: string;
}

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

  // 3-4. the checkout ---------------------------------------------------
  const checkoutDir = options.checkout ?? defaultCheckout(deps.env);
  const cloneSpin = spinner("plugin", deps);
  let outcome: CheckoutOutcome;
  try {
    outcome = await cloneOrUpdate(checkoutDir, deps);
  } finally {
    cloneSpin.stop();
  }
  say(row("plugin", PLUGIN_DIRNAME, outcome));

  const depsSpin = spinner("dependencies", deps);
  let installOut = "";
  try {
    const r = await deps.run(["bun", "install"], { cwd: checkoutDir });
    installOut = `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0) throw new Error(`bun install failed in ${checkoutDir}`);
  } finally {
    depsSpin.stop();
  }
  say(row("dependencies", packageCount(installOut) || "up to date", "installed"));

  // 5. credentials ------------------------------------------------------
  say("");
  say(FEDERATE_HINT);
  say("");
  const existing = await readConfig({ env: deps.env });
  const suiteUrl = (await deps.prompter.ask(`suite url${existing ? ` [${existing.suiteUrl}]` : ""}: `)).trim() ||
    existing?.suiteUrl ||
    "";
  const runtimeId = (await deps.prompter.ask(`runtime id${existing ? ` [${existing.runtimeId}]` : ""}: `)).trim() ||
    existing?.runtimeId ||
    "";
  if (suiteUrl === "" || runtimeId === "") throw new Error("suite url and runtime id are both required");
  const { headerNames } = await solicitCredentials(deps.prompter, deps.store);

  const config: SuiteConfig = {
    suiteUrl,
    runtimeId,
    headerNames,
    sessionNaming: existing?.sessionNaming ?? "cwd",
  };
  const configFile = await writeConfig(config, { env: deps.env });
  say(row("config", configFile));

  // 6. both MCP entries, via claude mcp add -----------------------------
  const token = deps.store.get(TOKEN_KEY) ?? "";
  const tokenLiteral = options.tokenFromEnv === undefined ? token : envReference(options.tokenFromEnv);
  const usingReference = options.tokenFromEnv !== undefined;
  const indexPath = resolve(checkoutDir, "src", "index.ts");

  const headers = headerNames.map((name) => ({ name, value: deps.store.get(name) ?? "" }));
  const invocations = [
    channelAddArgs({ suiteUrl, runtimeId, tokenLiteral, indexPath }),
    toolsAddArgs(suiteUrl, tokenLiteral, headers),
  ];

  for (const argv of invocations) {
    // A short-lived, directly spawned process: no shell, so no history, and the
    // command line is gone before anyone can read it out of `ps`. This is the
    // one place stage 2 sanctions a secret in argv, and the constructed command
    // line is NEVER logged — it carries the token.
    const r = await deps.run(argv, { allowSecretsInArgv: true });
    if (r.exitCode !== 0) {
      throw new Error(`claude mcp add ${argv[3]} failed with exit ${r.exitCode}`);
    }
  }
  say(row(CHANNEL_SERVER, "registered", "user scope"));
  say(row(TOOLS_SERVER, "registered", "user scope"));
  if (usingReference) {
    say(row("", "", `token read from ${options.tokenFromEnv} at launch; export it or the channel will not authenticate`));
  }

  // 7. connected, not merely written ------------------------------------
  const statuses = await verifyConnections(deps);
  const report = connectionReport(statuses);
  for (const line of report.lines) say(line);

  say("");
  say(nextCommand("suite claude"));

  return {
    exitCode: report.ok ? 0 : 1,
    tmuxMissing: !tmux.present,
    checkout: outcome,
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
    out: (line) => void process.stdout.write(`${line}\n`),
    run: (argv, options) => spawnWithSecrets(argv, store, options),
  };
}
