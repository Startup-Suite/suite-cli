/**
 * `suite deepseek` — run a DeepSeek Harness agent federated into Startup Suite.
 *
 * Sibling to `suite claude`, and deliberately a different SHAPE. `suite claude`
 * wraps a binary the user already installed and passes everything through.
 * `dsh` instead composes itself from a profile plus ordered patch files, so
 * this verb's real job is MATERIALISING that composition on this machine and
 * then getting out of the way.
 *
 * Three rules carry the module:
 *
 *  1. ONE CREDENTIAL. The runtime token authenticates BOTH the federation
 *     websocket and the MCP endpoint — verified against a live deployment, not
 *     assumed. So there is exactly one secret to solicit, and `suite init`
 *     already captured it.
 *  2. NO HARDCODED DEPLOYMENT HEADERS. Some deployments sit behind an access
 *     proxy that requires extra headers; the CLI knows none of them by name.
 *     Whatever `headerNames` the config carries is forwarded from the
 *     credential store, and a deployment with none works unchanged. The repo's
 *     hygiene test enforces this — naming one here is a build failure, which
 *     is how this comment came to be worded generically. See `config.ts`.
 *  3. THE PATCH IS GENERATED, NOT SHIPPED. dsh reads a plugin entry's `name:`
 *     as a literal string — no `!!js`, no env expansion (that field is read
 *     before expressions are evaluated). A static patch file therefore cannot
 *     name a plugin path that is correct on two machines, so the patch is
 *     written at run time with this machine's resolved paths baked in.
 */
import { runForwardingSignals } from "../child_signals.ts";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, type SuiteConfig } from "../config.ts";
import { createStore, TOKEN_KEY, assertNoSecretsInArgv, ttyPrompter, type CredentialStore, type Prompter } from "../secrets.ts";
import { ensureConnection, ensureToken, hasConnection, readCredentials } from "../connection.ts";
import { dataDir } from "../paths.ts";
import { parseTokenRef, resolveTokenRef, type ResolveDeps } from "../token_ref.ts";

/** `suite deepseek` on a ref-mode connection: refused, exit 2 (the stamp contract's "refused"). */
export const TOKEN_REF_UNSUPPORTED_EXIT = 2;
import {
  attachArgv,
  composeNewSession,
  detectState,
  liveTmuxDeps,
  nestingPlan,
  SESSION_PREFIX,
  TMUX,
  type TmuxDeps,
} from "../tmux.ts";

export const AGENT = "deepseek";

/**
 * The placeholder task handed to the headless profile's startup plugin, which
 * requires one even when the runner that would execute it is disabled. It is
 * never executed — the federation plugin drives every turn from a dispatch.
 */
export const IDLE_TASK = "Stand by for Suite dispatches.";

/**
 * What gets installed into the harness directory.
 *
 * The harness is `@deepseek-ai/dsh`, PINNED. The bare name `dsh` on npm is an
 * unrelated package — installing it produces a directory with no `dsh` binary
 * and an error one layer removed from the cause. The pin matters too: the
 * federation plugin is written against this API, and a floating range would
 * silently move it.
 *
 * `phoenix` and `ws` are the federation plugin's own dependencies, not the
 * harness's: the plugin speaks the same Phoenix channel protocol the OpenClaw
 * bridge does, and Node has no WebSocket the Phoenix client will accept. They
 * install alongside dsh so the plugin resolves them by plain Node resolution
 * from where it is copied.
 */
export const DSH_PACKAGES = ["@deepseek-ai/dsh@0.1.1-rc.2", "phoenix@^1.8.13", "ws@^8.21.3"] as const;

/**
 * Where the harness itself is installed — shared across agents, because it is
 * a program, not state. Agent state lives under the agent root instead.
 */
export function harnessDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "deepseek");
}

/**
 * An agent's root folder: its cwd, its `DSH_HOME`, and where its `AGENTS.md`
 * and sessions live. Defaults to `~/agents/<name>`, which is the house
 * convention for an agent that owns a directory rather than a checkout.
 */
export function agentRoot(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), "agents", name);
}

/**
 * The agent name derived from a runtime id.
 *
 * Runtime ids in the wild carry a transport or host suffix (`oddjob-dsh`,
 * `ryan-home-openclaw`). The directory should be named for the AGENT, so a
 * trailing `-dsh` is dropped. Anything else is kept verbatim — guessing more
 * aggressively would collapse two distinct runtimes onto one root.
 */
export function agentNameFromRuntimeId(runtimeId: string): string {
  return runtimeId.replace(/-dsh$/, "");
}

/** The per-agent config file inside an agent root. Holds no secret. */
export const AGENT_CONFIG_FILE = "suite.json";

/** The per-agent credential file inside an agent root. Mode 0600. */
export const AGENT_STATE_FILE = ".suite-state.json";

/**
 * The tmux session an agent's harness runs in.
 *
 * Named for the AGENT rather than the working directory, unlike
 * `suite claude`. A dsh agent is a long-lived identity that owns one root;
 * two shells in different directories asking for `oddjob` mean the same
 * session, and deriving the name from `cwd` would silently give them two.
 */
export function sessionNameForAgent(name: string): string {
  return `${SESSION_PREFIX}-${name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`;
}

export interface DeepseekOptions {
  /** Override the agent root directory. */
  root?: string;
  /** Skip tmux entirely and exec the harness in this process. */
  noSession?: boolean;
  /** Arguments forwarded to dsh verbatim, after ours. */
  rest: string[];
}

/**
 * Parse the options this verb owns. Scanning STOPS at the first `--`, so a
 * user who needs to pass `--root` to dsh itself can still do so — the same
 * terminator contract `suite claude` documents.
 */
export function parseDeepseekOptions(args: string[]): DeepseekOptions {
  const rest: string[] = [];
  let root: string | undefined;
  let noSession = false;
  let terminated = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (terminated) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }
    if (arg === "--root" && args[i + 1] !== undefined) {
      root = args[i + 1];
      i++;
      continue;
    }
    if (arg === "--no-session") {
      noSession = true;
      continue;
    }
    rest.push(arg);
  }
  return { root, rest, noSession };
}

/**
 * The websocket URL for a Suite base URL.
 *
 * `/runtime/ws` is the endpoint `PlatformWeb.RuntimeChannel` serves; `/socket`
 * is the LiveView endpoint and answers a redirect, which surfaces as an opaque
 * "unexpected server response: 302" hours later. Deriving it here means no
 * operator has to know that.
 */
export function runtimeWsUrl(suiteUrl: string): string {
  const trimmed = suiteUrl.replace(/\/+$/, "");
  const ws = trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${ws}/runtime/ws`;
}

/** The MCP endpoint, which is a separate host in our deployment. */
export function mcpUrl(config: SuiteConfig, env: NodeJS.ProcessEnv = process.env): string {
  return env.SUITE_MCP_URL ?? `${config.suiteUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * Render the composition patch for this machine.
 *
 * `pluginPath` is interpolated as a literal because dsh reads `name:` before
 * evaluating `!!js` — see rule 3 in the module doc. Everything else that
 * varies per run goes through the environment, which IS expanded.
 */
export function renderPatch(pluginPath: string, headerNames: string[]): string {
  const headerLines = headerNames
    .map((name) => `          ${name}: !!js process.env[${JSON.stringify(envNameForHeader(name))}] || ''`)
    .join("\n");
  return `# Generated by \`suite deepseek\`. Regenerated on every run — edit the
# command, not this file. Paths are baked in because dsh reads a plugin
# entry's \`name:\` as a literal string.
# A route must be DECLARED here, not merely named as the default. Naming a
# provider the agent default without a matching pi-ai route fails at the first
# turn with NO_ADAPTER — after the socket has connected and everything looks
# healthy.
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openrouter:
        displayName: OpenRouter
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: https://openrouter.ai/api/v1
        models:
          # DECLARED FROM THE SAME EXPRESSION THAT SELECTS IT. Naming a model
          # the route does not declare fails at the first turn with
          # UNKNOWN_MODEL. An agent root that sets DSH_MODEL (its own
          # .suite-state.json \`env\`) would otherwise select a model this route
          # has never heard of.
          - id: !!js process.env.DSH_MODEL || 'moonshotai/kimi-k3'
            contextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW || 1000000)
- id: agent-default-model
  config:
    provider: !!js process.env.DSH_PROVIDER || 'openrouter'
    model: !!js process.env.DSH_MODEL || 'moonshotai/kimi-k3'
# The one-shot runner tears the whole plugin tree down when its task ends,
# taking the agent factory with it. A federated agent outlives its first turn.
- id: headless-runner
  name: '@deepseek-ai/dsh-headless'
  inject:
    - headlessStartup
  config:
    task: !!js ctx.headlessStartup.task
  disabled: true
- insert:
    - id: mcp-suite
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: startup-suite
        transport: streamable-http
        url: !!js process.env.SUITE_MCP_URL
        headers:
          Authorization: !!js '\`Bearer \${process.env.SUITE_RUNTIME_TOKEN}\`'
${headerLines}
        failOnStartupError: true
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true
    - id: suite-federation
      name: ${pluginPath}
      config:
        url: !!js process.env.SUITE_WS_URL
        runtimeId: !!js process.env.SUITE_RUNTIME_ID
        token: !!js process.env.SUITE_RUNTIME_TOKEN
`;
}

/**
 * The environment variable carrying one operator header's VALUE.
 *
 * Names are operator-chosen and may contain characters no shell accepts, so
 * they are normalised rather than trusted: a header named `X-Example-Id`
 * becomes `SUITE_HEADER_X_EXAMPLE_ID`. The prefix keeps them from colliding
 * with anything the harness reads.
 */
export function envNameForHeader(name: string): string {
  return `SUITE_HEADER_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export interface DeepseekDeps {
  which(bin: string): string | null;
  /** Whether stdout is a terminal. False under a service manager. */
  isTTY(): boolean;
  run(argv: string[], opts: { cwd?: string; env?: Record<string, string> }): Promise<number>;
  exec(argv: string[], opts: { cwd: string; env: Record<string, string> }): Promise<never> | Promise<number>;
  stderr: { write(text: string): void };
  /** The directory the verb was run from. Defaults to `process.cwd()`. */
  cwd?(): string;
  /** Injected in tests; defaults to the live tmux. */
  tmux?: TmuxDeps;
  /**
   * Asks for the Suite connection when this machine has none saved — the same
   * prompts `suite init` asks — instead of refusing with "run suite init
   * first". Only used from a terminal; absent, the verb refuses as before.
   */
  prompter?: Prompter;
}

/** Whether the harness is already installed under `dir`. */
export async function harnessInstalled(dir: string): Promise<boolean> {
  return await Bun.file(join(dir, "node_modules", ".bin", "dsh")).exists();
}

/**
 * Install the harness with bun.
 *
 * bun and not npm: npm spent 546 CPU-seconds on this dependency tree without
 * opening a socket, twice. bun completed it in seconds. The CLI already
 * requires bun to run at all, so this adds no precondition.
 */
export async function installHarness(dir: string, deps: DeepseekDeps): Promise<number> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pkg = join(dir, "package.json");
  if (!(await Bun.file(pkg).exists())) {
    await Bun.write(pkg, `${JSON.stringify({ name: "suite-deepseek", private: true, type: "module" }, null, 2)}\n`);
  }
  deps.stderr.write(`suite: installing the DeepSeek Harness into ${dir}\n`);
  return await deps.run([bunPath(deps), "add", ...DSH_PACKAGES], { cwd: dir });
}

/**
 * How to invoke this CLI again as a child.
 *
 * Prefers the installed `suite` launcher when there is one — it is on PATH,
 * survives `suite update`, and is what a human would type. Falls back to the
 * running interpreter plus this module's entry point, which is what a checkout
 * needs.
 */
export function selfArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const lib = env.SUITE_LIB_DIR;
  if (lib !== undefined && lib !== "") return [process.execPath, join(lib, "src", "cli.ts")];
  return [process.execPath, join(import.meta.dir, "..", "cli.ts")];
}

/**
 * The bun to install with.
 *
 * NOT the bare name `bun`. This CLI is run by a service manager often enough
 * that a login shell's PATH is the exception, not the rule — and a bare-name
 * spawn fails there with ENOENT, several frames from anything that mentions
 * PATH. `process.execPath` is the interpreter already running this code, so it
 * exists by construction; `which` is consulted only for the odd case of being
 * executed by something other than bun.
 */
export function bunPath(deps: Pick<DeepseekDeps, "which">): string {
  return process.execPath !== "" ? process.execPath : (deps.which("bun") ?? "bun");
}

/**
 * Candidate locations for this CLI's own files, in order.
 *
 * The shell wrapper exports `SUITE_LIB_DIR` at install time, so that wins. But
 * it is an environment variable, which means it can be stale or inherited from
 * a different install while the code actually running came from a checkout —
 * exactly what happens when a developer runs `bun src/cli.ts`. So the checkout
 * relative to this module is a real candidate, not a fallback that only
 * applies when the variable is unset.
 */
export function libDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const checkout = join(import.meta.dir, "..", "..");
  return env.SUITE_LIB_DIR === undefined || env.SUITE_LIB_DIR === checkout
    ? [checkout]
    : [env.SUITE_LIB_DIR, checkout];
}

/**
 * Copy the federation plugin out of this CLI and into the harness directory.
 *
 * It is COPIED rather than referenced in place because the patch must name it
 * by an absolute literal path (rule 3), and a path inside a CLI install that
 * `suite update` replaces is not a stable one. Copying on every run also means
 * upgrading the CLI upgrades the plugin, with no separate publish step —
 * which is the whole reason the plugin ships in here rather than on a registry.
 */
export async function materializePlugin(harness: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates = libDirCandidates(env).map((dir) => join(dir, "assets", "dsh-plugins", "suite-federation"));
  let source: string | undefined;
  for (const dir of candidates) {
    if (await Bun.file(join(dir, "index.js")).exists()) {
      source = dir;
      break;
    }
  }
  if (source === undefined) {
    // Name every place looked at. "file missing" plus one path invites the
    // reader to fix the wrong path when the other candidate was the live one.
    throw new Error(`suite: the bundled federation plugin was not found. Looked in:\n  ${candidates.join("\n  ")}`);
  }
  const target = join(harness, "plugins", "suite-federation");
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of ["index.js", "package.json"]) {
    await Bun.write(join(target, file), Bun.file(join(source, file)));
  }
  return join(target, "index.js");
}

/**
 * Everything the child needs that is NOT secret. Kept separate from the
 * secret env so a future logging line cannot print the wrong map.
 */
export function publicEnv(
  config: SuiteConfig,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    SUITE_WS_URL: runtimeWsUrl(config.suiteUrl),
    SUITE_MCP_URL: mcpUrl(config, env),
    SUITE_RUNTIME_ID: config.runtimeId,
    DSH_HOME: join(root, ".dsh"),
    DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE ?? "workspace-write",
  };
}

/** The secret env: the one token, plus each operator header's value. */
export function secretEnv(config: SuiteConfig, store: CredentialStore): Record<string, string> {
  const out: Record<string, string> = {};
  const token = store.get(TOKEN_KEY);
  if (token !== undefined) out.SUITE_RUNTIME_TOKEN = token;
  for (const name of config.headerNames) {
    const value = store.get(name);
    if (value !== undefined && value !== "") out[envNameForHeader(name)] = value;
  }
  return out;
}

/**
 * Run the verb.
 *
 * Returns a nonzero exit code with a named precondition rather than starting a
 * process that will fail opaquely twenty seconds later inside a reconnect loop.
 */
export async function runDeepseek(args: string[], deps: DeepseekDeps): Promise<number> {
  const options = parseDeepseekOptions(args);

  // A machine hosts more than one agent. `suite claude` federates the BOX, so
  // the machine config names one runtime; a second agent on the same box would
  // have to overwrite it. So an agent root may carry its own config, and when
  // it does it wins outright rather than merging — a half-inherited identity
  // is how an agent ends up connecting as its neighbour.
  //
  // WHICH ROOT. `--root` wins. Otherwise the directory the verb was run from
  // is the root when it carries its own suite.json — `cd ~/agents/oddjob &&
  // suite deepseek` is how a human reaches an agent, the same way `suite
  // claude` keys off the cwd. Only the cwd itself counts: an ancestor of an
  // agent root is not that agent.
  const explicitRoot = options.root ?? cwdAgentRoot(deps.cwd?.() ?? process.cwd());
  const rootConfig = explicitRoot === undefined ? null : await readAgentConfig(explicitRoot);
  let config = rootConfig ?? (await readConfig());
  // REF MODE IS NOT SUPPORTED HERE YET (a named follow-up): dsh reads its token
  // from SUITE_RUNTIME_TOKEN in its environment, so honouring a ref would mean
  // resolving it into a long-lived child's env. Refused with exit 2 rather
  // than done quietly.
  if (config?.tokenRef !== undefined && config.tokenRef !== "") {
    deps.stderr.write(
      `suite deepseek: token_ref_unsupported: this connection uses the token ref ${config.tokenRef}, ` +
        "and suite deepseek does not support token refs yet (follow-up). Connect this agent with its own " +
        `${AGENT_CONFIG_FILE} and credentials, or use suite claude, codex, hermes or openclaw.\n`,
    );
    return TOKEN_REF_UNSUPPORTED_EXIT;
  }
  // NO CHICKEN AND EGG: on a machine with no saved connection, a terminal user
  // is asked for it here — URL, runtime id, token — exactly as `suite init`
  // would, and it is saved for next time. Off a terminal there is nobody to
  // ask, so the refusal below stands.
  const prompter = deps.prompter;
  const interactive = prompter !== undefined && deps.isTTY();
  if (rootConfig === null && !hasConnection(config) && interactive) {
    const say = (line: string) => deps.stderr.write(`${line}\n`);
    config = (await ensureConnection({ env: process.env, prompter, store: createStore(), out: say })).config;
  }
  if (config === null || config.suiteUrl === "" || config.runtimeId === "") {
    deps.stderr.write(
      explicitRoot === undefined
        ? "suite: this machine is not connected to Suite yet, and there is no terminal to ask in.\n" +
            "suite: run `suite init` (or this command from a terminal, which asks for the connection),\n" +
            `suite: or run this from an agent folder that has its own ${AGENT_CONFIG_FILE} (or pass --root).\n`
        : `suite: no Suite config found. Run \`suite init\`, or put one at ${join(explicitRoot, AGENT_CONFIG_FILE)}\n`,
    );
    return 1;
  }

  const store = createStore({ token: "", headers: {} });
  const credentials =
    rootConfig === null
      ? await loadCredentials(config, deps)
      : await loadAgentCredentials(explicitRoot as string, config);
  for (const [key, value] of Object.entries(credentials)) store.set(key, value);
  if (store.get(TOKEN_KEY) === undefined && rootConfig === null && interactive) {
    // A machine connected by an older CLI never saved its token. Ask for it
    // once — URL and runtime id are already known — and save it.
    const say = (line: string) => deps.stderr.write(`${line}\n`);
    config = await ensureToken({ env: process.env, prompter, store, out: say }, config);
  }
  if (store.get(TOKEN_KEY) === undefined) {
    deps.stderr.write("suite: no runtime token found. Run `suite init` to capture one.\n");
    return 1;
  }

  const name = agentNameFromRuntimeId(config.runtimeId);
  const root = explicitRoot ?? agentRoot(name);

  // The agent's own environment: its model provider, model and key. Secret
  // values are registered in the store BEFORE any argv is checked, so the
  // guards below cover them exactly as they cover the runtime token.
  const agentEnv = await readAgentEnv(root);
  for (const [key, value] of Object.entries(agentEnv.secret)) store.set(`env:${key}`, value);
  const harness = harnessDir();

  if (!(await harnessInstalled(harness))) {
    const code = await installHarness(harness, deps);
    if (code !== 0 || !(await harnessInstalled(harness))) {
      deps.stderr.write("suite: installing the DeepSeek Harness failed.\n");
      return code === 0 ? 1 : code;
    }
  }

  await mkdir(join(root, ".dsh"), { recursive: true, mode: 0o700 });

  let pluginPath: string;
  try {
    pluginPath = await materializePlugin(harness);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const patchPath = join(root, ".dsh", "suite.patch.yml");
  await Bun.write(patchPath, renderPatch(pluginPath, config.headerNames));

  // The headless profile's startup plugin requires a task even though the
  // one-shot runner that consumes it is disabled. Supplying one keeps a
  // spurious "a task is required" line out of the service log; nothing runs
  // it, because the runner it feeds never mounts.
  const rest = options.rest.length > 0 ? options.rest : [IDLE_TASK];
  const argv = [
    join(harness, "node_modules", ".bin", "dsh"),
    "--profile",
    "headless",
    "--patch",
    patchPath,
    ...rest,
  ];
  assertNoSecretsInArgv(argv, store);

  // Precedence: the agent's own declaration beats both the inherited
  // environment and this CLI's defaults (e.g. DSH_PERMISSION_MODE's
  // `workspace-write`). The tmux child does not see the caller's shell
  // anyway, so "caller wins" would differ between the two launch paths.
  const env = {
    ...process.env,
    ...publicEnv(config, root),
    ...agentEnv.public,
    ...secretEnv(config, store),
    ...agentEnv.secret,
  } as Record<string, string>;
  const provider = env.DSH_PROVIDER ?? "openrouter";
  if (provider === "openrouter" && (env.OPENROUTER_API_KEY ?? "") === "") {
    // Named, not silent: without it the agent connects, joins, takes work and
    // fails every turn with MISSING_CREDENTIAL.
    deps.stderr.write(
      `suite: OPENROUTER_API_KEY is not set; declare it under "env" in ${join(root, AGENT_STATE_FILE)}.\n` +
        "suite: the agent will connect and then fail every turn with MISSING_CREDENTIAL.\n",
    );
  }

  // `--no-session` is what a service manager uses: systemd wants the harness
  // in the foreground of the unit it supervises, not handed to a terminal
  // multiplexer it cannot see into.
  if (options.noSession) return await deps.exec(argv, { cwd: root, env });

  // WHAT TMUX RUNS IS THIS CLI AGAIN, NOT dsh.
  //
  // `composeNewSession` refuses secrets in argv, and it is right to. dsh takes
  // its credentials from the ENVIRONMENT, and a tmux session created against
  // an already-running server does not inherit the caller's environment — so
  // handing tmux the dsh argv produces a session that boots without a token,
  // dies immediately, and takes the session with it. That is exactly what it
  // did the first time.
  //
  // Re-entering the CLI with `--no-session` sidesteps both: the child re-reads
  // the config and the 0600 credential file itself, so nothing secret is ever
  // in an argv or in tmux's environment.
  const relaunch = [...selfArgv(), "deepseek", "--root", root, "--no-session", ...options.rest];
  return await runInSession(sessionNameForAgent(name), relaunch, root, env, store, deps, { tmux: deps.tmux });
}

/**
 * The agent root the cwd names, if any: the cwd itself when it holds a
 * suite.json, otherwise undefined. Deliberately not a walk up the tree.
 */
export function cwdAgentRoot(cwd: string): string | undefined {
  return existsSync(join(cwd, AGENT_CONFIG_FILE)) ? cwd : undefined;
}

/** A `DSH_` name that nonetheless looks like a credential is treated as one. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export interface AgentEnv {
  /** Plain `DSH_` settings (provider, model, permission mode). Not secret. */
  public: Record<string, string>;
  /** Everything else (`*_API_KEY`, `*_KEY`, ...). Environment only, never argv. */
  secret: Record<string, string>;
}

/**
 * The `env` block of an agent root's .suite-state.json.
 *
 * This is where a root declares its MODEL credential, which is a different
 * thing from its Suite one: the runtime token authenticates the agent to
 * Suite; OPENROUTER_API_KEY authenticates it to whoever serves the model.
 * Reading only `token` and `headers` produced an agent that connected,
 * joined, took a dispatch and failed every turn with MISSING_CREDENTIAL.
 *
 * Names pass through verbatim: the generated patch's `apiKeyEnv` resolves
 * the exact name. Empty and non-string values are dropped.
 */
export async function readAgentEnv(root: string): Promise<AgentEnv> {
  const out: AgentEnv = { public: {}, secret: {} };
  const file = Bun.file(join(root, AGENT_STATE_FILE));
  if (!(await file.exists())) return out;
  const raw = (await file.json()) as { env?: Record<string, unknown> };
  for (const [name, value] of Object.entries(raw.env ?? {})) {
    if (typeof value !== "string" || value === "") continue;
    const isPlainSetting = name.startsWith("DSH_") && !SECRET_NAME.test(name);
    (isPlainSetting ? out.public : out.secret)[name] = value;
  }
  return out;
}

/**
 * Start the harness inside a tmux session, or attach to the one already
 * running it.
 *
 * WHY A SESSION AT ALL. Without one the harness is a child of whatever shell
 * started it: closing the terminal kills the agent, and a second person cannot
 * see what it is doing. `suite claude` solved this with tmux and this verb
 * uses the same mechanism deliberately — one persistence story for both agent
 * kinds, and `tmux ls` shows them side by side.
 *
 * A STALE SESSION IS NOT A LIVE ONE. `detectState` distinguishes a session
 * whose harness is still running from one whose pane is sitting at a dead
 * shell. Attaching to the second looks like the agent hanging, so it is
 * recycled rather than joined — the same three-way handling `suite claude`
 * documents at length.
 */
export interface SessionOptions {
  /** The program name `detectState` looks for in the pane's process tree. */
  agentName?: string;
  /** Injected in tests; defaults to the live tmux on `env`. */
  tmux?: TmuxDeps;
  /** Called with the exact `tmux new-session` argv once a session was created. */
  onCreated?(createArgv: string[]): void;
  /**
   * Whether the roster records this session as launched. tmux reports `none`
   * for an agent that died with its pane (the server exits with its last
   * session), and `suite status` calls that `stale`; the relaunch then says so
   * rather than announcing a first start.
   */
  wasRecorded?(): boolean;
}

export async function runInSession(
  session: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  store: CredentialStore,
  deps: Pick<DeepseekDeps, "isTTY" | "exec" | "stderr">,
  options: SessionOptions = {},
): Promise<number> {
  const tmux: TmuxDeps = options.tmux ?? liveTmuxDeps(env);

  if (tmux.which(TMUX) === null) {
    // Never silently: losing persistence is exactly the kind of downgrade that
    // is invisible until the terminal closes and the agent goes with it.
    deps.stderr.write(
      "suite: tmux is not installed, so this agent will not survive its terminal.\n" +
        "suite: install tmux to keep it running, or pass --no-session to silence this.\n",
    );
    return await deps.exec(argv, { cwd, env });
  }

  const state = await detectState(session, tmux, options.agentName ?? "dsh");

  if (state === "stale") {
    deps.stderr.write(`suite: recycling stale session ${session}\n`);
    await tmux.run([TMUX, "kill-session", "-t", session]);
  } else if (state === "none" && options.wasRecorded?.() === true) {
    deps.stderr.write(`suite: previous session ${session} was stale (recorded, no longer running); relaunching\n`);
  }

  if (state !== "live") {
    const create = composeNewSession({ session, command: argv, cwd }, store);
    const created = await tmux.run(create);
    if (created.exitCode !== 0) {
      deps.stderr.write(`suite: tmux could not create ${session}: ${created.stderr.trim()}\n`);
      return created.exitCode;
    }
    deps.stderr.write(`suite: started ${session}\n`);
    options.onCreated?.(create);
  } else {
    deps.stderr.write(`suite: attaching to ${session}\n`);
  }

  // NOT A TERMINAL — create and leave. A service manager starting this agent
  // has no TTY to attach to, and `tmux attach` without one fails with "open
  // terminal failed", which systemd would report as the agent crashing. The
  // session is what matters: it outlives this process and a human can join it
  // later with the same command. Returning here is the difference between an
  // agent you can look in on and one you can only read logs from.
  if (!deps.isTTY()) {
    deps.stderr.write(`suite: ${session} is running detached — attach with the same command from a terminal\n`);
    return 0;
  }

  const enter = nestingPlan(session, env);
  if (enter.kind === "refuse") {
    deps.stderr.write(`${enter.message}\n`);
    return 1;
  }
  return await deps.exec(enter.argv, { cwd, env });
}

/**
 * Read the credentials this verb needs.
 *
 * Separated so the run path above has one place to fail on a missing token
 * rather than three.
 */
export async function loadCredentials(
  config: SuiteConfig,
  _deps: DeepseekDeps,
  resolveDeps?: ResolveDeps,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // REF MODE (`suite init --token-ref`): the token is resolved IN MEMORY, every
  // time, and never saved. A keychain that does not answer throws a
  // StampFailure (exit 3) naming the item, never a value.
  if (config.tokenRef !== undefined && config.tokenRef !== "") {
    out[TOKEN_KEY] = await resolveTokenRef(parseTokenRef(config.tokenRef, { keychainService: config.keychainService }), resolveDeps);
    const saved = config.headerNames.length > 0 ? readCredentials() : null;
    for (const name of config.headerNames) {
      const value = saved?.headers[name];
      if (value !== undefined && value !== "") out[name] = value;
    }
    return out;
  }
  // `suite init --token-from-env VAR`: the token is in the environment only.
  const fromEnv = config.tokenEnv === undefined ? undefined : process.env[config.tokenEnv];
  // What `suite init` (or an inline connection) saved, beside config.json.
  const saved = readCredentials();
  if (saved !== null) {
    if (saved.token !== "") out[TOKEN_KEY] = saved.token;
    for (const name of config.headerNames) {
      const value = saved.headers[name];
      if (value !== undefined && value !== "") out[name] = value;
    }
  }
  if (fromEnv !== undefined && fromEnv !== "") out[TOKEN_KEY] = fromEnv;
  if (out[TOKEN_KEY] !== undefined) return out;
  return { ...(await loadLegacyState(config)), ...out };
}

/** The pre-credentials.json location: `token` / `headers` in state.json. */
async function loadLegacyState(config: SuiteConfig): Promise<Record<string, string>> {
  const { statePath } = await import("../paths.ts");
  const file = Bun.file(statePath());
  if (!(await file.exists())) return {};
  const raw = (await file.json()) as { token?: string; headers?: Record<string, string> };
  const out: Record<string, string> = {};
  if (typeof raw.token === "string" && raw.token !== "") out[TOKEN_KEY] = raw.token;
  for (const name of config.headerNames) {
    const value = raw.headers?.[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  return out;
}

/**
 * Read an agent root's own config, if it has one.
 *
 * Returns null rather than throwing on absence: most roots will not have one,
 * and "no per-agent config" is the ordinary case, not an error.
 */
export async function readAgentConfig(root: string): Promise<SuiteConfig | null> {
  const file = Bun.file(join(root, AGENT_CONFIG_FILE));
  if (!(await file.exists())) return null;
  const { parseConfig } = await import("../config.ts");
  return parseConfig(await file.text());
}

/** Read an agent root's own credentials. Same shape as the machine state. */
export async function loadAgentCredentials(root: string, config: SuiteConfig): Promise<Record<string, string>> {
  const file = Bun.file(join(root, AGENT_STATE_FILE));
  if (!(await file.exists())) return {};
  const raw = (await file.json()) as { token?: string; headers?: Record<string, string> };
  const out: Record<string, string> = {};
  if (typeof raw.token === "string" && raw.token !== "") out[TOKEN_KEY] = raw.token;
  for (const name of config.headerNames) {
    const value = raw.headers?.[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  return out;
}

export function liveDeepseekDeps(): DeepseekDeps {
  return {
    which: (bin) => Bun.which(bin),
    isTTY: () => process.stdout.isTTY === true,
    run: async (argv, opts) => {
      const proc = Bun.spawn(argv, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdout: "inherit", stderr: "inherit" });
      return await proc.exited;
    },
    // Forwards SIGTERM/SIGHUP (and SIGINT without a terminal) to the child and
    // waits for it: a signalled wrapper must not leave the harness orphaned.
    exec: async (argv, opts) => await runForwardingSignals(argv, { cwd: opts.cwd, env: opts.env }),
    stderr: process.stderr,
    prompter: ttyPrompter(),
  };
}
