/**
 * ONE CONNECTION PER AGENT FOLDER (src/agent_connections.ts).
 *
 * The defect this pins, measured on 0.7.0: `suite init` for runtime A in a/,
 * then for runtime B in b/, then `suite claude` in a/ — and a/'s own, correct
 * MCP entries were marked stale against the ONE machine connection (now B) and
 * rewritten with B's runtime id, B's URL and B's token. Two `claude mcp add`.
 *
 * Every value here is invented, and every token is a random canary. The
 * repository is public. Tokens are compared in-test and never printed: a leak
 * hit reports where and in which encoding, never the value.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  agentConfigPath,
  agentCredentialsPath,
  agentKey,
  agentsDir,
  canonicalDir,
  legacyConnection,
  listAgentConnections,
  readAgentConnection,
  readAgentSecrets,
  serializeAgentRecord,
  writeAgentConnection,
} from "../src/agent_connections.ts";
import { runClaude, type ClaudeDeps } from "../src/commands/claude.ts";
import { CHANNEL_SERVER, TOOLS_SERVER, channelWsUrl, defaultCheckout, runInit, toolsHttpUrl } from "../src/commands/init.ts";
import { emptyConfig, serializeConfig } from "../src/config.ts";
import { configDir, WriteRefused, type GitProbe } from "../src/paths.ts";
import { createStore, spawnWithSecrets, type Prompter } from "../src/secrets.ts";
import type { RunResult, TmuxDeps } from "../src/tmux.ts";
import { cleanupCleanEnvs, createCleanEnv, stubsFor, type CleanEnv } from "./clean-env/fixture.ts";
import { canary, scanText, scanTexts, scanTree } from "./leak-scan.ts";

afterEach(cleanupCleanEnvs);

interface Agent {
  url: string;
  runtime: string;
  token: string;
}

function agents(): { A: Agent; B: Agent } {
  return {
    A: { url: "https://one.example.invalid", runtime: "rt-a-00000000", token: canary("tokA") },
    B: { url: "https://two.example.invalid", runtime: "rt-b-00000000", token: canary("tokB") },
  };
}

function scripted(answers: string[]): Prompter & { asked: string[] } {
  const q = [...answers];
  const asked: string[] = [];
  return {
    asked,
    ask: async (question) => (asked.push(question), q.shift() ?? ""),
    askSecret: async (question) => (asked.push(question), q.shift() ?? ""),
    say: () => {},
  };
}

/** A prompter that FAILS the test the moment anything is asked. */
function mute(): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const refuse = async (question: string): Promise<string> => {
    asked.push(question);
    throw new Error(`prompted unexpectedly: ${question}`);
  };
  return { asked, ask: refuse, askSecret: refuse, say: () => {} };
}

const noTmux: TmuxDeps = {
  env: {},
  which: (name) => (name === "claude" ? "/fixture/bin/claude" : null),
  run: async (): Promise<RunResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
};

interface Box {
  fx: CleanEnv;
  a: string;
  b: string;
  /** Every line any command printed, for the leak scan. */
  output: string[];
}

/** A scratch machine with two agent folders and a plugin checkout already present (no clone). */
function box(): Box {
  const fx = createCleanEnv({ label: "agents", bodies: stubsFor(["git", "bun", "claude", "tmux"]) });
  const list = resolve(fx.root, "mcp-list.txt");
  writeFileSync(list, `${CHANNEL_SERVER}: bun /x/src/index.ts - ✔ Connected\n${TOOLS_SERVER}: x (HTTP) - ✔ Connected\n`);
  fx.env.STUB_MCP_LIST = list;
  const checkout = defaultCheckout(fx.env);
  mkdirSync(resolve(checkout, ".git"), { recursive: true });
  mkdirSync(resolve(checkout, "src"), { recursive: true });
  mkdirSync(resolve(checkout, "node_modules"), { recursive: true });
  writeFileSync(resolve(checkout, "src/index.ts"), "");
  const a = resolve(fx.root, "w", "a");
  const b = resolve(fx.root, "w", "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  return { fx, a, b, output: [] };
}

/** `suite init`, for real, with `cwd` as the agent folder. */
async function initIn(bx: Box, dir: string, agent: Agent): Promise<void> {
  const store = createStore();
  await runInit({
    env: bx.fx.env,
    prompter: scripted([agent.url, agent.runtime, agent.token, ""]),
    store,
    platform: "linux",
    isTTY: false,
    cwd: dir,
    out: (l) => void bx.output.push(l),
    run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: bx.fx.env }),
  });
}

/** The single machine connection exactly as 0.7.0 saved it. */
function seedLegacy(bx: Box, agent: Agent): void {
  const dir = configDir(bx.fx.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "config.json"),
    serializeConfig({ suiteUrl: agent.url, runtimeId: agent.runtime, headerNames: [], sessionNaming: "cwd" }),
  );
  writeFileSync(resolve(dir, "credentials.json"), `${JSON.stringify({ token: agent.token, headers: {} }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function channelEntry(bx: Box, agent: Agent): unknown {
  return {
    type: "stdio",
    command: "bun",
    args: [resolve(defaultCheckout(bx.fx.env), "src", "index.ts")],
    env: {
      SUITE_URL: channelWsUrl(agent.url),
      SUITE_RUNTIME_ID: agent.runtime,
      SUITE_TOKEN: agent.token,
      SUITE_ALLOW_PERMISSION_RELAY: "0",
    },
  };
}

function toolsEntry(agent: Agent): unknown {
  return { type: "http", url: toolsHttpUrl(agent.url), headers: { Authorization: `Bearer ${agent.token}` } };
}

/** ~/.claude.json with local-scope entries per folder, as `claude mcp add -s local` leaves it. */
function writeClaudeJson(bx: Box, byDir: Record<string, Agent>): void {
  const projects: Record<string, unknown> = {};
  for (const [dir, agent] of Object.entries(byDir)) {
    projects[dir] = { mcpServers: { [CHANNEL_SERVER]: channelEntry(bx, agent), [TOOLS_SERVER]: toolsEntry(agent) } };
  }
  writeFileSync(claudeJson(bx), JSON.stringify({ projects }), { mode: 0o600 });
}

function claudeJson(bx: Box): string {
  return resolve(bx.fx.home, ".claude.json");
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `suite claude -p …` in `dir`: the real wiring, a faked launch. */
async function claudeIn(
  bx: Box,
  dir: string,
  prompter: Prompter,
  canPrompt: boolean,
): Promise<{ code: number; err: string[] }> {
  const store = createStore();
  const err: string[] = [];
  const deps: ClaudeDeps = {
    tmux: noTmux,
    env: bx.fx.env,
    cwd: dir,
    store,
    config: emptyConfig(),
    statePath: resolve(bx.fx.root, "state.json"),
    color: false,
    platform: "linux",
    prompter,
    sleep: async () => {},
    out: (l) => void bx.output.push(l),
    err: (l) => {
      err.push(l);
      bx.output.push(l);
    },
    exec: async () => 0,
    wiring: { run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: bx.fx.env }), isTTY: false, canPrompt },
  };
  const code = await runClaude(deps, { userArgs: ["-p", "hello"], force: false });
  return { code, err };
}

function adds(bx: Box): string[][] {
  return bx.fx
    .log()
    .map((l) => l.split("\t"))
    .filter((p) => p[0] === "claude" && p[1] === "mcp" && p[2] === "add");
}

/** {@link adds} with token-bearing arguments masked, for assertions whose failure diff is printed. */
function addsShown(bx: Box): string[][] {
  return adds(bx).map((p) => p.map((a) => (/TOKEN=|Bearer /.test(a) ? "<token masked>" : a)));
}

/** I1: neither token anywhere in an agent folder, nor in anything printed. */
function expectNoLeaks(bx: Box, secrets: string[]): void {
  for (const secret of secrets) {
    expect(scanTree(bx.a, secret)).toEqual([]);
    expect(scanTree(bx.b, secret)).toEqual([]);
    expect(scanTexts({ output: bx.output.join("\n") }, secret)).toEqual([]);
  }
}

/* ------------------------------------------------------------------------- */

describe("the named regression", () => {
  test("two agents: claude in the first folder keeps the first runtime", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    await initIn(bx, bx.b, B);
    // As 0.7.0 left a real box: the machine connection names the LAST init, B.
    seedLegacy(bx, B);
    writeClaudeJson(bx, { [bx.a]: A, [bx.b]: B });
    const before = readFileSync(claudeJson(bx));

    // Off a terminal, and at a terminal with a prompter that fails on any question.
    // Both folders: whichever record a broken lookup picked, one of them would be rewritten.
    for (const canPrompt of [false, true]) {
      for (const dir of [bx.a, bx.b]) {
        const r = await claudeIn(bx, dir, mute(), canPrompt);
        expect(r.code).toBe(0);
        expect(addsShown(bx)).toEqual([]);
        expect(readFileSync(claudeJson(bx)).equals(before)).toBe(true);
      }
    }

    // a/ cross-wired to B (what 0.7.0 did to it): the next claude in a/ puts A back.
    writeClaudeJson(bx, { [bx.a]: B, [bx.b]: B });
    const r = await claudeIn(bx, bx.a, mute(), false);
    expect(r.code).toBe(0);
    const added = adds(bx);
    expect(added.map((p) => p[3]).sort()).toEqual([CHANNEL_SERVER, TOOLS_SERVER].sort());
    const channel = added.find((p) => p[3] === CHANNEL_SERVER) ?? [];
    const tools = added.find((p) => p[3] === TOOLS_SERVER) ?? [];
    const mask = (p: string[]): string[] => p.map((a) => (/TOKEN=|Bearer /.test(a) ? "<token masked>" : a));
    expect(mask(channel)).toContain(`SUITE_RUNTIME_ID=${A.runtime}`);
    expect(mask(channel)).toContain(`SUITE_URL=${channelWsUrl(A.url)}`);
    expect(mask(tools)).toContain(toolsHttpUrl(A.url));
    // Tokens compared, never printed: a boolean, not the value.
    expect(channel.includes(`SUITE_TOKEN=${A.token}`)).toBe(true);
    expect(added.some((p) => p.join("\t").includes(B.token))).toBe(false);
    expect(added.some((p) => p.join("\t").includes(B.runtime))).toBe(false);

    expectNoLeaks(bx, [A.token, B.token]);
  });
});

describe("migration from the 0.7.0 single machine connection", () => {
  test("legacy B and no records: no folder is wired from it, off a terminal", async () => {
    const { A, B } = agents();
    const bx = box();
    seedLegacy(bx, B);
    writeClaudeJson(bx, { [bx.a]: A });
    const legacyConfig = resolve(configDir(bx.fx.env), "config.json");
    const legacyCreds = resolve(configDir(bx.fx.env), "credentials.json");
    const hashes = [sha(legacyConfig), sha(legacyCreds), sha(claudeJson(bx))];

    const inA = await claudeIn(bx, bx.a, mute(), false);
    expect(inA.code).toBe(0);
    expect(addsShown(bx)).toEqual([]);
    expect(inA.err.join("\n")).toContain(`no saved connection for ${bx.a}`);
    expect(inA.err.join("\n")).toContain("suite init");

    const inB = await claudeIn(bx, bx.b, mute(), false);
    expect(inB.code).toBe(0);
    expect(addsShown(bx)).toEqual([]);
    expect(inB.err.join("\n")).toContain("suite init");

    // I4: the legacy files are never written or deleted, and ~/.claude.json is untouched.
    expect([sha(legacyConfig), sha(legacyCreds), sha(claudeJson(bx))]).toEqual(hashes);
    expect(listAgentConnections(bx.fx.env)).toEqual([]);
    expectNoLeaks(bx, [A.token, B.token]);
  });

  test("legacy B, folder a/ has entries: at a terminal it still asks nothing and writes nothing", async () => {
    const { A, B } = agents();
    const bx = box();
    seedLegacy(bx, B);
    writeClaudeJson(bx, { [bx.a]: A });
    const prompter = mute();

    const r = await claudeIn(bx, bx.a, prompter, true);

    expect(r.code).toBe(0);
    expect(prompter.asked).toEqual([]);
    expect(addsShown(bx)).toEqual([]);
    // I2: no record written implicitly.
    expect(existsSync(agentsDir(bx.fx.env))).toBe(false);
  });

  test("legacy B, empty folder b/ at a terminal: prompted, and the runtime-id question never offers B", async () => {
    const { A, B } = agents();
    const bx = box();
    seedLegacy(bx, B);
    writeClaudeJson(bx, { [bx.a]: A });
    const C: Agent = { url: "https://three.example.invalid", runtime: "rt-c-00000000", token: canary("tokC") };
    const prompter = scripted([C.url, C.runtime, C.token, ""]);

    const r = await claudeIn(bx, bx.b, prompter, true);

    expect(r.code).toBe(0);
    const idQuestion = prompter.asked.find((q) => q.startsWith("runtime id")) ?? "";
    expect(idQuestion).not.toBe("");
    expect(idQuestion.includes(B.runtime)).toBe(false);
    // Saved as b/'s record, and wired from it.
    expect(readAgentConnection(bx.fx.env, bx.b).connection?.record.runtimeId).toBe(C.runtime);
    expect(readAgentConnection(bx.fx.env, bx.a).connection).toBeNull();
    const channel = addsShown(bx).find((p) => p[3] === CHANNEL_SERVER) ?? [];
    expect(channel).toContain(`SUITE_RUNTIME_ID=${C.runtime}`);
    // The legacy connection is still there, still B, still assigned to nobody.
    expect(legacyConnection(bx.fx.env)?.runtimeId).toBe(B.runtime);
    expectNoLeaks(bx, [A.token, B.token, C.token]);
  });
});

describe("unknown config: entries left alone, nothing stamped", () => {
  test("an unparseable ~/.claude.json and no record make zero adds, at a terminal or not", async () => {
    const { A } = agents();
    const bx = box();
    writeFileSync(claudeJson(bx), "{ not json", { mode: 0o600 });
    for (const canPrompt of [false, true]) {
      const r = await claudeIn(bx, bx.a, mute(), canPrompt);
      expect(r.code).toBe(0);
      expect(r.err.join("\n")).toContain("suite init");
    }
    expect(addsShown(bx)).toEqual([]);
    expect(existsSync(agentsDir(bx.fx.env))).toBe(false);
    expectNoLeaks(bx, [A.token]);
  });

  test("an unreadable ~/.claude.json and no record make zero adds", async () => {
    if (process.getuid?.() === 0) return; // root reads a 000 file; the parse case above still covers null
    const bx = box();
    writeFileSync(claudeJson(bx), "{}", { mode: 0o600 });
    chmodSync(claudeJson(bx), 0o000);
    try {
      const r = await claudeIn(bx, bx.a, mute(), true);
      expect(r.code).toBe(0);
      expect(addsShown(bx)).toEqual([]);
    } finally {
      chmodSync(claudeJson(bx), 0o600);
    }
  });
});

describe("the store", () => {
  test("init in b/ cannot change a/'s record or secrets", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    const recordA = readFileSync(agentConfigPath(bx.fx.env, bx.a));
    const secretsA = readFileSync(agentCredentialsPath(bx.fx.env, bx.a));
    await initIn(bx, bx.b, B);
    expect(readFileSync(agentConfigPath(bx.fx.env, bx.a)).equals(recordA)).toBe(true);
    expect(readFileSync(agentCredentialsPath(bx.fx.env, bx.a)).equals(secretsA)).toBe(true);
    expect(readAgentSecrets(bx.fx.env, bx.a)?.token === A.token).toBe(true);
    expect(readAgentSecrets(bx.fx.env, bx.b)?.token === B.token).toBe(true);
    // Never written by new code (I4).
    expect(existsSync(resolve(configDir(bx.fx.env), "config.json"))).toBe(false);
    expect(existsSync(resolve(configDir(bx.fx.env), "credentials.json"))).toBe(false);
    expect(listAgentConnections(bx.fx.env).map((c) => c.record.runtimeId)).toEqual([A.runtime, B.runtime]);
    // Both files 0600, both outside the agent folders, the record free of the token.
    for (const dir of [bx.a, bx.b]) {
      expect(statSync(agentCredentialsPath(bx.fx.env, dir)).mode & 0o777).toBe(0o600);
      expect(agentConfigPath(bx.fx.env, dir).startsWith(`${agentsDir(bx.fx.env)}/`)).toBe(true);
    }
    expect(scanText("record", readFileSync(agentConfigPath(bx.fx.env, bx.a), "utf8"), A.token)).toEqual([]);
    expectNoLeaks(bx, [A.token, B.token]);
  });

  test("the key is the sanitized basename plus 16 hex of the canonical path", () => {
    const key = agentKey("/srv/agents/my agent!");
    expect(key).toMatch(/^my-agent-[0-9a-f]{16}$/);
    expect(agentKey("/x/a")).not.toBe(agentKey("/y/a"));
    expect(agentKey("/srv/agents/oddjob/")).toBe(agentKey("/srv/agents/oddjob"));
  });

  test("the record is a whitelist: a token on the config object never reaches it", () => {
    const secret = canary("tokW");
    const body = serializeAgentRecord({
      dir: "/x/a",
      suiteUrl: "https://one.example.invalid",
      runtimeId: "rt",
      headerNames: [],
      ...({ token: secret, headers: { Authorization: secret } } as object),
    });
    expect(scanText("record", body, secret)).toEqual([]);
    expect(Object.keys(JSON.parse(body))).toEqual(["dir", "suiteUrl", "runtimeId", "headerNames"]);
    expect(() =>
      serializeAgentRecord({ dir: "/x", suiteUrl: "u", runtimeId: "r", headerNames: [], tokenEnv: secret.replace("_", "-") }),
    ).toThrow();
  });

  test("a write refused by the git guard leaves nothing behind", () => {
    const bx = box();
    const probe: GitProbe = { repoRoot: () => "/fixture/repo", isIgnored: () => false };
    expect(() =>
      writeAgentConnection(bx.fx.env, bx.a, { suiteUrl: "u", runtimeId: "r", headerNames: [] }, { token: "t", headers: {} }, { probe }),
    ).toThrow(WriteRefused);
    expect(existsSync(agentsDir(bx.fx.env))).toBe(false);
  });

  test("a record at a folder's key that names another folder is ignored and reported", () => {
    const bx = box();
    writeAgentConnection(bx.fx.env, bx.b, { suiteUrl: "https://two.example.invalid", runtimeId: "rt-b", headerNames: [] }, { token: "", headers: {} });
    // Copy b/'s record to a/'s key, as a careless hand-edit would.
    mkdirSync(agentsDir(bx.fx.env), { recursive: true });
    writeFileSync(agentConfigPath(bx.fx.env, bx.a), readFileSync(agentConfigPath(bx.fx.env, bx.b)));
    const lookup = readAgentConnection(bx.fx.env, bx.a);
    expect(lookup.connection).toBeNull();
    expect(lookup.mismatched).toEqual([agentConfigPath(bx.fx.env, bx.a)]);
    expect(listAgentConnections(bx.fx.env).map((c) => c.record.dir)).toEqual([canonicalDir(bx.b)]);
  });

  test("a subfolder of a git work tree resolves to the work tree root's record", () => {
    const bx = box();
    mkdirSync(resolve(bx.a, ".git"));
    const sub = resolve(bx.a, "pkg", "deep");
    mkdirSync(sub, { recursive: true });
    writeAgentConnection(bx.fx.env, bx.a, { suiteUrl: "https://one.example.invalid", runtimeId: "rt-a", headerNames: [] }, { token: "", headers: {} });
    expect(readAgentConnection(bx.fx.env, sub).connection?.record.runtimeId).toBe("rt-a");
    expect(readAgentConnection(bx.fx.env, bx.b).connection).toBeNull();
  });

  test("listAgentConnections skips malformed files and never throws", () => {
    const bx = box();
    expect(listAgentConnections(bx.fx.env)).toEqual([]);
    mkdirSync(agentsDir(bx.fx.env), { recursive: true });
    writeFileSync(resolve(agentsDir(bx.fx.env), "junk-0000000000000000.json"), "{ nope");
    writeFileSync(resolve(agentsDir(bx.fx.env), "arr-0000000000000000.json"), "[]");
    writeAgentConnection(bx.fx.env, bx.a, { suiteUrl: "https://one.example.invalid", runtimeId: "rt-a", headerNames: [] }, { token: "", headers: {} });
    expect(listAgentConnections(bx.fx.env).map((c) => c.record.runtimeId)).toEqual(["rt-a"]);
  });

  test("the leak scan fires on a planted canary (positive control for the scans above)", () => {
    const bx = box();
    const secret = canary("plant");
    writeFileSync(resolve(bx.a, "planted.txt"), `x ${secret} y`);
    expect(scanTree(bx.a, secret).length).toBeGreaterThan(0);
    expect(scanTexts({ out: `token=${secret}` }, secret).length).toBeGreaterThan(0);
  });
});
