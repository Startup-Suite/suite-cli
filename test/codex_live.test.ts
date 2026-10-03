/**
 * LIVE SMOKE: the real `codex app-server`, driven by the real bridge, with an
 * EMPTY, throwaway CODEX_HOME — so no Codex login is used, and none can be.
 *
 * What this proves against the real binary, without a model turn:
 *
 *  - the handshake and JSON-RPC framing (initialize / initialized);
 *  - `account/read` reports no account — the precondition that this test
 *    touches nobody's login;
 *  - the `-c mcp_servers.*` overrides from `appServerArgv` parse, and Codex
 *    spawns `suite codex --reply-mcp` as the `suite-channel` MCP server and
 *    lists its four tools;
 *  - `mcpServer/tool/call` on `suite_reply` goes Codex → reply MCP server →
 *    unix socket → bridge → a `reply` push: the agent's reply path, end to end;
 *  - an attention becomes a real `thread/start` + `turn/start`, and the turn
 *    — which cannot run without a login — comes back failed and is reported in
 *    the space instead of vanishing.
 *
 * What it does NOT prove: a model actually answering. That needs a Codex
 * login, and the only one on the build host is not provisioned for this.
 * Skipped when `codex` is not on PATH (and says so).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerClient, processTransport } from "../src/codex/app_server.ts";
import { CodexBridge } from "../src/codex/bridge.ts";
import type { Payload } from "../src/codex/phoenix.ts";
import { listenBridgeSocket } from "../src/codex/reply_mcp.ts";
import { appServerArgv, codexEnv } from "../src/commands/codex.ts";

const CODEX = Bun.which("codex");
const ROOT = mkdtempSync(join(tmpdir(), "suite-codex-live-"));
const HOME = join(ROOT, "codex-home");
const SPACE = "019f0000-0000-7000-8000-0000000000aa";
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("the live codex smoke test below is not silently skipped", () => {
  if (CODEX === null) console.warn("codex is not on PATH: the live app-server smoke test is skipped");
  expect(CODEX !== null || process.env.SUITE_CLI_ALLOW_NO_CODEX === "1" || process.env.CI === "true").toBe(true);
});

describe.if(CODEX !== null)("real codex app-server, no login", () => {
  test(
    "handshake, MCP wiring, suite_reply through Codex, and a turn that fails out loud",
    async () => {
      Bun.spawnSync(["mkdir", "-p", HOME]);
      const socketPath = join(ROOT, "b.sock");
      const argv = appServerArgv({
        codexBin: CODEX as string,
        // Nothing listens here: the tools server fails fast, which is fine —
        // this test is about the channel server and the protocol.
        suiteUrl: "http://127.0.0.1:9",
        headerNames: [],
        self: [process.execPath, resolve(import.meta.dir, "../src/cli.ts")],
        socketPath,
      });
      const proc = Bun.spawn(argv, { cwd: ROOT, env: codexEnv(process.env, HOME), stdin: "pipe", stdout: "pipe", stderr: "ignore" });

      const pushes: { event: string; payload: Payload }[] = [];
      const handlers = new Map<string, (p: Payload) => void>();
      const channel = {
        on: (e: string, fn: (p: Payload) => void) => void handlers.set(e, fn),
        push: async (event: string, payload: Payload) => {
          pushes.push({ event, payload });
          return { status: "ok", response: {} };
        },
      };
      let bridge: CodexBridge | null = null;
      const client = new AppServerClient(processTransport(proc), {
        onNotification: (m, p) => bridge?.onNotification(m, p),
        onRequest: (m, p) => (bridge as CodexBridge).answerServerRequest(m, p),
      });
      try {
        const init = await client.request<{ codexHome: string }>("initialize", {
          clientInfo: { name: "suite_codex_test", title: null, version: "0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        client.notify("initialized");
        expect(init.codexHome).toBe(HOME);

        const account = await client.request<{ account: unknown; requiresOpenaiAuth: boolean }>("account/read", {});
        expect(account.account).toBeNull();

        const logs: string[] = [];
        bridge = new CodexBridge(channel, client, {
          cwd: ROOT,
          approvals: "accept",
          sandbox: "danger-full-access",
          log: (l) => logs.push(l),
          loadThreads: () => ({}),
          saveThreads: () => {},
        });
        const b = bridge;
        const server = await listenBridgeSocket(socketPath, (tool, args) => b.channelTool(tool, args), () => {});

        // An attention: real thread/start + turn/start; without a login the
        // turn fails, and the bridge says so in the space.
        handlers.get("attention")?.({ signal: { reason: "mention", space_id: SPACE, message_id: "m1" }, message: { content: "ping", author: "Ryan" } });
        await Promise.race([b.whenIdle(), Bun.sleep(60_000)]);
        const threadLine = logs.find((l) => l.includes("started thread"));
        expect(threadLine).toBeDefined();
        expect(logs.some((l) => / turn \S+ failed$/.test(l))).toBe(true);
        const failure = pushes.find((p) => p.event === "reply");
        expect(String(failure?.payload.content)).toStartWith("I could not complete that turn");
        const threadId = /started thread (\S+)/.exec(threadLine as string)![1]!;

        // The channel server's tools, as Codex sees them.
        type Status = { data: { name: string; tools: Record<string, unknown> }[] };
        let status: Status = { data: [] };
        for (let i = 0; i < 40; i++) {
          status = await client.request<Status>("mcpServerStatus/list", { threadId, serverName: "suite-channel" });
          if (Object.keys(status.data.find((s) => s.name === "suite-channel")?.tools ?? {}).length > 0) break;
          await Bun.sleep(250);
        }
        const tools = Object.keys(status.data.find((s) => s.name === "suite-channel")?.tools ?? {}).sort();
        expect(tools).toEqual(["suite_reply", "suite_reply_chunk", "suite_reply_with_media", "suite_typing"]);

        // suite_reply, called through Codex, lands as a reply push.
        pushes.length = 0;
        const r = await client.request<{ content: { text?: string }[]; isError?: boolean }>("mcpServer/tool/call", {
          threadId,
          server: "suite-channel",
          tool: "suite_reply",
          arguments: { space_id: SPACE, content: "hello from codex" },
        });
        expect(r.isError ?? false).toBe(false);
        expect(r.content[0]?.text).toBe("reply sent");
        expect(pushes).toEqual([{ event: "reply", payload: { space_id: SPACE, content: "hello from codex" } }]);
        server.close();
      } finally {
        client.close();
      }
    },
    120_000,
  );
});
