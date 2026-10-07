/**
 * PER-FOLDER CONNECTIONS, END TO END (01a113ef stage 2): `suite init --dir` and
 * `--from-mcp-json`, `suite status` agent lines, `suite watch` runtime_id, and
 * `suite restore` keeping every folder on its own runtime across boots.
 *
 * Every value is invented and every token is a random canary — the repository
 * is public. Tokens are compared in-test and never printed: a leak hit names
 * where and in which encoding, never the value.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentConfigFor,
  agentConfigPath,
  agentCredentialsPath,
  canonicalDir,
  readAgentConnection,
  readAgentSecrets,
  writeAgentConnection,
} from "../src/agent_connections.ts";
import { restoreWirer, runClaude, type ClaudeDeps } from "../src/commands/claude.ts";
import {
  CHANNEL_SERVER,
  MCP_JSON,
  TOOLS_SERVER,
  adoptMcpJson,
  channelWsUrl,
  claudeJsonPath,
  defaultCheckout,
  runInit,
  toolsHttpUrl,
  type InitOptions,
} from "../src/commands/init.ts";
import { runRestore, type RestoreDeps } from "../src/commands/restore.ts";
import { connectionsOf, runStatus, type StatusDeps } from "../src/commands/status.ts";
import { runWatch, runtimeIdResolver, type WatchDeps } from "../src/commands/watch.ts";
import { ensureConnection } from "../src/connection.ts";
import { emptyConfig, serializeConfig } from "../src/config.ts";
import { configDir } from "../src/paths.ts";
import { rosterPath, serializeRoster, type RosterEntry } from "../src/roster.ts";
import { createStore, spawnWithSecrets, TOKEN_KEY, type Prompter } from "../src/secrets.ts";
import { newSessionArgv, sessionNameFor, sessionNameFromConfig, type RunResult, type TmuxDeps } from "../src/tmux.ts";
import { cleanupCleanEnvs, createCleanEnv, stubsFor, type CleanEnv } from "./clean-env/fixture.ts";
import { canary, scanTexts, scanTree } from "./leak-scan.ts";

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

function mute(): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const refuse = async (question: string): Promise<string> => {
    asked.push(question);
    throw new Error(`prompted unexpectedly: ${question}`);
  };
  return { asked, ask: refuse, askSecret: refuse, say: () => {} };
}

const STUB = resolve(import.meta.dir, "fixtures", "stub_claude_local_scope.ts");

interface Box {
  fx: CleanEnv;
  a: string;
  b: string;
  c: string;
  output: string[];
}

/**
 * A scratch machine: two (three) agent folders, a plugin checkout already in
 * place (no clone), and a `claude` that REALLY writes local-scope entries.
 */
function box(): Box {
  const fx = createCleanEnv({ label: "perfolder", bodies: stubsFor(["git", "bun", "tmux"]) });
  // Not via fx.stub: the TS stub logs its own argv, and the shell prelude would log it twice.
  writeFileSync(resolve(fx.bin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} "$@"\n`, {
    mode: 0o755,
  });
  const checkout = defaultCheckout(fx.env);
  for (const d of [".git", "src", "node_modules"]) mkdirSync(resolve(checkout, d), { recursive: true });
  writeFileSync(resolve(checkout, "src/index.ts"), "");
  const mk = (n: string): string => {
    const d = resolve(fx.root, "w", n);
    mkdirSync(d, { recursive: true });
    return canonicalDir(d);
  };
  return { fx, a: mk("a"), b: mk("b"), c: mk("c"), output: [] };
}

async function initIn(bx: Box, cwd: string, agent: Agent | null, options: InitOptions = {}): Promise<number> {
  const store = createStore();
  const r = await runInit(
    {
      env: bx.fx.env,
      prompter: agent === null ? mute() : scripted([agent.url, agent.runtime, agent.token, ""]),
      store,
      platform: "linux",
      isTTY: false,
      cwd,
      out: (l) => void bx.output.push(l),
      err: (l) => void bx.output.push(l),
      run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: bx.fx.env }),
    },
    options,
  );
  return r.exitCode;
}

function seedLegacy(bx: Box, agent: Agent, extra: Record<string, unknown> = {}): void {
  const dir = configDir(bx.fx.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "config.json"),
    serializeConfig({ suiteUrl: agent.url, runtimeId: agent.runtime, headerNames: [], sessionNaming: "cwd", ...extra }),
  );
  writeFileSync(resolve(dir, "credentials.json"), `${JSON.stringify({ token: agent.token, headers: {} }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function claudeJson(bx: Box): string {
  return claudeJsonPath(bx.fx.env);
}

/** What ~/.claude.json says a folder's two entries name. Token compared, never returned. */
function namedBy(bx: Box, dir: string, agent: Agent): { runtime: string; url: string; tools: string; tokenMatches: boolean } {
  const raw = JSON.parse(readFileSync(claudeJson(bx), "utf8")) as {
    projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string>; url?: string; headers?: Record<string, string> }> }>;
  };
  const servers = raw.projects?.[dir]?.mcpServers ?? {};
  const ch = servers[CHANNEL_SERVER];
  const tl = servers[TOOLS_SERVER];
  return {
    runtime: ch?.env?.SUITE_RUNTIME_ID ?? "",
    url: ch?.env?.SUITE_URL ?? "",
    tools: tl?.url ?? "",
    tokenMatches: ch?.env?.SUITE_TOKEN === agent.token && tl?.headers?.Authorization === `Bearer ${agent.token}`,
  };
}

function expectNames(bx: Box, dir: string, agent: Agent): void {
  const got = namedBy(bx, dir, agent);
  expect({ runtime: got.runtime, url: got.url, tools: got.tools }).toEqual({
    runtime: agent.runtime,
    url: channelWsUrl(agent.url),
    tools: toolsHttpUrl(agent.url),
  });
  expect(got.tokenMatches).toBe(true);
}

function adds(bx: Box): string[][] {
  return bx.fx
    .log()
    .map((l) => l.split("\t"))
    .filter((p) => p[0] === "claude" && p[1] === "mcp" && p[2] === "add");
}

function expectNoLeaks(bx: Box, secrets: string[], exclude: string[] = []): void {
  for (const secret of secrets) {
    for (const dir of [bx.a, bx.b, bx.c]) expect(scanTree(dir, secret, { exclude })).toEqual([]);
    expect(scanTexts({ output: bx.output.join("\n") }, secret)).toEqual([]);
  }
}

function bytesOrAbsent(path: string): Buffer | "absent" {
  return existsSync(path) ? readFileSync(path) : "absent";
}

function same(x: Buffer | "absent", y: Buffer | "absent"): boolean {
  if (x === "absent" || y === "absent") return x === y;
  return x.equals(y);
}

/* ------------------------------------------------------------------------- */

describe("init is per folder", () => {
  test("ISOLATION: init B in b/ leaves a/'s record, a/'s credentials, config.json and ~/.claude.json byte-equal", async () => {
    const { A, B } = agents();
    const bx = box();
    expect(await initIn(bx, bx.a, A)).toBe(0);
    writeFileSync(claudeJson(bx), JSON.stringify({ projects: {} }), { mode: 0o600 });
    const paths = [
      agentConfigPath(bx.fx.env, bx.a),
      agentCredentialsPath(bx.fx.env, bx.a),
      resolve(configDir(bx.fx.env), "config.json"),
      resolve(configDir(bx.fx.env), "credentials.json"),
      claudeJson(bx),
    ];
    const before = paths.map(bytesOrAbsent);
    // config.json and credentials.json were never written: absence is part of what must be preserved.
    expect(before[2]).toBe("absent");
    expect(before[3]).toBe("absent");

    expect(await initIn(bx, bx.b, B)).toBe(0);

    const after = paths.map(bytesOrAbsent);
    for (let i = 0; i < paths.length; i++) expect(same(before[i] as Buffer, after[i] as Buffer)).toBe(true);
    expect(readAgentConnection(bx.fx.env, bx.b).connection?.record.runtimeId).toBe(B.runtime);
    expectNoLeaks(bx, [A.token, B.token]);
  });

  test("init names the agent it connected and how to start it", async () => {
    const { A } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    const text = bx.output.join("\n");
    expect(text).toContain(`agent ${bx.a} connected as ${A.runtime} (${A.url})`);
    expect(text).toContain(`cd ${bx.a} && suite claude`);
    expect(text).not.toContain("home folder");
  });

  test("--dir from an unrelated cwd records the named folder and no other", async () => {
    const { A } = agents();
    const bx = box();
    const elsewhere = resolve(bx.fx.root, "elsewhere");
    mkdirSync(elsewhere);
    expect(await initIn(bx, elsewhere, A, { dir: bx.a })).toBe(0);
    expect(readAgentConnection(bx.fx.env, bx.a).connection?.record.runtimeId).toBe(A.runtime);
    expect(readAgentConnection(bx.fx.env, elsewhere).connection).toBeNull();
    // Relative --dir resolves against the cwd.
    expect(await initIn(bx, resolve(bx.fx.root, "w"), { ...A, runtime: "rt-b-rel" }, { dir: "b" })).toBe(0);
    expect(readAgentConnection(bx.fx.env, bx.b).connection?.record.runtimeId).toBe("rt-b-rel");
    expect(readAgentConnection(bx.fx.env, bx.a).connection?.record.runtimeId).toBe(A.runtime);
  });

  test("init in $HOME warns that agents in other folders will not use it", async () => {
    const { A } = agents();
    const bx = box();
    await initIn(bx, bx.fx.home, A);
    expect(bx.output.join("\n")).toContain("agents in OTHER folders will not use this connection");
  });
});

/* ------------------------------------------------------------------------- */

function mcpJson(bx: Box, agent: Agent, override: { channelToken?: string; toolsToken?: string; toolsUrl?: string; dropTools?: boolean } = {}): string {
  const servers: Record<string, unknown> = {
    [CHANNEL_SERVER]: {
      command: "bun",
      args: [resolve(defaultCheckout(bx.fx.env), "src", "index.ts")],
      env: {
        SUITE_URL: channelWsUrl(agent.url),
        SUITE_RUNTIME_ID: agent.runtime,
        SUITE_TOKEN: override.channelToken ?? agent.token,
      },
    },
  };
  if (!override.dropTools) {
    servers[TOOLS_SERVER] = {
      type: "http",
      url: override.toolsUrl ?? toolsHttpUrl(agent.url),
      headers: { Authorization: `Bearer ${override.toolsToken ?? agent.token}`, "X-Org": "org-fixture" },
    };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

describe("init --from-mcp-json", () => {
  test("adopts the folder's own .mcp.json: runtime, url, token, headers; prints no token", async () => {
    const { A } = agents();
    const bx = box();
    const file = resolve(bx.a, MCP_JSON);
    writeFileSync(file, mcpJson(bx, A));
    expect(await initIn(bx, bx.a, null, { fromMcpJson: true, noSupervisor: true })).toBe(0);
    const record = readAgentConnection(bx.fx.env, bx.a).connection?.record;
    expect(record?.runtimeId).toBe(A.runtime);
    expect(record?.suiteUrl).toBe(A.url);
    expect(record?.headerNames).toEqual(["X-Org"]);
    const secrets = readAgentSecrets(bx.fx.env, bx.a);
    expect(secrets?.token === A.token).toBe(true);
    expect(secrets?.headers).toEqual({ "X-Org": "org-fixture" });
    expect(bx.output.join("\n")).toContain(`agent ${bx.a} connected as ${A.runtime} (${A.url})`);
    // The token is in .mcp.json because the operator put it there; nowhere else in the folder, nowhere in output.
    expectNoLeaks(bx, [A.token], [file]);
  });

  test("a ${VAR} reference is recorded as tokenEnv, never resolved", async () => {
    const { A } = agents();
    const bx = box();
    writeFileSync(resolve(bx.a, MCP_JSON), mcpJson(bx, A, { channelToken: "${AGENT_A_TOKEN}", toolsToken: "${AGENT_A_TOKEN}" }));
    bx.fx.env.AGENT_A_TOKEN = A.token;
    expect(await initIn(bx, bx.a, null, { fromMcpJson: true })).toBe(0);
    expect(readAgentConnection(bx.fx.env, bx.a).connection?.record.tokenEnv).toBe("AGENT_A_TOKEN");
    expect(readAgentSecrets(bx.fx.env, bx.a)?.token).toBe("");
    expectNoLeaks(bx, [A.token]);
  });

  const refusals: Array<[string, (bx: Box, A: Agent) => string, string]> = [
    ["disagreeing tokens", (bx, A) => mcpJson(bx, A, { toolsToken: canary("other") }), "differ"],
    ["a missing tools entry", (bx, A) => mcpJson(bx, A, { dropTools: true }), `the ${TOOLS_SERVER} entry is missing`],
    ["different hosts", (bx, A) => mcpJson(bx, A, { toolsUrl: "https://two.example.invalid/mcp" }), "different hosts"],
  ];
  for (const [name, body, says] of refusals) {
    test(`refuses ${name}: non-zero, names the field, writes nothing, leaks nothing`, async () => {
      const { A } = agents();
      const bx = box();
      const file = resolve(bx.a, MCP_JSON);
      const text = body(bx, A);
      writeFileSync(file, text);
      const code = await initIn(bx, bx.a, null, { fromMcpJson: true });
      expect(code).not.toBe(0);
      expect(bx.output.join("\n")).toContain(says);
      expect(bx.output.join("\n")).toContain("nothing was written");
      expect(existsSync(resolve(configDir(bx.fx.env), "agents"))).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(text);
      // Neither the channel token nor any other token string from the file reaches output.
      const tokens = [A.token, ...[...text.matchAll(/(other_[0-9a-f]{40})/g)].map((m) => m[1] as string)];
      expectNoLeaks(bx, tokens, [file]);
    });
  }

  test("a missing .mcp.json refuses without writing", async () => {
    const bx = box();
    expect(await initIn(bx, bx.a, null, { fromMcpJson: true })).not.toBe(0);
    expect(existsSync(resolve(configDir(bx.fx.env), "agents"))).toBe(false);
  });

  test("adoptMcpJson names fields, never values", () => {
    const secret = canary("val");
    const r = adoptMcpJson(
      JSON.stringify({
        mcpServers: {
          [CHANNEL_SERVER]: { env: { SUITE_TOKEN: secret } },
          [TOOLS_SERVER]: { url: "https://one.example.invalid/mcp", headers: { Authorization: `Bearer ${canary("b")}` } },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join("\n")).toContain("SUITE_RUNTIME_ID is missing");
      expect(scanTexts({ problems: r.problems.join("\n") }, secret)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------- */

describe("ensureConnection never borrows the legacy or a neighbour's identity (M1b)", () => {
  test("empty b/ with legacy B and a recorded a/: b/ is asked fresh, saved as itself, and a/ is untouched", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    seedLegacy(bx, B);
    const recordA = readFileSync(agentConfigPath(bx.fx.env, bx.a));
    const secretsA = readFileSync(agentCredentialsPath(bx.fx.env, bx.a));
    const C: Agent = { url: "https://three.example.invalid", runtime: "rt-c-00000000", token: canary("tokC") };
    // URL left blank: the URL MAY default from the legacy install. The runtime and token may not.
    const prompter = scripted(["", C.runtime, C.token, ""]);
    const store = createStore();
    const out: string[] = [];

    const ensured = await ensureConnection({ env: bx.fx.env, prompter, store, out: (l) => void out.push(l) }, bx.b);

    expect(ensured.prompted).toBe(true);
    expect(ensured.config.runtimeId).toBe(C.runtime);
    expect(ensured.dir).toBe(bx.b);
    const idQuestion = prompter.asked.find((q) => q.startsWith("runtime id")) ?? "";
    expect(idQuestion).toBe("runtime id: ");
    for (const q of prompter.asked) expect(q.includes(B.runtime) || q.includes(A.runtime)).toBe(false);
    const saved = readAgentConnection(bx.fx.env, bx.b).connection?.record;
    expect(saved?.runtimeId).toBe(C.runtime);
    expect(saved?.suiteUrl).toBe(B.url);
    expect(readAgentSecrets(bx.fx.env, bx.b)?.token === C.token).toBe(true);
    expect(readAgentSecrets(bx.fx.env, bx.b)?.token === B.token).toBe(false);
    expect(readFileSync(agentConfigPath(bx.fx.env, bx.a)).equals(recordA)).toBe(true);
    expect(readFileSync(agentCredentialsPath(bx.fx.env, bx.a)).equals(secretsA)).toBe(true);
    expect(scanTexts({ out: out.join("\n") }, B.token)).toEqual([]);
  });

  test("a recorded folder is answered from its record with no prompt, even with legacy B present", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    seedLegacy(bx, B);
    const store = createStore();
    const ensured = await ensureConnection({ env: bx.fx.env, prompter: mute(), store, out: () => {} }, bx.a);
    expect(ensured.prompted).toBe(false);
    expect(ensured.config.runtimeId).toBe(A.runtime);
    expect(store.get(TOKEN_KEY) === A.token).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */

interface FakeTmux {
  tmux: TmuxDeps;
  calls: string[][];
}

/** A tmux with no sessions, where new-session "succeeds" and is recorded. */
function fakeTmux(): FakeTmux {
  const calls: string[][] = [];
  return {
    calls,
    tmux: {
      env: {},
      which: (name) => (name === "tmux" || name === "claude" ? `/fixture/bin/${name}` : null),
      run: async (argv): Promise<RunResult> => {
        calls.push(argv);
        // No session exists, before or after: has-session always answers no.
        return { exitCode: argv[1] === "has-session" ? 1 : 0, stdout: "", stderr: "" };
      },
    },
  };
}

function rosterFor(bx: Box, dirs: string[]): RosterEntry[] {
  // Exactly what claude.ts recordLaunch stores: the tmux new-session argv, whose pane runs `claude` itself.
  return dirs.map((cwd, i) => {
    const session = `suite-agent${i}`;
    return {
      session,
      command: newSessionArgv({ session, command: ["claude", "--continue"], cwd }),
      cwd,
      kind: "claude",
      recordedAt: "2026-10-06T00:00:00.000Z",
    };
  });
}

async function restoreOnce(bx: Box, roster: RosterEntry[], order: string[]): Promise<{ failed: string[] }> {
  const ft = fakeTmux();
  const log: string[] = [];
  const wire = restoreWirer(bx.fx.env, (l) => void log.push(l));
  const deps: RestoreDeps = {
    tmux: {
      ...ft.tmux,
      run: async (argv) => {
        if (argv[1] === "new-session") order.push(`start ${argv[argv.indexOf("-c") + 1]}`);
        return ft.tmux.run(argv);
      },
    },
    readRoster: () => serializeRoster(roster),
    writeRoster: () => {},
    now: () => new Date("2026-10-06T00:00:00Z"),
    log: (l) => void log.push(l),
    wire: async (entry) => {
      order.push(`wire ${entry.cwd}`);
      return wire(entry);
    },
  };
  bx.output.push(...log);
  const r = await runRestore(deps, bx.fx.home, { apply: true });
  bx.output.push(...log);
  return { failed: r.failed };
}

describe("restore keeps every folder on its own runtime", () => {
  test("RESTORE CYCLES: a/, b/, a/, b/ for 3 rounds; each folder names itself after every round; rounds 2 and 3 add nothing", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    await initIn(bx, bx.b, B);
    seedLegacy(bx, B);
    const roster = rosterFor(bx, [bx.a, bx.b]);
    const perRound: number[] = [];
    for (let round = 1; round <= 3; round++) {
      const before = adds(bx).length;
      const order: string[] = [];
      const r = await restoreOnce(bx, roster, order);
      expect(r.failed).toEqual([]);
      expect(order).toEqual([`wire ${bx.a}`, `start ${bx.a}`, `wire ${bx.b}`, `start ${bx.b}`]);
      expectNames(bx, bx.a, A);
      expectNames(bx, bx.b, B);
      perRound.push(adds(bx).length - before);
    }
    expect(perRound).toEqual([4, 0, 0]);
    expectNoLeaks(bx, [A.token, B.token]);
  });

  test("a folder 0.7.0 cross-wired comes back as itself: restore rewires it from its record BEFORE the replay", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    await initIn(bx, bx.b, B);
    await restoreOnce(bx, rosterFor(bx, [bx.a, bx.b]), []);
    // Cross-wire a/ to B by hand, exactly what the 0.7.0 bug left behind.
    const raw = JSON.parse(readFileSync(claudeJson(bx), "utf8")) as { projects: Record<string, unknown> };
    raw.projects[bx.a] = raw.projects[bx.b];
    writeFileSync(claudeJson(bx), JSON.stringify(raw), { mode: 0o600 });
    expect(namedBy(bx, bx.a, B).runtime).toBe(B.runtime);

    const before = adds(bx).length;
    const order: string[] = [];
    await restoreOnce(bx, rosterFor(bx, [bx.a, bx.b]), order);

    expect(order.indexOf(`wire ${bx.a}`)).toBeLessThan(order.indexOf(`start ${bx.a}`));
    expectNames(bx, bx.a, A);
    expectNames(bx, bx.b, B);
    const added = adds(bx).slice(before);
    // Each stale entry: an add refused as "already exists", a local remove, the add again.
    expect([...new Set(added.map((p) => p[3]))].sort()).toEqual([CHANNEL_SERVER, TOOLS_SERVER].sort());
    expect(added.some((p) => p.join("\t").includes(B.token))).toBe(false);
    expect(added.some((p) => p.join("\t").includes(B.runtime))).toBe(false);
    expectNoLeaks(bx, [A.token, B.token]);
  });

  test("an unrecorded folder with entries is left as it is and still started (I2)", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    seedLegacy(bx, B);
    await restoreOnce(bx, rosterFor(bx, [bx.a]), []);
    // c/ carries entries but no record (as an agent set up by hand would).
    const raw = JSON.parse(readFileSync(claudeJson(bx), "utf8")) as { projects: Record<string, unknown> };
    raw.projects[bx.c] = raw.projects[bx.a];
    writeFileSync(claudeJson(bx), JSON.stringify(raw), { mode: 0o600 });
    const bytes = readFileSync(claudeJson(bx));
    const before = adds(bx).length;
    const order: string[] = [];
    const r = await restoreOnce(bx, rosterFor(bx, [bx.c]), order);
    expect(r.failed).toEqual([]);
    expect(order).toEqual([`wire ${bx.c}`, `start ${bx.c}`]);
    expect(adds(bx).length).toBe(before);
    expect(readFileSync(claudeJson(bx)).equals(bytes)).toBe(true);
    expect(readAgentConnection(bx.fx.env, bx.c).connection).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */

function statusDeps(bx: Box, lines: string[]): StatusDeps {
  const which = (): string | null => null;
  return {
    env: bx.fx.env,
    cwd: bx.a,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    which,
    exists: () => true,
    config: null,
    configFile: resolve(configDir(bx.fx.env), "config.json"),
    tmux: { env: {}, which, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    probe: async () => {
      throw new Error("status does not probe");
    },
    color: false,
    utf8: true,
    out: (l) => void lines.push(l),
  };
}

describe("status lists every agent folder", () => {
  test("two records plus a legacy connection: two agent lines, one legacy line, never a token", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    await initIn(bx, bx.b, B);
    const L: Agent = { url: "https://legacy.example.invalid", runtime: "rt-legacy-0000", token: canary("tokL") };
    seedLegacy(bx, L);
    const lines: string[] = [];
    await runStatus(statusDeps(bx, lines), 1_800_000_000);
    const text = lines.join("\n");
    expect(text).toMatch(/agents\s+2/);
    const lineA = lines.find((l) => l.includes(bx.a)) ?? "";
    const lineB = lines.find((l) => l.includes(bx.b)) ?? "";
    expect(lineA).toContain(A.runtime);
    expect(lineA).toContain(A.url);
    expect(lineB).toContain(B.runtime);
    expect(lineB).toContain(B.url);
    const legacy = lines.filter((l) => l.includes(L.runtime));
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toContain("legacy");
    expect(legacy[0]).toContain("not assigned to any folder; run suite init in each agent folder");
    expect(text).not.toContain("not federated");
    for (const t of [A.token, B.token, L.token]) expect(scanTexts({ text }, t)).toEqual([]);
  });

  test("legacy only: no agent line claims the legacy runtime, and it is not 'not federated'", async () => {
    const bx = box();
    const L: Agent = { url: "https://legacy.example.invalid", runtime: "rt-legacy-0000", token: canary("tokL") };
    seedLegacy(bx, L);
    const lines: string[] = [];
    await runStatus(statusDeps(bx, lines), 1_800_000_000);
    expect(lines.join("\n")).toMatch(/agents\s+0/);
    expect(lines.filter((l) => l.includes(L.runtime))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("not federated");
    expect(connectionsOf(bx.fx.env).records).toEqual([]);
  });

  test("nothing at all is 'not federated'", async () => {
    const bx = box();
    const lines: string[] = [];
    expect(await runStatus(statusDeps(bx, lines), 1_800_000_000)).toBe(1);
    expect(lines.join("\n")).toContain("not federated");
  });
});

/* ------------------------------------------------------------------------- */

const HALT_TAIL = '{"type":"assistant","message":{"content":[{"type":"text","text":"Prompt is too long"}]}}\n';

function watchDeps(bx: Box, targets: Array<[string, string]>, halted: string): WatchDeps {
  const projects = resolve(bx.fx.home, ".claude", "projects");
  return {
    tmux: {
      env: {},
      which: (n) => (n === "tmux" ? "/fixture/bin/tmux" : null),
      run: async (argv): Promise<RunResult> => {
        const fmt = argv[argv.length - 1] ?? "";
        if (argv[1] === "list-panes" && fmt.includes("pane_current_path")) {
          return { exitCode: 0, stdout: targets.map(([s, c]) => `${s}\t${c}`).join("\n"), stderr: "" };
        }
        if (argv[1] === "list-panes" && fmt.includes("pane_pid")) {
          return { exitCode: 0, stdout: targets.map(([s], i) => `${s}\t${100 + i}`).join("\n"), stderr: "" };
        }
        if (argv[0] === "ps") {
          return { exitCode: 0, stdout: targets.map((_, i) => `${100 + i} 1 4096 sh`).join("\n"), stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    },
    now: () => new Date("2026-10-06T00:00:00Z"),
    sleep: async () => {},
    post: async () => 200,
    readTail: () => HALT_TAIL,
    realpath: (p) => p,
    listProjectDirs: () => [resolve(projects, halted.replace(/[^a-zA-Z0-9-]/g, "-"))],
    newestTranscript: (dir) => ({ path: `${dir}/s1.jsonl`, bytes: 10 }),
    log: () => {},
    runtimeIdFor: runtimeIdResolver(bx.fx.env),
  };
}

describe("watch events carry the folder's runtime", () => {
  test("a recorded cwd carries its runtime_id; an unrecorded cwd carries null even with a legacy global", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    seedLegacy(bx, B);
    const events = await runWatch(watchDeps(bx, [["suite-a", bx.a], ["suite-c", bx.c]], bx.a), {
      apply: false,
      config: emptyConfig(),
      auth: null,
      host: "fixture-host",
      home: bx.fx.home,
    });
    const halt = events.find((e) => e.event_kind === "halt");
    expect(halt?.session).toBe("suite-a");
    expect(halt?.runtime_id).toBe(A.runtime);
    const sampleC = events.find((e) => e.session === "suite-c");
    expect(sampleC?.event_kind).toBe("sample");
    expect(sampleC?.runtime_id).toBeNull();
    expect(events.some((e) => e.runtime_id === B.runtime)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */

describe("session naming", () => {
  test("sessionNaming runtime names the session from the folder's record, not the legacy runtime", async () => {
    const { A, B } = agents();
    const bx = box();
    await initIn(bx, bx.a, A);
    seedLegacy(bx, B, { sessionNaming: "runtime" });
    const config = agentConfigFor(bx.fx.env, bx.a);
    expect(config.sessionNaming).toBe("runtime");
    const name = sessionNameFromConfig(config, bx.a);
    expect(name).toBe(sessionNameFor({ naming: "runtime", cwd: bx.a, runtimeId: A.runtime }));
    expect(name).not.toBe(sessionNameFor({ naming: "runtime", cwd: bx.a, runtimeId: B.runtime }));

    // And through `suite claude` itself: the session it creates carries A's name.
    const ft = fakeTmux();
    const store = createStore();
    const deps: ClaudeDeps = {
      tmux: ft.tmux,
      env: bx.fx.env,
      cwd: bx.a,
      store,
      config: emptyConfig(),
      statePath: resolve(bx.fx.root, "state.json"),
      color: false,
      platform: "linux",
      prompter: mute(),
      sleep: async () => {},
      out: (l) => void bx.output.push(l),
      err: (l) => void bx.output.push(l),
      exec: async () => 0,
      wiring: { run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: bx.fx.env }), isTTY: false, canPrompt: false },
    };
    await runClaude(deps, { userArgs: [], force: false });
    const created = ft.calls.find((c) => c[1] === "new-session") ?? [];
    expect(created[created.indexOf("-s") + 1]).toBe(name);
    expectNoLeaks(bx, [A.token, B.token]);
  });
});

/* ------------------------------------------------------------------------- */

test("the local-scope stub really writes and reads back (positive control for the cycle tests)", async () => {
  const { A } = agents();
  const bx = box();
  await initIn(bx, bx.a, A);
  await restoreOnce(bx, rosterFor(bx, [bx.a]), []);
  expectNames(bx, bx.a, A);
  expect(adds(bx).length).toBe(2);
});
