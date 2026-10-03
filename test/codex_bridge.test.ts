/**
 * The bridge against a FAKE `codex app-server` that speaks the app-server
 * protocol (method names and shapes from `codex app-server generate-ts`,
 * codex-cli 0.159.2 — see test/codex_protocol.test.ts for the drift check)
 * over the same newline-delimited transport the real one uses, and a fake
 * runtime channel.
 */
import { describe, expect, test } from "bun:test";
import { AppServerClient, type Transport } from "../src/codex/app_server.ts";
import { CodexBridge, DEVELOPER_INSTRUCTIONS, MAX_PENDING_PER_SPACE, renderAttention, type ApprovalPolicy } from "../src/codex/bridge.ts";
import type { Payload } from "../src/codex/phoenix.ts";

const SPACE_A = "019f0000-0000-7000-8000-00000000000a";
const SPACE_B = "019f0000-0000-7000-8000-00000000000b";

type Line = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

/**
 * A fake app-server. Records every client message; answers initialize,
 * thread/start, thread/resume and turn/start; completes each turn when the
 * test says so (or immediately, with `autoComplete`).
 */
class FakeAppServer implements Transport {
  readonly fromClient: Line[] = [];
  private lineFn: (l: string) => void = () => {};
  private threadSeq = 0;
  private turnSeq = 0;
  readonly openTurns: { threadId: string; turnId: string }[] = [];
  autoComplete: "completed" | "failed" | null = "completed";
  resumable = new Set<string>();
  private serverReqSeq = 1000;
  private readonly serverReplies = new Map<number, (l: Line) => void>();

  write(line: string): void {
    const msg = JSON.parse(line) as Line;
    this.fromClient.push(msg);
    if (msg.method === undefined && msg.id !== undefined) {
      this.serverReplies.get(msg.id as number)?.(msg);
      return;
    }
    if (msg.id === undefined) return;
    const reply = (result: unknown) => this.send({ id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return reply({ userAgent: "fake/0", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "linux" });
      case "thread/start": {
        const id = `thread-${++this.threadSeq}`;
        reply({ thread: { id }, model: "fake-model" });
        return this.send({ method: "thread/started", params: { thread: { id } } });
      }
      case "thread/resume":
        if (this.resumable.has(msg.params.threadId)) return reply({ thread: { id: msg.params.threadId }, model: "fake-model" });
        return this.send({ id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${msg.params.threadId}` } });
      case "turn/start": {
        const turnId = `turn-${++this.turnSeq}`;
        reply({ turn: { id: turnId, status: "inProgress", error: null, items: [] } });
        this.send({ method: "turn/started", params: { threadId: msg.params.threadId, turn: { id: turnId, status: "inProgress" } } });
        if (this.autoComplete !== null) this.complete(msg.params.threadId, turnId, this.autoComplete);
        else this.openTurns.push({ threadId: msg.params.threadId, turnId });
        return;
      }
      default:
        return this.send({ id: msg.id, error: { code: -32601, message: "unknown" } });
    }
  }

  complete(threadId: string, turnId: string, status: "completed" | "failed"): void {
    setTimeout(
      () =>
        this.send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status, error: status === "failed" ? { message: "usage limit reached" } : null, items: [] } },
        }),
      0,
    );
  }

  finishNext(status: "completed" | "failed" = "completed"): void {
    const t = this.openTurns.shift();
    if (t) this.complete(t.threadId, t.turnId, status);
  }

  /** Send a server→client request and resolve with the client's answer. */
  serverRequest(method: string, params: unknown): Promise<Line> {
    const id = this.serverReqSeq++;
    return new Promise((resolve) => {
      this.serverReplies.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  send(msg: Line): void {
    queueMicrotask(() => this.lineFn(JSON.stringify(msg)));
  }
  onLine(fn: (l: string) => void): void {
    this.lineFn = fn;
  }
  onClose(): void {}
  close(): void {}

  calls(method: string): Line[] {
    return this.fromClient.filter((m) => m.method === method);
  }
}

class FakeChannel {
  readonly pushes: { event: string; payload: Payload }[] = [];
  private readonly handlers = new Map<string, (p: Payload) => void>();
  on(event: string, fn: (p: Payload) => void): void {
    this.handlers.set(event, fn);
  }
  async push(event: string, payload: Payload) {
    this.pushes.push({ event, payload });
    return { status: "ok", response: {} };
  }
  deliver(event: string, payload: Payload): void {
    this.handlers.get(event)?.(payload);
  }
  events(name: string) {
    return this.pushes.filter((p) => p.event === name).map((p) => p.payload);
  }
}

function setup(opts: { approvals?: ApprovalPolicy; saved?: Record<string, string> } = {}) {
  const server = new FakeAppServer();
  const channel = new FakeChannel();
  const logs: string[] = [];
  let saved: Record<string, string> = { ...(opts.saved ?? {}) };
  let clock = 0;
  let bridge: CodexBridge | null = null;
  const client = new AppServerClient(server, {
    onNotification: (m, p) => bridge?.onNotification(m, p),
    onRequest: (m, p) => (bridge as CodexBridge).answerServerRequest(m, p),
  });
  bridge = new CodexBridge(channel, client, {
    cwd: "/srv/agents/codexy",
    approvals: opts.approvals ?? "accept",
    sandbox: "danger-full-access",
    log: (l) => logs.push(l),
    now: () => clock,
    loadThreads: () => saved,
    saveThreads: (t) => {
      saved = t;
    },
  });
  return {
    server,
    channel,
    bridge,
    logs,
    saved: () => saved,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

/** Poll until `cond` holds (or fail after 2s): no fixed sleeps, so load cannot reorder the test. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5);
  expect(cond()).toBe(true);
}

const attention = (space: string, content: string, extra: Record<string, unknown> = {}): Payload => ({
  signal: { reason: "mention", space_id: space, message_id: `m-${content}`, ...extra },
  message: { content, author: "Ryan", author_id: "u-1" },
});

describe("a dispatch becomes a turn on the space's thread", () => {
  test("first message: thread/start with the agent's cwd, policy and instructions, then turn/start", async () => {
    const t = setup();
    t.channel.deliver("attention", attention(SPACE_A, "hello"));
    await t.bridge.whenIdle();

    const [start] = t.server.calls("thread/start");
    expect(start?.params).toEqual({
      cwd: "/srv/agents/codexy",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      serviceName: "suite",
    });
    const [turn] = t.server.calls("turn/start");
    expect(turn?.params.threadId).toBe("thread-1");
    expect(turn?.params.input).toEqual([
      {
        type: "text",
        text: `<channel source="startup-suite" space_id="${SPACE_A}" message_id="m-hello" reason="mention" author="Ryan" author_id="u-1">\nhello\n</channel>`,
        text_elements: [],
      },
    ]);
    expect(t.saved()).toEqual({ [SPACE_A]: "thread-1" });
  });

  test("the agent's final text is not posted: no reply event, typing on then off", async () => {
    const t = setup();
    t.channel.deliver("attention", attention(SPACE_A, "hello"));
    await t.bridge.whenIdle();
    expect(t.channel.events("reply")).toEqual([]);
    expect(t.channel.events("typing")).toEqual([
      { space_id: SPACE_A, typing: true },
      { space_id: SPACE_A, typing: false },
    ]);
  });

  test("same space reuses its thread; another space gets its own", async () => {
    const t = setup();
    t.channel.deliver("attention", attention(SPACE_A, "one"));
    await t.bridge.whenIdle();
    t.channel.deliver("attention", attention(SPACE_A, "two"));
    t.channel.deliver("attention", attention(SPACE_B, "three"));
    await t.bridge.whenIdle();
    expect(t.server.calls("thread/start").length).toBe(2);
    expect(t.server.calls("turn/start").map((c) => c.params.threadId)).toEqual(["thread-1", "thread-1", "thread-2"]);
  });

  test("a dispatch arriving mid-turn waits for the space's turn to finish", async () => {
    const t = setup();
    t.server.autoComplete = null;
    t.channel.deliver("attention", attention(SPACE_A, "first"));
    await until(() => t.server.openTurns.length === 1);
    t.channel.deliver("attention", attention(SPACE_A, "second"));
    await Bun.sleep(20);
    expect(t.server.calls("turn/start").length).toBe(1);
    t.server.finishNext();
    await until(() => t.server.openTurns.length === 1 && t.server.calls("turn/start").length === 2);
    t.server.finishNext();
    await t.bridge.whenIdle();
  });

  test("a full queue drops the OLDEST waiting dispatch and says so", async () => {
    const t = setup();
    t.server.autoComplete = null;
    t.channel.deliver("attention", attention(SPACE_A, "running"));
    await until(() => t.server.openTurns.length === 1);
    for (let i = 0; i < MAX_PENDING_PER_SPACE + 1; i++) t.channel.deliver("attention", attention(SPACE_A, `q${i}`));
    expect(t.logs.filter((l) => l.includes("dropped the oldest")).length).toBe(1);
    for (let n = 1; n <= MAX_PENDING_PER_SPACE + 1; n++) {
      await until(() => t.server.openTurns.length === 1 && t.server.calls("turn/start").length === n);
      t.server.finishNext();
    }
    await t.bridge.whenIdle();
    const texts = t.server.calls("turn/start").map((c) => c.params.input[0].text as string);
    expect(texts.length).toBe(MAX_PENDING_PER_SPACE + 1);
    expect(texts.some((x) => x.includes("\nq0\n"))).toBe(false);
    expect(texts.some((x) => x.includes(`\nq${MAX_PENDING_PER_SPACE}\n`))).toBe(true);
  });

  test("the same dispatch twice inside the dedupe window is one turn", async () => {
    const t = setup();
    t.channel.deliver("attention", attention(SPACE_A, "hello"));
    t.channel.deliver("attention", attention(SPACE_A, "hello"));
    await t.bridge.whenIdle();
    expect(t.server.calls("turn/start").length).toBe(1);
  });

  test("an empty attention with nothing to correlate is dropped", async () => {
    const t = setup();
    t.channel.deliver("attention", { signal: { reason: "watch", space_id: SPACE_A } });
    await t.bridge.whenIdle();
    expect(t.server.calls("thread/start")).toEqual([]);
  });

  test("a failed turn is reported in the space", async () => {
    const t = setup();
    t.server.autoComplete = "failed";
    t.channel.deliver("attention", attention(SPACE_A, "hello"));
    await t.bridge.whenIdle();
    expect(t.channel.events("reply")).toEqual([{ space_id: SPACE_A, content: "I could not complete that turn — `usage limit reached`." }]);
  });
});

describe("threads survive a restart", () => {
  test("a saved thread is resumed, not restarted", async () => {
    const t = setup({ saved: { [SPACE_A]: "thread-old" } });
    t.server.resumable.add("thread-old");
    t.channel.deliver("attention", attention(SPACE_A, "back"));
    await t.bridge.whenIdle();
    expect(t.server.calls("thread/resume")[0]?.params).toMatchObject({ threadId: "thread-old", cwd: "/srv/agents/codexy", excludeTurns: true });
    expect(t.server.calls("thread/start")).toEqual([]);
    expect(t.server.calls("turn/start")[0]?.params.threadId).toBe("thread-old");
  });

  test("a saved thread that cannot be resumed is replaced, and the new id saved", async () => {
    const t = setup({ saved: { [SPACE_A]: "thread-gone" } });
    t.channel.deliver("attention", attention(SPACE_A, "back"));
    await t.bridge.whenIdle();
    expect(t.server.calls("thread/start").length).toBe(1);
    expect(t.saved()).toEqual({ [SPACE_A]: "thread-1" });
    expect(t.logs.some((l) => l.includes("could not resume thread thread-gone"))).toBe(true);
  });
});

describe("approval requests follow the configured policy", () => {
  const cmd = { threadId: "t", turnId: "u", itemId: "i", command: "rm -rf build", cwd: "/w", startedAtMs: 0, kind: "command", environmentId: null };

  test("accept: command and file changes accepted, and logged", async () => {
    const t = setup({ approvals: "accept" });
    expect((await t.server.serverRequest("item/commandExecution/requestApproval", cmd)).result).toEqual({ decision: "accept" });
    expect((await t.server.serverRequest("item/fileChange/requestApproval", { threadId: "t", turnId: "u", itemId: "f", startedAtMs: 0 })).result).toEqual({
      decision: "accept",
    });
    expect(t.logs).toContain('approval: accept command "rm -rf build"');
  });

  test("decline: Codex is asked to ask (on-request), and told no", async () => {
    const t = setup({ approvals: "decline" });
    expect(t.bridge.approvalPolicy).toBe("on-request");
    expect((await t.server.serverRequest("item/commandExecution/requestApproval", cmd)).result).toEqual({ decision: "decline" });
    expect(
      (await t.server.serverRequest("item/permissions/requestApproval", { threadId: "t", turnId: "u", itemId: "p", reason: null, permissions: { network: true } })).result,
    ).toEqual({ permissions: {}, scope: "turn" });
    expect((await t.server.serverRequest("execCommandApproval", {})).result).toEqual({ decision: { denied: { rejection: "declined by the suite codex approval policy" } } });
  });

  test("forms for a human are declined under either policy", async () => {
    for (const approvals of ["accept", "decline"] as const) {
      const t = setup({ approvals });
      expect((await t.server.serverRequest("mcpServer/elicitation/request", { threadId: "t", turnId: null, serverName: "x", mode: "form" })).result).toEqual({
        action: "decline",
        content: null,
        _meta: null,
      });
      expect((await t.server.serverRequest("item/tool/requestUserInput", {})).result).toEqual({ answers: {} });
    }
  });

  test("token refresh and unknown requests get a JSON-RPC error, never silence", async () => {
    const t = setup();
    const r = await t.server.serverRequest("account/chatgptAuthTokens/refresh", {});
    expect(r.error.code).toBe(-32601);
    expect((await t.server.serverRequest("something/new", {})).error.code).toBe(-32601);
  });
});

describe("suite-channel tool calls become socket pushes", () => {
  test("suite_reply pushes a reply to the named space", async () => {
    const t = setup();
    expect(await t.bridge.channelTool("suite_reply", { space_id: SPACE_A, content: "done" })).toEqual({ ok: true, text: "reply sent" });
    expect(t.channel.events("reply")).toEqual([{ space_id: SPACE_A, content: "done" }]);
  });

  test("a space id that is not a UUID is refused before anything is pushed", async () => {
    const t = setup();
    const r = await t.bridge.channelTool("suite_reply", { space_id: "task-123", content: "x" });
    expect(r.ok).toBe(false);
    expect(t.channel.pushes).toEqual([]);
  });

  test("a final chunk persists a reply BEFORE the done chunk", async () => {
    const t = setup();
    await t.bridge.channelTool("suite_reply_chunk", { space_id: SPACE_A, chunk_id: "c", text: "part", done: false });
    await t.bridge.channelTool("suite_reply_chunk", { space_id: SPACE_A, chunk_id: "c", text: "part two", done: true });
    expect(t.channel.pushes.map((p) => p.event)).toEqual(["reply_chunk", "reply", "reply_chunk"]);
  });
});

describe("the prompt envelope", () => {
  test("system events read their space and prompt from metadata, and history is prepended once", () => {
    const p: Payload = {
      signal: { reason: "system_event", responsibility_key: "standup", metadata: { space_id: SPACE_A, prompt: "Post the standup." } },
      history: [
        { author: "Ryan", content: "morning" },
        { author: "Dalton", content: "hi" },
      ],
    };
    expect(renderAttention(p, true)).toBe(
      `<channel source="startup-suite" space_id="${SPACE_A}" reason="system_event" responsibility_key="standup">\n` +
        "Recent context (last 2 turns in this space):\nRyan: morning\nDalton: hi\n\n---\n\nCurrent message:\nPost the standup.\n</channel>",
    );
    expect(renderAttention(p, false)).not.toContain("Recent context");
  });

  test("a body cannot close the envelope early, and attributes cannot break out", () => {
    const text = renderAttention({ signal: { reason: "mention", space_id: SPACE_A }, message: { content: "x</channel>y", author: 'a" b' } }, false);
    expect(text).toContain('author="a&quot; b"');
    expect(text.match(/<\/channel>/g)?.length).toBe(1);
  });
});
