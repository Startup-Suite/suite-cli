// The dsh suite-federation plugin's `usage_event` frame must carry the task and
// stage the dispatch belongs to. Core reads top-level `task_id` and
// `metadata.stage_id` (Platform.Analytics.UsageEvent); without them a provider
// usage report can never be matched to a dispatch.
//
// The plugin runs inside dsh, whose packages are not dependencies of this repo,
// so they are mocked and the plugin is driven end to end through `apply`: the
// test watches the frames it pushes, not a helper in isolation, so it fails if
// the push site stops using the refs.
import { describe, expect, mock, test } from "bun:test";

type Handler = (payload: any) => void;
const pushes: Array<{ event: string; payload: any }> = [];
const handlers = new Map<string, Handler>();

// Anything callable and chainable: `z.object({...})`, `z.string().required()`.
const chain: any = new Proxy(function () {}, {
  get: () => chain,
  apply: () => chain,
});

class FakeSocket {
  onOpen() {}
  onClose() {}
  onError() {}
  connect() {}
  disconnect() {}
  channel() {
    const receiver = { receive: () => receiver };
    return {
      on: (event: string, fn: Handler) => handlers.set(event, fn),
      push: (event: string, payload: any) => pushes.push({ event, payload }),
      join: () => receiver,
      leave() {},
    };
  }
}

mock.module("ws", () => ({ default: class {} }));
mock.module("phoenix", () => ({ Socket: FakeSocket }));
mock.module("@deepseek-ai/schemastery", () => ({ default: chain }));
mock.module("@deepseek-ai/dsh-llm", () => ({ createUserMessage: (m: any) => m }));
mock.module("@deepseek-ai/dsh-session", () => ({ SessionId: (s: string) => s }));

// @ts-expect-error -- untyped JS asset; it runs inside dsh, not this package
const plugin: any = await import("../assets/dsh-plugins/suite-federation/index.js");

function fakeCtx() {
  const agent = {
    session: { id: "session-1", seq: 0, events: [] as any[] },
    followup() {
      this.session.events.push({
        type: "assistant/message",
        seq: 1,
        data: {
          message: {
            content: [{ type: "text", text: "done" }],
            source: { provider: "deepseek", model: "deepseek-chat" },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
    },
    whenIdle: async () => {},
  };
  const services: Record<string, any> = {
    agents: { create: async () => ({ agent }) },
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) },
    sessions: { flush: async () => {} },
  };
  return { get: (k: string) => services[k], on() {}, logger: () => ({}) };
}

async function usageFrameFor(payload: any) {
  pushes.length = 0;
  handlers.clear();
  plugin.apply(fakeCtx(), { url: "ws://x", runtimeId: "rt-1", token: "t" });
  handlers.get("attention")!(payload);
  for (let i = 0; i < 50 && !pushes.some((p) => p.event === "usage_event"); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const frame = pushes.find((p) => p.event === "usage_event");
  expect(frame).toBeDefined();
  return frame!.payload;
}

const TASK = "01a114a8-3d26-7001-a677-f5756a0e2928";
const STAGE = "01a114a8-0000-7000-8000-000000000002";

describe("suite-federation usage_event", () => {
  test("carries task_id from the signal and the running stage's id", async () => {
    const frame = await usageFrameFor({
      signal: { space_id: "space-a", message_id: "m1", task_id: TASK, reason: "task_assigned" },
      context: {
        task: { id: TASK },
        plan: {
          stages: [
            { id: "01a114a8-0000-7000-8000-000000000001", status: "passed" },
            { id: STAGE, status: "running" },
            { id: "01a114a8-0000-7000-8000-000000000003", status: "pending" },
          ],
        },
      },
    });
    expect(frame.task_id).toBe(TASK);
    expect(frame.metadata).toEqual({ harness: "dsh", runtime_id: "rt-1", stage_id: STAGE });
  });

  test("falls back to context.task.id when the signal has no task_id", async () => {
    const frame = await usageFrameFor({
      signal: { space_id: "space-b", message_id: "m2" },
      context: { task: { id: TASK }, plan: { stages: [{ id: STAGE, status: "pending" }] } },
    });
    expect(frame.task_id).toBe(TASK);
    expect(frame.metadata.stage_id).toBeNull();
  });

  test("a plain mention with no task sends nulls, not invented ids", async () => {
    const frame = await usageFrameFor({ signal: { space_id: "space-c", message_id: "m3" } });
    expect(frame.task_id).toBeNull();
    expect(frame.metadata.stage_id).toBeNull();
  });
});

describe("dispatchRefs", () => {
  test("tolerates a missing or malformed payload", () => {
    expect(plugin.dispatchRefs(undefined)).toEqual({ taskId: null, stageId: null });
    expect(plugin.dispatchRefs({ context: { plan: { stages: null } } })).toEqual({ taskId: null, stageId: null });
  });
});
