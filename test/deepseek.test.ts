/**
 * `suite deepseek` — the pure parts.
 *
 * Every assertion here corresponds to something that actually went wrong while
 * bringing the first agent up, because each of those failures was silent or
 * misleading at the point it happened:
 *
 *   - `/socket` answers a 302 that surfaces as an opaque websocket error
 *   - a `!!js` expression in a plugin `name:` throws `name.startsWith is not a
 *     function`, because that field is read before expressions are evaluated
 *   - the one-shot headless runner tears the agent factory down when its task
 *     ends, and a plugin holding the event loop open keeps the process alive
 *     around the corpse
 *
 * A regression in any of them costs an hour of confused debugging, so they are
 * pinned as text rather than trusted to a comment.
 */
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  agentNameFromRuntimeId,
  sessionNameForAgent,
  envNameForHeader,
  mcpUrl,
  parseDeepseekOptions,
  renderPatch,
  publicEnv,
  runtimeWsUrl,
  secretEnv,
} from "../src/commands/deepseek.ts";
import { emptyConfig } from "../src/config.ts";
import { createStore } from "../src/secrets.ts";

describe("runtimeWsUrl", () => {
  test("targets the runtime endpoint, not the LiveView socket", () => {
    expect(runtimeWsUrl("https://suite.example.invalid")).toBe("wss://suite.example.invalid/runtime/ws");
  });

  test("downgrades the scheme for a plaintext deployment", () => {
    expect(runtimeWsUrl("http://localhost:4000")).toBe("ws://localhost:4000/runtime/ws");
  });

  test("a trailing slash does not produce a doubled path", () => {
    expect(runtimeWsUrl("https://suite.example.invalid/")).toBe("wss://suite.example.invalid/runtime/ws");
  });
});

describe("parseDeepseekOptions", () => {
  test("--root is ours and does not reach dsh", () => {
    const { root, rest } = parseDeepseekOptions(["--root", "/tmp/agent", "--verbose"]);
    expect(root).toBe("/tmp/agent");
    expect(rest).toEqual(["--verbose"]);
  });

  test("after `--`, --root belongs to dsh", () => {
    const { root, rest } = parseDeepseekOptions(["--", "--root", "/tmp/agent"]);
    expect(root).toBeUndefined();
    expect(rest).toEqual(["--root", "/tmp/agent"]);
  });

  test("passthrough is otherwise total and ordered", () => {
    const { rest } = parseDeepseekOptions(["a", "--b", "c d", "$HOME"]);
    expect(rest).toEqual(["a", "--b", "c d", "$HOME"]);
  });
});

describe("agentNameFromRuntimeId", () => {
  test("drops the transport suffix so the directory is named for the agent", () => {
    expect(agentNameFromRuntimeId("oddjob-dsh")).toBe("oddjob");
  });

  test("keeps anything else verbatim rather than guessing", () => {
    expect(agentNameFromRuntimeId("ryan-home-openclaw")).toBe("ryan-home-openclaw");
    expect(agentNameFromRuntimeId("dsh-runner")).toBe("dsh-runner");
  });
});

describe("sessionNameForAgent", () => {
  test("names the session for the agent, not the working directory", () => {
    // Unlike `suite claude`, which keys on cwd. A dsh agent is one identity
    // owning one root — two shells asking for `oddjob` must reach the SAME
    // session, and a cwd-derived name would silently give them two.
    expect(sessionNameForAgent("oddjob")).toBe("suite-oddjob");
  });

  test("is stable regardless of where it is invoked from", () => {
    expect(sessionNameForAgent("oddjob")).toBe(sessionNameForAgent("oddjob"));
  });

  test("sanitises anything tmux would choke on", () => {
    expect(sessionNameForAgent("Odd Job.v2")).toBe("suite-odd-job-v2");
    expect(sessionNameForAgent("--weird--")).toBe("suite-weird");
  });

  test("two different agents never collide", () => {
    expect(sessionNameForAgent("oddjob")).not.toBe(sessionNameForAgent("oddjob2"));
  });
});

describe("parseDeepseekOptions --no-session", () => {
  test("is ours and does not reach dsh", () => {
    const { noSession, rest } = parseDeepseekOptions(["--no-session", "--verbose"]);
    expect(noSession).toBe(true);
    expect(rest).toEqual(["--verbose"]);
  });

  test("defaults to false, so the session is the normal path", () => {
    expect(parseDeepseekOptions([]).noSession).toBe(false);
  });

  test("after `--` it belongs to dsh", () => {
    const { noSession, rest } = parseDeepseekOptions(["--", "--no-session"]);
    expect(noSession).toBe(false);
    expect(rest).toEqual(["--no-session"]);
  });
});

describe("envNameForHeader", () => {
  test("normalises a header name into something a shell can carry", () => {
    expect(envNameForHeader("X-Example-Id")).toBe("SUITE_HEADER_X_EXAMPLE_ID");
  });

  test("collapses runs of punctuation rather than emitting empty segments", () => {
    expect(envNameForHeader("x--weird..name")).toBe("SUITE_HEADER_X_WEIRD_NAME");
  });

  test("two different header names never collide on one variable", () => {
    expect(envNameForHeader("A-B")).not.toBe(envNameForHeader("A-C"));
  });
});

describe("renderPatch", () => {
  const patch = renderPatch("/opt/harness/plugins/suite-federation/index.js", ["X-Example-Id"]);

  test("names the plugin by a literal path — dsh reads `name:` before !!js", () => {
    expect(patch).toContain("name: /opt/harness/plugins/suite-federation/index.js");
    expect(patch).not.toContain("name: !!js");
  });

  test("disables the one-shot runner, which would tear the agent tree down", () => {
    expect(patch).toContain("- id: headless-runner");
    expect(patch).toContain("disabled: true");
  });

  test("declares one MCP server per entry, not a servers map", () => {
    expect(patch).toContain("serverName: startup-suite");
    expect(patch).not.toContain("servers:");
  });

  test("carries each operator header through the environment, by name", () => {
    expect(patch).toContain("X-Example-Id: !!js process.env[\"SUITE_HEADER_X_EXAMPLE_ID\"]");
  });

  test("a deployment with no extra headers still renders a valid block", () => {
    const bare = renderPatch("/opt/p/index.js", []);
    expect(bare).toContain("Authorization: !!js");
    expect(bare).not.toContain("SUITE_HEADER_");
  });

  test("the generated patch is parseable YAML", () => {
    // The guard that was missing: an unquoted backtick template is valid
    // JavaScript and invalid YAML, and dsh only says so at boot, inside a
    // reconnect loop, after the install has already succeeded.
    const doc = parse(patch) as unknown[];
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.length).toBeGreaterThan(2);
  });

  test("a patch with no operator headers is also parseable", () => {
    expect(Array.isArray(parse(renderPatch("/opt/p/index.js", [])))).toBe(true);
  });

  test("declares the provider route, not just the default model name", () => {
    // Naming a provider as the agent default without declaring its pi-ai route
    // fails at the first turn with NO_ADAPTER — long after the socket has
    // connected and every status says healthy.
    expect(patch).toContain("- id: llm-pi-ai");
    expect(patch).toContain("baseURL: https://openrouter.ai/api/v1");
    const doc = parse(patch) as Array<Record<string, unknown>>;
    const routes = doc.find((entry) => entry?.id === "llm-pi-ai");
    const defaults = doc.find((entry) => entry?.id === "agent-default-model");
    expect(routes).toBeDefined();
    expect(defaults).toBeDefined();
  });

  test("no secret value can reach the patch — only variable names", () => {
    expect(patch).not.toContain("Bearer sk-");
    expect(patch).toContain("${process.env.SUITE_RUNTIME_TOKEN}");
  });
});

describe("environment split", () => {
  const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid", runtimeId: "oddjob-dsh", headerNames: ["X-Example-Id"] };

  test("the public env carries no credential", () => {
    const env = publicEnv(config, "/home/u/agents/oddjob", {} as NodeJS.ProcessEnv);
    expect(Object.values(env).join(" ")).not.toContain("s3cret");
    expect(env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
    expect(env.DSH_HOME).toBe("/home/u/agents/oddjob/.dsh");
  });

  test("the secret env carries the one token and each header value", () => {
    const store = createStore({ token: "s3cret", headers: { "X-Example-Id": "hv" } });
    const env = secretEnv(config, store);
    expect(env.SUITE_RUNTIME_TOKEN).toBe("s3cret");
    expect(env.SUITE_HEADER_X_EXAMPLE_ID).toBe("hv");
  });

  test("a header named in config but absent from the store is omitted, not blank", () => {
    const store = createStore({ token: "s3cret", headers: {} });
    expect(secretEnv(config, store)).not.toHaveProperty("SUITE_HEADER_X_EXAMPLE_ID");
  });
});

describe("mcpUrl", () => {
  test("an explicit endpoint wins, because ours is a separate host", () => {
    const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid" };
    expect(mcpUrl(config, { SUITE_MCP_URL: "https://mcp.example.invalid/mcp" } as NodeJS.ProcessEnv)).toBe(
      "https://mcp.example.invalid/mcp",
    );
  });

  test("otherwise it is derived from the Suite URL", () => {
    const config = { ...emptyConfig(), suiteUrl: "https://suite.example.invalid/" };
    expect(mcpUrl(config, {} as NodeJS.ProcessEnv)).toBe("https://suite.example.invalid/mcp");
  });
});
