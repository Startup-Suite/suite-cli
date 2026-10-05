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
import { singleQuote } from "./tmux.ts";
import { row } from "./ui.ts";
import { selfArgv } from "./commands/deepseek.ts";
import {
  CHANNEL_SERVER,
  MCP_SCOPE,
  alreadyRegistered,
  PLUGIN_DIRNAME,
  TOOLS_SERVER,
  channelAddArgs,
  channelWsUrl,
  claudeJsonPath,
  cloneOrUpdate,
  connectionReport,
  noGitPrompt,
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
  /**
   * argv that runs THIS CLI, for the ref-mode `headersHelper`. Defaults to
   * `[bun, <lib>/src/cli.ts]` (deepseek.ts `selfArgv`): absolute, so it works
   * from the minimal PATH Claude Code may run a helper with.
   */
  self?: string[];
  /** Where a ref-mode notice goes (stderr). Defaults to `out`. */
  err?(line: string): void;
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
  /** A command Claude Code runs to get headers (ref mode). */
  headersHelper?: string;
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
  /**
   * REF MODE: the connection holds a token ref, and the entries carry the REF
   * and a headersHelper — never a value. Absent in literal mode.
   */
  ref?: { raw: string; service: string | null; helper: string };
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
  if (want.ref !== undefined) {
    // Ref mode: the entry carries the REF and its service, and nothing else.
    if (env.SUITE_TOKEN !== want.ref.raw) return "stale";
    if ((env.SUITE_TOKEN_KEYCHAIN_SERVICE ?? null) !== want.ref.service) return "stale";
    return "current";
  }
  if (want.tokenLiteral !== null && env.SUITE_TOKEN !== want.tokenLiteral) return "stale";
  return "current";
}

/** Does the tools entry match the saved connection? Same rules as the channel. */
export function toolsState(entry: McpEntry | undefined, want: DesiredEntries): EntryState {
  if (entry === undefined) return "missing";
  if (entry.url !== toolsHttpUrl(want.suiteUrl)) return "stale";
  if (want.ref !== undefined) {
    // Ref mode: a helper, and NO inline Authorization. An entry still carrying
    // a literal bearer from literal mode is stale, so switching to a ref
    // rewrites it and the literal leaves ~/.claude.json.
    if (entry.headersHelper !== want.ref.helper) return "stale";
    if (entry.headers !== undefined && Object.keys(entry.headers).length > 0) return "stale";
    return "current";
  }
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

/**
 * The `headersHelper` command for ref mode. Claude Code runs it THROUGH A
 * SHELL, so every word is single-quoted. It carries the ref and its service —
 * names, never a value — so the folder resolves its own ref.
 */
export function headersHelperCommand(self: string[], ref: string, service: string | null): string {
  const words = [...self, "mcp-headers", "--token-ref", ref, ...(service !== null ? ["--keychain-service", service] : [])];
  return words.map(singleQuote).join(" ");
}

export function planMcp(
  deps: Pick<WiringDeps, "env" | "cwd" | "store" | "self">,
  config: SuiteConfig,
  checkout: string,
): McpPlan {
  const inRefMode = config.tokenRef !== undefined && config.tokenRef !== "";
  const service = inRefMode && config.tokenRef?.startsWith("keychain:") ? (config.keychainService ?? "") : null;
  const want: DesiredEntries = {
    suiteUrl: config.suiteUrl,
    runtimeId: config.runtimeId,
    indexPath: resolve(checkout, "src", "index.ts"),
    tokenLiteral: inRefMode ? null : tokenLiteralFor(config, deps.store),
    headers: config.headerNames.map((name) => ({ name, value: deps.store.get(name) })),
  };
  if (inRefMode) {
    const raw = config.tokenRef as string;
    want.ref = { raw, service, helper: headersHelperCommand(deps.self ?? selfArgv(deps.env as NodeJS.ProcessEnv), raw, service) };
  }
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

/* ------------------------------------------------------------------------- */
/* Ref mode                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The claude-code-suite-channel commit ref mode needs when the checkout cannot
 * resolve a token ref itself (its package.json lacks `suite.tokenRefs >= 1`).
 *
 * DEPLOYER: this is the tip of the channel's task/01a0d6b9 branch (the token
 * ref resolver). Re-pin it to that branch's MERGE sha on main before merging
 * suite-cli 0.8.0, so the pin names a commit main will keep.
 */
export const CLAUDE_CHANNEL_REF = "28afe6cc86bd80fc96ac38e657b6954ca9b0931d";

/** The capability marker a ref-capable channel plugin declares in package.json. */
export const TOKEN_REFS_CAPABILITY = 1;

/** `suite.tokenRefs` out of a checkout's package.json; 0 when absent or unreadable. */
export function checkoutTokenRefs(dir: string): number {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { suite?: { tokenRefs?: unknown } };
    const v = pkg.suite?.tokenRefs;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** The stdio channel entry as `claude mcp add-json` takes it. The token slot holds the REF. */
export function channelEntryJson(want: DesiredEntries): string {
  if (want.ref === undefined) throw new Error("channelEntryJson is ref mode only");
  const env: Record<string, string> = {
    SUITE_URL: channelWsUrl(want.suiteUrl),
    SUITE_RUNTIME_ID: want.runtimeId,
    SUITE_TOKEN: want.ref.raw,
  };
  if (want.ref.service !== null) env.SUITE_TOKEN_KEYCHAIN_SERVICE = want.ref.service;
  env.SUITE_ALLOW_PERMISSION_RELAY = "0";
  return JSON.stringify({ type: "stdio", command: "bun", args: [want.indexPath], env });
}

/** The HTTP tools entry: a URL and a headersHelper. NO headers, so no value. */
export function toolsEntryJson(want: DesiredEntries): string {
  if (want.ref === undefined) throw new Error("toolsEntryJson is ref mode only");
  return JSON.stringify({ type: "http", url: toolsHttpUrl(want.suiteUrl), headersHelper: want.ref.helper });
}

/** argv for one ref-mode registration. Every element is a name, a URL or a ref. */
export function addJsonArgs(name: string, json: string): string[] {
  return ["claude", "mcp", "add-json", "-s", MCP_SCOPE, name, json];
}

/**
 * Register ref-mode entries. Unlike literal mode, NO argv may carry a secret,
 * so the runner's argv guard stays ON (`allowSecretsInArgv` is never passed).
 * Converges like {@link registerServers}: an existing local entry of the same
 * name is removed and re-added, in this directory only.
 */
export async function registerJsonServers(
  deps: Pick<WiringDeps, "run" | "cwd">,
  entries: Array<{ name: string; json: string }>,
): Promise<string[]> {
  const lines: string[] = [];
  for (const { name, json } of entries) {
    const argv = addJsonArgs(name, json);
    let r = await deps.run(argv, { cwd: deps.cwd });
    if (r.exitCode !== 0 && alreadyRegistered(r.stderr || r.stdout)) {
      await deps.run(["claude", "mcp", "remove", name, "-s", MCP_SCOPE], { cwd: deps.cwd });
      r = await deps.run(argv, { cwd: deps.cwd });
    }
    if (r.exitCode !== 0) {
      throw new Error([`claude mcp add-json ${name} failed with exit ${r.exitCode}:`, (r.stderr || r.stdout).trim()].filter((l) => l !== "").join("\n"));
    }
    lines.push(row(name, "registered", `local scope, token ref: ${deps.cwd}`));
  }
  return lines;
}

/**
 * Ref mode needs a channel plugin that resolves refs. When the checkout does
 * not declare `suite.tokenRefs >= 1`, move it to {@link CLAUDE_CHANNEL_REF}
 * (fetch, then a detached checkout — never a reset or a force: local changes
 * make git refuse, and that refusal is reported). THE ONLY CASE in which an
 * existing checkout is updated.
 */
async function ensureRefCapableCheckout(deps: WiringDeps, dir: string): Promise<boolean> {
  if (checkoutTokenRefs(dir) >= TOKEN_REFS_CAPABILITY) return false;
  const say = deps.err ?? deps.out;
  say(row("plugin", "no token-ref support", `moving ${PLUGIN_DIRNAME} to ${CLAUDE_CHANNEL_REF.slice(0, 12)} (suite.tokenRefs >= ${TOKEN_REFS_CAPABILITY})`));
  const env = noGitPrompt(deps.env);
  const fetched = await deps.run(["git", "fetch", "--quiet", "origin", CLAUDE_CHANNEL_REF], { cwd: dir, env });
  if (fetched.exitCode !== 0) throw new Error(`git fetch ${CLAUDE_CHANNEL_REF} failed in ${dir}: ${(fetched.stderr || fetched.stdout).trim()}`);
  const co = await deps.run(["git", "checkout", "--quiet", "--detach", CLAUDE_CHANNEL_REF], { cwd: dir, env });
  if (co.exitCode !== 0) throw new Error(`git checkout ${CLAUDE_CHANNEL_REF} failed in ${dir}: ${(co.stderr || co.stdout).trim()}`);
  if (checkoutTokenRefs(dir) < TOKEN_REFS_CAPABILITY) {
    throw new Error(`${dir} at ${CLAUDE_CHANNEL_REF} still does not declare suite.tokenRefs; the pin is wrong`);
  }
  return true;
}

/**
 * Ensure the plugin checkout exists and has its dependencies. Clones when it
 * is absent; an existing checkout is used as it is, never pulled.
 */
async function ensureCheckout(deps: WiringDeps, dir: string, refMode = false): Promise<CheckoutOutcome | "present"> {
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
  const moved = refMode ? await ensureRefCapableCheckout(deps, dir) : false;
  if (outcome !== "present" || moved || !existsSync(resolve(dir, "node_modules"))) {
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
  const refMode = config.tokenRef !== undefined && config.tokenRef !== "";
  const checkout = await ensureCheckout(deps, checkoutDir, refMode);
  const md = ensureClaudeMd(deps);

  const plan = planMcp(deps, config, checkoutDir);
  const registered: string[] = [];
  let connected = true;
  if (needsRegistration(plan) && plan.want.ref !== undefined) {
    // REF MODE: both entries through `claude mcp add-json`, every argv value-
    // free. There is NO fallback to an inline bearer: if this fails, it fails.
    const entries: Array<{ name: string; json: string }> = [];
    if (plan.channel !== "current") entries.push({ name: CHANNEL_SERVER, json: channelEntryJson(plan.want) });
    if (plan.tools !== "current") entries.push({ name: TOOLS_SERVER, json: toolsEntryJson(plan.want) });
    for (const line of await registerJsonServers(deps, entries)) deps.out(line);
    registered.push(...entries.map((e) => e.name));
    const report = connectionReport(await verifyConnections(deps));
    for (const line of report.lines) deps.out(line);
    connected = report.ok;
  } else if (needsRegistration(plan)) {
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
