/**
 * The pieces of `suite codex` other than the bridge: the Phoenix client, the
 * suite-channel MCP server and its socket to the bridge, and the verb itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoenixChannel, redactUrl, socketUrl, type SocketLike } from "../src/codex/phoenix.ts";
import { handleMcpMessage, listenBridgeSocket, socketForwarder, TOOL_SPECS } from "../src/codex/reply_mcp.ts";
import {
  MCP_TOKEN_ENV,
  NOT_LOGGED_IN_EXIT,
  MISSING_CODEX_EXIT,
  appServerArgv,
  bridgeSocketPath,
  codexAgentName,
  parseCodexOptions,
  runCodex,
  type BridgeInput,
  type CodexDeps,
} from "../src/commands/codex.ts";
import { kindFromArgv, parseRoster, serializeRoster } from "../src/roster.ts";
import { writeAgentConnection } from "../src/agent_connections.ts";

const TMP = mkdtempSync(join(tmpdir(), "suite-codex-parts-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/* ------------------------------------------------------------------------- */
/* Phoenix                                                                    */
/* ------------------------------------------------------------------------- */

class FakeWs implements SocketLike {
  readyState = 0;
  sent: unknown[][] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSays(frame: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function phoenix() {
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const logs: string[] = [];
  const ch = new PhoenixChannel({
    url: socketUrl("wss://suite.example/runtime/ws", { runtime_id: "rt-1", token: "s3cret" }),
    topic: "runtime:rt-1",
    joinPayload: { client_info: { product: "codex_channel" } },
    socket: () => {
      const s = new FakeWs();
      sockets.push(s);
      return s;
    },
    log: (l) => logs.push(l),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimer: () => {},
  });
  return { ch, sockets, timers, logs };
}

describe("phoenix client", () => {
  test("the URL is what the Phoenix JS client builds, and logs never carry the token", () => {
    const url = socketUrl("wss://suite.example/runtime/ws", { runtime_id: "rt-1", token: "s3cret" });
    expect(url).toBe("wss://suite.example/runtime/ws/websocket?runtime_id=rt-1&token=s3cret&vsn=2.0.0");
    expect(redactUrl(url)).not.toContain("s3cret");
    const p = phoenix();
    p.ch.connect();
    expect(p.logs.join("\n")).not.toContain("s3cret");
  });

  test("joins on open, delivers topic events after an ok reply, and pushes with join_ref", async () => {
    const p = phoenix();
    const got: unknown[] = [];
    p.ch.on("attention", (x) => got.push(x));
    p.ch.connect();
    const ws = p.sockets[0]!;
    ws.open();
    expect(ws.sent[0]).toEqual(["1", "1", "runtime:rt-1", "phx_join", { client_info: { product: "codex_channel" } }]);
    ws.serverSays(["1", "1", "runtime:rt-1", "phx_reply", { status: "ok", response: {} }]);
    expect(p.ch.isJoined).toBe(true);
    ws.serverSays([null, null, "runtime:rt-1", "attention", { signal: { space_id: "s" } }]);
    expect(got).toEqual([{ signal: { space_id: "s" } }]);

    const pushed = p.ch.push("reply", { space_id: "s", content: "hi" });
    expect(ws.sent[1]).toEqual(["1", "2", "runtime:rt-1", "reply", { space_id: "s", content: "hi" }]);
    ws.serverSays(["1", "2", "runtime:rt-1", "phx_reply", { status: "error", response: { error: "not_a_participant" } }]);
    expect(await pushed).toEqual({ status: "error", response: { error: "not_a_participant" } });
  });

  test("a push while not joined is dropped, not queued (no duplicate post after a reconnect)", async () => {
    const p = phoenix();
    p.ch.connect();
    expect(await p.ch.push("reply", {})).toEqual({ status: "dropped", response: {} });
    expect(p.sockets[0]!.sent).toEqual([]);
  });

  test("heartbeats on the phoenix topic; a close reconnects with backoff", () => {
    const p = phoenix();
    p.ch.connect();
    p.sockets[0]!.open();
    const beat = p.timers.find((t) => t.ms === 30_000)!;
    beat.fn();
    expect(p.sockets[0]!.sent.at(-1)?.slice(2)).toEqual(["phoenix", "heartbeat", {}]);
    p.sockets[0]!.close();
    const retry = p.timers.at(-1)!;
    expect(retry.ms).toBe(1000);
    retry.fn();
    expect(p.sockets.length).toBe(2);
  });

  test("a refused join closes the socket so the reconnect loop retries", () => {
    const p = phoenix();
    p.ch.connect();
    const ws = p.sockets[0]!;
    ws.open();
    ws.serverSays(["1", "1", "runtime:rt-1", "phx_reply", { status: "error", response: { reason: "unauthorized" } }]);
    expect(p.ch.isJoined).toBe(false);
    expect(ws.readyState).toBe(3);
    expect(p.logs.some((l) => l.includes("join refused"))).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* suite-channel MCP server                                                   */
/* ------------------------------------------------------------------------- */

describe("the suite-channel MCP server", () => {
  type Fwd = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  const io = (forward: Fwd = async () => ({ ok: true, text: "reply sent" })) => ({ write: () => {}, forward });

  test("offers the Claude channel plugin's tool names", async () => {
    const out = JSON.parse((await handleMcpMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', io(), "0"))!);
    expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual(["suite_reply", "suite_reply_with_media", "suite_typing", "suite_reply_chunk"]);
    expect(TOOL_SPECS[0].inputSchema.required).toEqual(["space_id", "content"]);
  });

  test("a call is forwarded and its result becomes the tool's text", async () => {
    const seen: unknown[] = [];
    const out = JSON.parse(
      (await handleMcpMessage(
        '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"suite_reply","arguments":{"space_id":"s","content":"hi"}}}',
        io(async (tool, args) => {
          seen.push([tool, args]);
          return { ok: true, text: "reply sent" };
        }),
        "0",
      ))!,
    );
    expect(seen).toEqual([["suite_reply", { space_id: "s", content: "hi" }]]);
    expect(out).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "reply sent" }], isError: false } });
  });

  test("an unreachable bridge is a tool error the model can read, not a crash", async () => {
    const out = JSON.parse(
      (await handleMcpMessage(
        '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"suite_typing","arguments":{}}}',
        io(async () => {
          throw new Error("ECONNREFUSED");
        }),
        "0",
      ))!,
    );
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain("not reachable");
  });

  test("notifications get no reply; unknown methods get -32601", async () => {
    expect(await handleMcpMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}', io(), "0")).toBeNull();
    expect(JSON.parse((await handleMcpMessage('{"jsonrpc":"2.0","id":2,"method":"resources/list"}', io(), "0"))!).error.code).toBe(-32601);
  });

  test("round trip over the real unix socket to a bridge handler", async () => {
    const path = join(TMP, "b.sock");
    const calls: unknown[] = [];
    const server = await listenBridgeSocket(
      path,
      async (tool, args) => {
        calls.push([tool, args]);
        return { ok: true, text: `${tool} ok` };
      },
      () => {},
    );
    const forward = socketForwarder(path);
    expect(await forward("suite_reply", { space_id: "s", content: "a" })).toEqual({ ok: true, text: "suite_reply ok" });
    expect(await forward("suite_typing", { space_id: "s", typing: true })).toEqual({ ok: true, text: "suite_typing ok" });
    expect(calls.length).toBe(2);
    server.close();
  });
});

/* ------------------------------------------------------------------------- */
/* The verb                                                                   */
/* ------------------------------------------------------------------------- */

describe("suite codex options and argv", () => {
  test("defaults match suite claude's unattended posture; typos are refused", () => {
    expect(parseCodexOptions([])).toEqual({ noSession: false, replyMcp: false, approvals: "accept", sandbox: "danger-full-access" });
    expect(() => parseCodexOptions(["--approval", "accept"])).toThrow("unknown option --approval");
    expect(() => parseCodexOptions(["--approvals", "maybe"])).toThrow();
    expect(() => parseCodexOptions(["--sandbox", "yolo"])).toThrow();
  });

  test("the agent name drops a -codex transport suffix", () => {
    expect(codexAgentName("oddjob-codex")).toBe("oddjob");
  });

  test("the app-server argv names the token's env var, never the token, and wires both MCP servers", () => {
    const argv = appServerArgv({
      codexBin: "/usr/bin/codex",
      suiteUrl: "https://suite.example",
      headerNames: ["X-Proxy-Id"],
      self: ["/usr/bin/bun", "/opt/suite/src/cli.ts"],
      socketPath: "/run/user/1000/suite-codex-ab.sock",
    });
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/codex", "app-server"]);
    const c = argv.filter((_, i) => argv[i - 1] === "-c");
    expect(c).toEqual([
      'mcp_servers.startup-suite.url="https://suite.example/mcp"',
      `mcp_servers.startup-suite.bearer_token_env_var="${MCP_TOKEN_ENV}"`,
      'mcp_servers.startup-suite.env_http_headers={"X-Proxy-Id"="CODEX_SUITE_MCP_HEADER_0"}',
      'mcp_servers.startup-suite.default_tools_approval_mode="approve"',
      'mcp_servers.suite-channel.command="/usr/bin/bun"',
      'mcp_servers.suite-channel.args=["/opt/suite/src/cli.ts","codex","--reply-mcp"]',
      'mcp_servers.suite-channel.env={SUITE_CODEX_BRIDGE_SOCKET="/run/user/1000/suite-codex-ab.sock"}',
      'mcp_servers.suite-channel.default_tools_approval_mode="approve"',
    ]);
  });

  test("the bridge socket path stays short wherever the agent root is", () => {
    const deep = `/${"very-long-directory-name/".repeat(10)}agent`;
    expect(bridgeSocketPath(deep, { XDG_RUNTIME_DIR: "/run/user/1000" }).length).toBeLessThan(100);
  });

  test("a codex relaunch argv is recognised for restore adoption, and the roster keeps the kind", () => {
    expect(kindFromArgv(["/usr/bin/bun", "/opt/suite/src/cli.ts", "codex", "--root", "/a", "--no-session"])).toBe("codex");
    const text = serializeRoster([{ session: "suite-x", command: ["tmux"], cwd: "/a", kind: "codex", recordedAt: "" }]);
    expect(parseRoster(text)[0]?.kind).toBe("codex");
  });
});

/** Fake deps with a saved connection in a throwaway XDG config dir. */
async function deps(over: Partial<CodexDeps> & { loggedIn?: boolean[]; tty?: boolean } = {}) {
  const home = mkdtempSync(join(TMP, "home-"));
  const cfgDir = join(home, ".config", "suite");
  // The agent folder's own saved connection (agent_connections.ts), keyed by the cwd below.
  mkdirSync(join(home, "agent"), { recursive: true });
  writeAgentConnection(
    { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    join(home, "agent"),
    { suiteUrl: "https://suite.example", runtimeId: "oddjob-codex", headerNames: [] },
    { token: "tok-123", headers: {} },
  );
  const loggedIn = [...(over.loggedIn ?? [true])];
  const ran: { argv: string[]; env: Record<string, string> }[] = [];
  const bridges: BridgeInput[] = [];
  const err: string[] = [];
  const env = { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: join(home, ".config") };
  // credentials.json is read from process.env by the shared loader; point it here.
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  const d: CodexDeps = {
    env,
    cwd: () => join(home, "agent"),
    isTTY: () => over.tty ?? false,
    which: (b) => (b === "codex" ? "/usr/bin/codex" : null),
    run: async (argv, o) => {
      ran.push({ argv, env: o.env });
      return 0;
    },
    capture: async () => ({ exitCode: (loggedIn.length > 1 ? loggedIn.shift() : loggedIn[0]) ? 0 : 1, stdout: "" }),
    stderr: { write: (t) => void err.push(t) },
    session: { isTTY: () => false, exec: async () => 0, stderr: { write: (t: string) => void err.push(t) } },
    platform: "linux",
    runBridge: async (input) => {
      bridges.push(input);
      return 0;
    },
    ...over,
  };
  return { d, ran, bridges, err, home };
}

describe("suite codex: login and launch", () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("codex missing: exit 4 with an install hint", async () => {
    const t = await deps({ which: () => null });
    expect(await runCodex(["--no-session"], t.d)).toBe(MISSING_CODEX_EXIT);
    expect(t.err.join("")).toContain("npm install -g @openai/codex");
  });

  test("not logged in and no terminal: refuses with the command, never starts a login", async () => {
    const t = await deps({ loggedIn: [false] });
    expect(await runCodex([], t.d)).toBe(NOT_LOGGED_IN_EXIT);
    expect(t.ran).toEqual([]);
    expect(t.err.join("")).toContain("codex login --device-auth");
  });

  test("not logged in at a terminal: runs Codex's own device login under the agent's CODEX_HOME", async () => {
    // The OUTER process logs in (the pane's --no-session never prompts). No
    // tmux here, so the session step falls back to a plain exec.
    const t = await deps({
      loggedIn: [false, true],
      tty: true,
      prompter: { ask: async () => "", askSecret: async () => "", say: () => {} },
      tmux: { env: {}, which: () => null, run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    });
    expect(await runCodex([], t.d)).toBe(0);
    expect(t.ran.length).toBe(1);
    expect(t.ran[0]!.argv).toEqual(["/usr/bin/codex", "login", "--device-auth"]);
    expect(t.ran[0]!.env.CODEX_HOME).toBe(join(t.home, "agent", ".codex"));
    // Codex's login child gets no Suite credential.
    expect(Object.values(t.ran[0]!.env)).not.toContain("tok-123");
  });

  test("--no-session hands the bridge the saved connection and the policy", async () => {
    const t = await deps();
    expect(await runCodex(["--no-session", "--approvals", "decline", "--sandbox", "workspace-write"], t.d)).toBe(0);
    expect(t.bridges[0]).toMatchObject({
      token: "tok-123",
      root: join(t.home, "agent"),
      codexHome: join(t.home, "agent", ".codex"),
      codexBin: "/usr/bin/codex",
      approvals: "decline",
      sandbox: "workspace-write",
    });
    expect(t.bridges[0]!.config.runtimeId).toBe("oddjob-codex");
  });

  test("without --no-session: a tmux session suite-<agent> running this CLI again, recorded for restore", async () => {
    const tmuxCalls: string[][] = [];
    const roster: string[] = [];
    const t = await deps({
      tmux: {
        env: {},
        which: (n) => `/usr/bin/${n}`,
        run: async (argv) => {
          tmuxCalls.push(argv);
          return { exitCode: argv[1] === "list-panes" ? 1 : 0, stdout: "", stderr: "" };
        },
      },
    });
    t.d.restore = {
      tmux: t.d.tmux!,
      readRoster: () => null,
      writeRoster: (_p, c) => void roster.push(c),
      now: () => new Date(0),
      log: () => {},
    };
    expect(await runCodex(["--approvals", "decline"], t.d)).toBe(0);
    const create = tmuxCalls.find((a) => a.includes("new-session"))!;
    expect(create).toContain("suite-oddjob");
    const tail = create.slice(create.indexOf("codex"));
    expect(tail).toEqual(["codex", "--root", join(t.home, "agent"), "--no-session", "--approvals", "decline", "--sandbox", "danger-full-access"]);
    expect(create.join(" ")).not.toContain("tok-123");
    expect(JSON.parse(roster[0]!).agents[0]).toMatchObject({ session: "suite-oddjob", kind: "codex" });
  });
});
