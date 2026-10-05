/**
 * `suite codex` — run a Codex agent federated into Startup Suite, through
 * `codex app-server` (JSON-RPC over stdio), under the same tmux / watchdog /
 * restore supervision as `suite claude`.
 *
 * Two processes, one verb:
 *
 *   suite codex                 (outer) connection, login, then tmux
 *     └ suite codex --no-session (in the pane) the bridge: runtime socket ⇄ app-server
 *         └ codex app-server     with the Suite MCP servers as `-c` overrides
 *             └ suite codex --reply-mcp   the `suite-channel` MCP server (suite_reply …)
 *
 * FOUR RULES:
 *
 *  1. CODEX OWNS ITS LOGIN. When Codex is not logged in, the outer process
 *     runs `codex login --device-auth` in the terminal — Codex's own flow, a
 *     code to enter on another device, so it works over ssh — and this CLI
 *     never sees a token. ChatGPT subscription login is that flow's default.
 *     Off a terminal there is nobody to enter the code, so it refuses and says
 *     how to log in.
 *  2. THE AGENT'S CODEX HOME. `CODEX_HOME` defaults to `<root>/.codex`, not
 *     `~/.codex`: the agent's login, threads and config are the agent's, and a
 *     person's own Codex sessions on the same account never mix with it.
 *     `--codex-home DIR` points elsewhere deliberately.
 *  3. MCP BY OVERRIDE, NOT BY EDITING CONFIG. The Suite servers are passed as
 *     `-c mcp_servers.…` on the app-server argv, so nothing is written into
 *     any config.toml and nothing outlives the process. The runtime token
 *     reaches Codex only as the environment variable its
 *     `bearer_token_env_var` names — Codex's one route for an MCP bearer token —
 *     and never in an argv (asserted).
 *  4. THE SAME SESSION MACHINERY. tmux session `suite-<agent>`, recorded for
 *     `suite restore`, watchdog ensured on create; `--no-session` is what the
 *     pane and a service manager run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, type SuiteConfig } from "../config.ts";
import { createStore, TOKEN_KEY, assertNoSecretsInArgv, ttyPrompter, type Prompter } from "../secrets.ts";
import { ensureConnection, ensureToken, hasConnection } from "../connection.ts";
import { harnessChildEnv } from "../harness_env.ts";
import { nameDigest, type TmuxDeps } from "../tmux.ts";
import { channelWsUrl, toolsHttpUrl } from "./init.ts";
import { agentNameFromRuntimeId, liveDeepseekDeps, loadCredentials, runInSession, selfArgv, sessionNameForAgent, type DeepseekDeps } from "./deepseek.ts";
import { liveRestoreDeps, loadRoster, recordLaunch, type RestoreDeps } from "./restore.ts";
import { ensureSupervision, liveSupervisorIo, type SupervisorIo } from "../supervisor.ts";
import { VERSION } from "../version.ts";
import { StampFailure } from "../stamp_result.ts";
import type { ResolveDeps } from "../token_ref.ts";
import { AppServerClient, processTransport } from "../codex/app_server.ts";
import { CodexBridge, type ApprovalPolicy } from "../codex/bridge.ts";
import { PhoenixChannel, socketUrl, type SocketLike } from "../codex/phoenix.ts";
import { BRIDGE_SOCKET_ENV, listenBridgeSocket, runReplyMcp } from "../codex/reply_mcp.ts";
import type { InitializeResponse, SandboxMode } from "../codex/protocol.ts";

export const AGENT = "codex";
export const CODEX_INSTALL_HINT = "install it with `npm install -g @openai/codex` (or see https://github.com/openai/codex)";
export const MISSING_CODEX_EXIT = 4;
export const NOT_LOGGED_IN_EXIT = 7;

/** The env var Codex reads the Suite MCP bearer token from (rule 3). Not SUITE_*: see harness_env.ts. */
export const MCP_TOKEN_ENV = "CODEX_SUITE_MCP_BEARER";
/** Env vars carrying the operator's extra headers, one per configured header name. */
export const headerEnvName = (i: number): string => `CODEX_SUITE_MCP_HEADER_${i}`;

export const TOOLS_MCP = "startup-suite";
export const CHANNEL_MCP = "suite-channel";

const SANDBOXES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export interface CodexOptions {
  root?: string;
  noSession: boolean;
  replyMcp: boolean;
  approvals: ApprovalPolicy;
  sandbox: SandboxMode;
  codexHome?: string;
  codexBin?: string;
}

/**
 * Ours: `--root DIR`, `--no-session`, `--approvals accept|decline`,
 * `--sandbox MODE`, `--codex-home DIR`, `--codex BIN`, and the internal
 * `--reply-mcp`. Anything else is refused by name — a typo silently ignored
 * would be an agent running with a policy nobody chose.
 *
 * DEFAULTS: `--approvals accept --sandbox danger-full-access`, the parity of
 * `suite claude`'s `--dangerously-skip-permissions`: an agent nobody sits in
 * front of must not stop to ask. (Codex's workspace-write sandbox also needs
 * unprivileged user namespaces for bubblewrap, which not every host allows.)
 */
export function parseCodexOptions(args: string[]): CodexOptions {
  const out: CodexOptions = { noSession: false, replyMcp: false, approvals: "accept", sandbox: "danger-full-access" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--root") out.root = resolve(value());
    else if (a === "--no-session") out.noSession = true;
    else if (a === "--reply-mcp") out.replyMcp = true;
    else if (a === "--codex-home") out.codexHome = resolve(value());
    else if (a === "--codex") out.codexBin = value();
    else if (a === "--approvals") {
      const v = value();
      if (v !== "accept" && v !== "decline") throw new Error(`--approvals must be accept or decline, got ${v}`);
      out.approvals = v;
    } else if (a === "--sandbox") {
      const v = value() as SandboxMode;
      if (!SANDBOXES.includes(v)) throw new Error(`--sandbox must be one of ${SANDBOXES.join(", ")}, got ${v}`);
      out.sandbox = v;
    } else throw new Error(`unknown option ${a}`);
  }
  return out;
}

/** The agent name from the runtime id: a trailing `-codex` is the transport, not the agent. */
export function codexAgentName(runtimeId: string): string {
  return agentNameFromRuntimeId(runtimeId).replace(/-codex$/, "");
}

export function codexHomeFor(opts: Pick<CodexOptions, "codexHome">, root: string): string {
  return opts.codexHome ?? join(root, ".codex");
}

/**
 * Where the bridge's unix socket lives. NOT under the agent root: a unix
 * socket path is capped at ~104-108 bytes, and an agent root can be anywhere.
 * `$XDG_RUNTIME_DIR` is per-user and 0700 by spec; otherwise a 0700 directory
 * under the system tmpdir, named for the uid.
 */
export function bridgeSocketPath(root: string, env: Record<string, string | undefined>): string {
  const base = env.XDG_RUNTIME_DIR && env.XDG_RUNTIME_DIR !== "" ? env.XDG_RUNTIME_DIR : join(tmpdir(), `suite-codex-${process.getuid?.() ?? "u"}`);
  return join(base, `suite-codex-${nameDigest(resolve(root))}.sock`);
}

/** TOML literal for a `-c` value: JSON strings are valid TOML basic strings. */
const tomlString = (s: string): string => JSON.stringify(s);

/**
 * `codex app-server` with the two Suite MCP servers. Pure; holds no secret —
 * only the NAMES of the env vars that carry them.
 */
export function appServerArgv(input: {
  codexBin: string;
  suiteUrl: string;
  headerNames: string[];
  self: string[];
  socketPath: string;
}): string[] {
  const t = `mcp_servers.${TOOLS_MCP}`;
  const c = `mcp_servers.${CHANNEL_MCP}`;
  const headers = input.headerNames.map((name, i) => `${tomlString(name)}=${tomlString(headerEnvName(i))}`).join(",");
  const [cmd, ...cmdArgs] = input.self;
  return [
    input.codexBin,
    "app-server",
    "-c",
    `${t}.url=${tomlString(toolsHttpUrl(input.suiteUrl))}`,
    "-c",
    `${t}.bearer_token_env_var=${tomlString(MCP_TOKEN_ENV)}`,
    ...(input.headerNames.length > 0 ? ["-c", `${t}.env_http_headers={${headers}}`] : []),
    "-c",
    // Our own install's tools: approved the way a Claude agent's are, rather
    // than each call stopping for a human who is not there.
    `${t}.default_tools_approval_mode="approve"`,
    "-c",
    `${c}.command=${tomlString(cmd ?? "suite")}`,
    "-c",
    `${c}.args=[${[...cmdArgs, "codex", "--reply-mcp"].map(tomlString).join(",")}]`,
    "-c",
    `${c}.env={${BRIDGE_SOCKET_ENV}=${tomlString(input.socketPath)}}`,
    "-c",
    `${c}.default_tools_approval_mode="approve"`,
  ];
}

export interface CodexDeps {
  env: Record<string, string | undefined>;
  cwd(): string;
  isTTY(): boolean;
  which(bin: string): string | null;
  /** Run a child to completion with the terminal's stdio (login). */
  run(argv: string[], opts: { env: Record<string, string> }): Promise<number>;
  /** Run a child and capture its output (login status). */
  capture(argv: string[], opts: { env: Record<string, string> }): Promise<{ exitCode: number; stdout: string }>;
  stderr: { write(text: string): void };
  prompter?: Prompter;
  session: Pick<DeepseekDeps, "isTTY" | "exec" | "stderr">;
  tmux?: TmuxDeps;
  restore?: RestoreDeps;
  supervisorIo?: SupervisorIo;
  platform: string;
  /** The bridge, for `--no-session`. Injected so the command's tests never open a socket. */
  runBridge?(input: BridgeInput): Promise<number>;
  /** How a token ref is resolved (ref mode). Tests inject a fake `security`. */
  resolve?: ResolveDeps;
}

export interface BridgeInput {
  config: SuiteConfig;
  token: string;
  headers: Record<string, string>;
  root: string;
  codexHome: string;
  codexBin: string;
  approvals: ApprovalPolicy;
  sandbox: SandboxMode;
  env: Record<string, string | undefined>;
  log(line: string): void;
}

/** Codex's own environment: the allowlist plus its home. No Suite credential (that is added at spawn, see rule 3). */
export function codexEnv(env: Record<string, string | undefined>, codexHome: string): Record<string, string> {
  return harnessChildEnv(env, { CODEX_HOME: codexHome });
}

/** `codex login status` exits 0 when logged in, 1 when not (measured, codex-cli 0.159.2). */
export async function codexLoggedIn(deps: CodexDeps, codexBin: string, codexHome: string): Promise<boolean> {
  const r = await deps.capture([codexBin, "login", "status"], { env: codexEnv(deps.env, codexHome) });
  return r.exitCode === 0;
}

export async function runCodex(args: string[], deps: CodexDeps): Promise<number> {
  let opts: CodexOptions;
  try {
    opts = parseCodexOptions(args);
  } catch (error) {
    deps.stderr.write(`suite codex: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (opts.replyMcp) return await runReplyMcp(deps.env, VERSION);

  // The connection: the one `suite init` saved, or the init questions asked
  // right here from a terminal — the same as `suite claude`.
  let config = await readConfig({ env: deps.env });
  const interactive = deps.prompter !== undefined && deps.isTTY();
  const say = (line: string) => deps.stderr.write(`${line}\n`);
  if (!hasConnection(config) && interactive) {
    config = (await ensureConnection({ env: deps.env, prompter: deps.prompter as Prompter, store: createStore(), out: say })).config;
  }
  if (!hasConnection(config)) {
    deps.stderr.write(
      "suite codex: this machine is not connected to Suite yet, and there is no terminal to ask in.\n" +
        "suite codex: run `suite init`, or this command from a terminal.\n",
    );
    return 1;
  }
  const store = createStore();
  try {
    for (const [k, v] of Object.entries(await loadCredentials(config, {} as DeepseekDeps, deps.resolve))) store.set(k, v);
  } catch (error) {
    // A ref that does not resolve: the message names the ref, never a value.
    if (error instanceof StampFailure) {
      deps.stderr.write(`suite codex: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  if (config.tokenRef !== undefined && config.tokenRef !== "") {
    // Surfaced, never hidden: the bridge hands the resolved token to
    // `codex app-server` in its ENVIRONMENT (0.7.0 design). `suite status
    // --json` reports this agent as token_in_child_env: true.
    say(`suite codex: token ref ${config.tokenRef} resolved in memory; token_in_child_env: the codex app-server child receives it in its environment`);
  }
  if (store.get(TOKEN_KEY) === undefined && interactive) {
    config = await ensureToken({ env: deps.env, prompter: deps.prompter as Prompter, store, out: say }, config);
  }
  const token = store.get(TOKEN_KEY);
  if (token === undefined) {
    deps.stderr.write("suite codex: no runtime token found. Run `suite init` to capture one.\n");
    return 1;
  }

  const codexBin = opts.codexBin ?? deps.which(AGENT);
  if (codexBin === null) {
    deps.stderr.write(`suite codex: codex is not installed; ${CODEX_INSTALL_HINT}.\n`);
    return MISSING_CODEX_EXIT;
  }

  const root = opts.root ?? deps.cwd();
  const codexHome = codexHomeFor(opts, root);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  if (!(await codexLoggedIn(deps, codexBin, codexHome))) {
    if (opts.noSession || !deps.isTTY()) {
      deps.stderr.write(
        `suite codex: Codex is not logged in (CODEX_HOME=${codexHome}). Log in from a terminal with\n` +
          `suite codex:   CODEX_HOME=${codexHome} codex login --device-auth\n` +
          "suite codex: or run `suite codex` from a terminal, which runs that for you.\n",
      );
      return NOT_LOGGED_IN_EXIT;
    }
    deps.stderr.write(`suite codex: Codex is not logged in here (CODEX_HOME=${codexHome}). Starting Codex's own login — this CLI never sees the token.\n`);
    await deps.run([codexBin, "login", "--device-auth"], { env: codexEnv(deps.env, codexHome) });
    if (!(await codexLoggedIn(deps, codexBin, codexHome))) {
      deps.stderr.write("suite codex: still not logged in; stopping.\n");
      return NOT_LOGGED_IN_EXIT;
    }
  }

  const headers: Record<string, string> = {};
  for (const name of config.headerNames) {
    const v = store.get(name);
    if (v !== undefined) headers[name] = v;
  }

  if (opts.noSession) {
    const run = deps.runBridge ?? runBridge;
    return await run({
      config,
      token,
      headers,
      root,
      codexHome,
      codexBin,
      approvals: opts.approvals,
      sandbox: opts.sandbox,
      env: deps.env,
      log: (line) => deps.stderr.write(`suite codex: ${line}\n`),
    });
  }

  // WHAT TMUX RUNS IS THIS CLI AGAIN (see deepseek.ts): the pane re-reads the
  // 0600 credential file itself, so no secret is in an argv or tmux's env.
  const name = codexAgentName(config.runtimeId);
  const session = sessionNameForAgent(name);
  const relaunch = [
    ...selfArgv(deps.env as NodeJS.ProcessEnv),
    "codex",
    "--root",
    root,
    "--no-session",
    "--approvals",
    opts.approvals,
    "--sandbox",
    opts.sandbox,
    ...(opts.codexHome ? ["--codex-home", opts.codexHome] : []),
    ...(opts.codexBin ? ["--codex", opts.codexBin] : []),
  ];
  assertNoSecretsInArgv(relaunch, store);
  const home = deps.env.HOME ?? "";
  const sessionEnv = harnessChildEnv(deps.env, { TMUX: deps.env.TMUX });
  return await runInSession(session, relaunch, root, sessionEnv, store, deps.session, {
    agentName: AGENT,
    tmux: deps.tmux,
    onCreated: (createArgv) => {
      if (deps.restore) recordLaunch(deps.restore, home, { session, command: createArgv, cwd: root, kind: "codex" });
      if (deps.supervisorIo) {
        void ensureSupervision(deps.supervisorIo, {
          platform: deps.platform as NodeJS.Platform,
          home,
          binary: `${home}/.local/bin/suite`,
          inheritedPath: deps.env.PATH,
          inheritedLocale: deps.env.LANG ?? deps.env.LC_ALL,
          intervalSeconds: 60,
        }).then((sup) => deps.stderr.write(`suite codex: watchdog: ${sup.watchdog}\n`));
      }
    },
    wasRecorded: () => deps.restore !== undefined && loadRoster(deps.restore, home).some((e) => e.session === session),
  });
}

/* ------------------------------------------------------------------------- */
/* The bridge process (`--no-session`)                                        */
/* ------------------------------------------------------------------------- */

export const THREADS_FILE = "threads.json";

export function threadsPath(root: string): string {
  return join(root, ".suite-codex", THREADS_FILE);
}

export function loadThreads(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(threadsPath(root), "utf8")) as { threads?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.threads ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function saveThreads(root: string, threads: Record<string, string>): void {
  const p = threadsPath(root);
  mkdirSync(join(root, ".suite-codex"), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify({ version: 1, threads }, null, 2)}\n`);
}

/**
 * Connect everything and run until the app-server exits. Returns non-zero
 * then, so the pane ends and the next `suite codex` / `suite restore` brings
 * it back, rather than a bridge idling with no Codex behind it.
 */
export async function runBridge(input: BridgeInput): Promise<number> {
  const { config, log } = input;
  const socketPath = bridgeSocketPath(input.root, input.env);
  const self = selfArgv(input.env as NodeJS.ProcessEnv);
  const argv = appServerArgv({ codexBin: input.codexBin, suiteUrl: config.suiteUrl, headerNames: Object.keys(input.headers), self, socketPath });
  const secrets = createStore({ token: input.token, headers: input.headers });
  assertNoSecretsInArgv(argv, secrets);

  const env: Record<string, string> = { ...codexEnv(input.env, input.codexHome), [MCP_TOKEN_ENV]: input.token };
  Object.values(input.headers).forEach((v, i) => (env[headerEnvName(i)] = v));
  if (!existsSync(input.root)) mkdirSync(input.root, { recursive: true });

  const proc = Bun.spawn(argv, { cwd: input.root, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  let bridge: CodexBridge | null = null;
  const exited = new Promise<string>((resolveExit) => {
    const client = new AppServerClient(processTransport(proc), {
      onNotification: (m, p) => bridge?.onNotification(m, p),
      onRequest: async (m, p) => {
        if (bridge === null) throw new Error("bridge not ready");
        return await bridge.answerServerRequest(m, p);
      },
      onClose: (reason) => resolveExit(reason),
    });
    void (async () => {
      const init = await client.request<InitializeResponse>("initialize", {
        clientInfo: { name: "suite_codex", title: "Suite CLI", version: VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      client.notify("initialized");
      log(`codex app-server up (${init.userAgent}; CODEX_HOME ${init.codexHome})`);

      const channel = new PhoenixChannel({
        url: socketUrl(channelWsUrl(config.suiteUrl), { runtime_id: config.runtimeId, token: input.token }),
        topic: `runtime:${config.runtimeId}`,
        // `codex_channel` is not yet in core's list of client products, so core
        // records it as "unknown" until it is added there; declaring another
        // harness's name instead would misreport what is running.
        joinPayload: { client_info: { product: "codex_channel", version: VERSION, features: ["system_event_prompt"] } },
        socket: (url) => new WebSocket(url) as unknown as SocketLike,
        log,
      });
      bridge = new CodexBridge(channel, client, {
        cwd: input.root,
        approvals: input.approvals,
        sandbox: input.sandbox,
        log,
        loadThreads: () => loadThreads(input.root),
        saveThreads: (t) => saveThreads(input.root, t),
      });
      const b = bridge;
      await listenBridgeSocket(socketPath, (tool, args) => b.channelTool(tool, args), log);
      channel.connect();
    })().catch((error) => {
      log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
      client.close();
    });
  });
  const reason = await exited;
  log(`codex app-server exited (${reason}); stopping the bridge`);
  return 1;
}

export function liveCodexDeps(): CodexDeps {
  const session = liveDeepseekDeps();
  return {
    env: process.env,
    cwd: () => process.cwd(),
    isTTY: () => process.stdout.isTTY === true && process.stdin.isTTY === true,
    which: (bin) => Bun.which(bin),
    run: async (argv, opts) => await Bun.spawn(argv, { env: opts.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited,
    capture: async (argv, opts) => {
      const p = Bun.spawn(argv, { env: opts.env, stdout: "pipe", stderr: "pipe" });
      const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return { exitCode, stdout };
    },
    stderr: process.stderr,
    prompter: ttyPrompter(),
    session,
    restore: liveRestoreDeps(),
    supervisorIo: liveSupervisorIo(),
    platform: process.platform,
  };
}
