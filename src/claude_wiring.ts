/**
 * Claude Code's WIRING to a Suite install — everything `suite claude` needs
 * that no other harness does:
 *
 *   plugin        the channel plugin checkout (cloned once, bun-installed)
 *   CLAUDE.md     a starting brief, never a replacement for an existing one
 *   MCP entries   `suite-channel` and `startup-suite`, local scope, this folder
 *
 * This used to be steps 3-7 of `suite init`, which made init fail with
 * `ENOENT: claude` on any machine without Claude Code — a fresh Mac, or a
 * DeepSeek-only box. Now init connects the machine to the install (see
 * `src/connection.ts`) and this module is run by `suite claude`, every launch,
 * from the saved connection.
 *
 * IDEMPOTENT AND LAZY. Each piece is checked and only what is missing or stale
 * is done: an existing checkout is not pulled (a launch must not depend on the
 * network), an existing CLAUDE.md is never touched, and an MCP entry that
 * already matches the saved connection is not re-registered. A launch on a
 * fully wired folder runs no git, no bun and no `claude mcp` at all.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CLAUDE_MD,
  CONVENTIONS_FILENAME,
  CONVENTIONS_MD,
  claudeMdPlan,
  conventionsAdvice,
  conventionsPlan,
  type ConventionsPlan,
} from "./claude_md.ts";
import type { SuiteConfig } from "./config.ts";
import { TOKEN_KEY, type CredentialStore } from "./secrets.ts";
import { row } from "./ui.ts";
import {
  CHANNEL_SERVER,
  PLUGIN_DIRNAME,
  TOOLS_SERVER,
  channelAddArgs,
  channelWsUrl,
  claudeJsonPath,
  cloneOrUpdate,
  connectionReport,
  defaultCheckout,
  envReference,
  packageCount,
  registerServers,
  spinner,
  toolsAddArgs,
  toolsHttpUrl,
  verifyConnections,
  type CheckoutOutcome,
  type Runner,
} from "./commands/init.ts";

type Env = Record<string, string | undefined>;

export interface WiringDeps {
  env: Env;
  run: Runner;
  /** The agent folder. Local-scope MCP entries are keyed by it. */
  cwd: string;
  isTTY: boolean;
  store: CredentialStore;
  out(line: string): void;
}

export interface WiringOptions {
  /** Override the plugin checkout location. Defaults under the data dir. */
  checkout?: string;
}

/* ------------------------------------------------------------------------- */
/* What is already registered — read from ~/.claude.json, never written       */
/* ------------------------------------------------------------------------- */

export interface McpEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * The directories Claude Code may key this folder's local-scope entries under:
 * the folder itself, and the enclosing git work tree's root when there is one
 * (measured, see `MCP_SCOPE` in init.ts).
 */
export function projectKeys(cwd: string): string[] {
  const keys = [resolve(cwd)];
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) {
      if (!keys.includes(dir)) keys.push(dir);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return keys;
}

/**
 * This folder's local-scope MCP entries, or null when `~/.claude.json` cannot
 * be read. Null means UNKNOWN, and the caller registers both — `registerServers`
 * converges on an existing entry, so the cost of not knowing is one rewrite.
 */
export function localEntries(env: Env, cwd: string): Record<string, McpEntry> | null {
  let text: string;
  try {
    text = readFileSync(claudeJsonPath(env), "utf8");
  } catch {
    return existsSync(claudeJsonPath(env)) ? null : {};
  }
  try {
    const raw = JSON.parse(text) as { projects?: Record<string, { mcpServers?: Record<string, McpEntry> }> };
    for (const key of projectKeys(cwd)) {
      const servers = raw.projects?.[key]?.mcpServers;
      if (servers !== undefined) return servers;
    }
    return {};
  } catch {
    return null;
  }
}

export type EntryState = "current" | "missing" | "stale";

export interface DesiredEntries {
  suiteUrl: string;
  runtimeId: string;
  indexPath: string;
  /** The token as it should appear in the entry, or null when not known here. */
  tokenLiteral: string | null;
  headers: Array<{ name: string; value: string | undefined }>;
}

/**
 * Does the channel entry match the saved connection?
 *
 * Compared field by field against what {@link channelAddArgs} would write. The
 * token is compared only when it is known — a machine set up before the token
 * was saved still has a working entry, and re-asking for a token to rewrite an
 * entry that is already right would be exactly the friction this removes.
 */
export function channelState(entry: McpEntry | undefined, want: DesiredEntries): EntryState {
  if (entry === undefined) return "missing";
  const env = entry.env ?? {};
  const args = entry.args ?? [];
  if (env.SUITE_URL !== channelWsUrl(want.suiteUrl)) return "stale";
  if (env.SUITE_RUNTIME_ID !== want.runtimeId) return "stale";
  if (args[args.length - 1] !== want.indexPath) return "stale";
  if (want.tokenLiteral !== null && env.SUITE_TOKEN !== want.tokenLiteral) return "stale";
  return "current";
}

/** Does the tools entry match the saved connection? Same rules as the channel. */
export function toolsState(entry: McpEntry | undefined, want: DesiredEntries): EntryState {
  if (entry === undefined) return "missing";
  if (entry.url !== toolsHttpUrl(want.suiteUrl)) return "stale";
  const headers = entry.headers ?? {};
  if (want.tokenLiteral !== null && headers.Authorization !== `Bearer ${want.tokenLiteral}`) return "stale";
  for (const h of want.headers) {
    if (!(h.name in headers)) return "stale";
    if (h.value !== undefined && headers[h.name] !== h.value) return "stale";
  }
  return "current";
}

/** The token as an entry should carry it: an env reference, the saved value, or unknown. */
export function tokenLiteralFor(config: SuiteConfig, store: CredentialStore): string | null {
  if (config.tokenEnv !== undefined) return envReference(config.tokenEnv);
  const token = store.get(TOKEN_KEY) ?? "";
  return token === "" ? null : token;
}

export interface McpPlan {
  channel: EntryState;
  tools: EntryState;
  want: DesiredEntries;
}

export function planMcp(deps: Pick<WiringDeps, "env" | "cwd" | "store">, config: SuiteConfig, checkout: string): McpPlan {
  const want: DesiredEntries = {
    suiteUrl: config.suiteUrl,
    runtimeId: config.runtimeId,
    indexPath: resolve(checkout, "src", "index.ts"),
    tokenLiteral: tokenLiteralFor(config, deps.store),
    headers: config.headerNames.map((name) => ({ name, value: deps.store.get(name) })),
  };
  const entries = localEntries(deps.env, deps.cwd);
  if (entries === null) return { channel: "missing", tools: "missing", want };
  return { channel: channelState(entries[CHANNEL_SERVER], want), tools: toolsState(entries[TOOLS_SERVER], want), want };
}

/** True when the plan has an entry to write. */
export function needsRegistration(plan: McpPlan): boolean {
  return plan.channel !== "current" || plan.tools !== "current";
}

/* ------------------------------------------------------------------------- */
/* The wiring                                                                 */
/* ------------------------------------------------------------------------- */

export interface WiringResult {
  checkout: CheckoutOutcome | "present";
  claudeMd: "write" | "skip";
  conventions: ConventionsPlan["claudeMd"];
  /** Entries written by this call, by name. Empty when both were current. */
  registered: string[];
  /** False only when entries were written and then did not verify. */
  connected: boolean;
}

/**
 * Ensure the plugin checkout exists and has its dependencies. Clones when it
 * is absent; an existing checkout is used as it is, never pulled.
 */
async function ensureCheckout(deps: WiringDeps, dir: string): Promise<CheckoutOutcome | "present"> {
  let outcome: CheckoutOutcome | "present" = "present";
  if (!existsSync(resolve(dir, ".git")) || !existsSync(resolve(dir, "src", "index.ts"))) {
    const spin = spinner("plugin", deps);
    try {
      outcome = await cloneOrUpdate(dir, deps);
    } finally {
      spin.stop();
    }
    deps.out(row("plugin", PLUGIN_DIRNAME, outcome));
  }
  if (outcome !== "present" || !existsSync(resolve(dir, "node_modules"))) {
    const spin = spinner("dependencies", deps);
    let out = "";
    try {
      const r = await deps.run(["bun", "install"], { cwd: dir });
      out = `${r.stdout}\n${r.stderr}`;
      if (r.exitCode !== 0) throw new Error(`bun install failed in ${dir}`);
    } finally {
      spin.stop();
    }
    deps.out(row("dependencies", packageCount(out) || "up to date", "installed"));
  }
  return outcome;
}

/**
 * CLAUDE.md: written when absent, never touched when present. The conventions
 * file is this CLI's own and is rewritten only when its content differs, so a
 * launch on a wired folder writes nothing and says nothing.
 */
function ensureClaudeMd(deps: WiringDeps): { claudeMd: "write" | "skip"; conventions: ConventionsPlan["claudeMd"] } {
  const claudeMdPath = resolve(deps.cwd, "CLAUDE.md");
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : null;
  const plan = claudeMdPlan(claudeMdPath, existing !== null);
  if (plan.action === "write") {
    writeFileSync(plan.path, CLAUDE_MD, "utf8");
    deps.out(row("CLAUDE.md", plan.path, "written"));
  }
  const conventions = conventionsPlan(resolve(deps.cwd, CONVENTIONS_FILENAME), existing);
  if (conventions.action === "write") {
    const current = existsSync(conventions.path) ? readFileSync(conventions.path, "utf8") : null;
    if (current !== CONVENTIONS_MD) {
      writeFileSync(conventions.path, CONVENTIONS_MD, "utf8");
      deps.out(row(CONVENTIONS_FILENAME, conventions.path, "written"));
      for (const line of conventionsAdvice(conventions)) deps.out(row("", "", line));
    }
  }
  return { claudeMd: plan.action, conventions: conventions.claudeMd };
}

/**
 * Wire this folder's Claude Code to the saved install.
 *
 * The caller must have put the token in `deps.store` (or set `tokenEnv`)
 * whenever {@link planMcp} reports something to register — see
 * `ensureToken` in connection.ts. Without one this throws rather than
 * registering an entry that authenticates with nothing.
 */
export async function ensureClaudeWiring(
  deps: WiringDeps,
  config: SuiteConfig,
  options: WiringOptions = {},
): Promise<WiringResult> {
  const checkoutDir = options.checkout ?? defaultCheckout(deps.env);
  const checkout = await ensureCheckout(deps, checkoutDir);
  const md = ensureClaudeMd(deps);

  const plan = planMcp(deps, config, checkoutDir);
  const registered: string[] = [];
  let connected = true;
  if (needsRegistration(plan)) {
    const tokenLiteral = plan.want.tokenLiteral;
    if (tokenLiteral === null) {
      throw new Error("no saved token to write into the Claude MCP entries; run suite init");
    }
    const headers = plan.want.headers.map((h) => ({ name: h.name, value: h.value ?? "" }));
    const invocations: string[][] = [];
    if (plan.channel !== "current") {
      invocations.push(
        channelAddArgs({ suiteUrl: config.suiteUrl, runtimeId: config.runtimeId, tokenLiteral, indexPath: plan.want.indexPath }),
      );
      registered.push(CHANNEL_SERVER);
    }
    if (plan.tools !== "current") {
      invocations.push(toolsAddArgs(config.suiteUrl, tokenLiteral, headers));
      registered.push(TOOLS_SERVER);
    }
    for (const line of await registerServers(deps, invocations, config.runtimeId)) deps.out(line);
    if (config.tokenEnv !== undefined) {
      deps.out(row("", "", `token read from ${config.tokenEnv} at launch; export it or the channel will not authenticate`));
    }
    // WRITTEN IS NOT CONNECTED — checked only after a write, because listing
    // health-checks every server and a launch on a wired folder should not pay
    // for it. A failure here is reported, not fatal: the agent still starts.
    const report = connectionReport(await verifyConnections(deps));
    for (const line of report.lines) deps.out(line);
    connected = report.ok;
  }
  return { checkout, ...md, registered, connected };
}
