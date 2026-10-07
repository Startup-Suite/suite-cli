/**
 * EVERY AGENT, AND WHETHER EACH IS WIRED AS ITSELF (01a113ef stage 3):
 * doctor's `agents` check and `suite status --json`.
 *
 * Every value is invented and every token is a random canary — the repository
 * is public. Tokens are compared in-test and never printed: a leak hit names
 * where and in which encoding, never the value.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalDir,
  legacyConnection,
  listAgentConnections,
  readAgentConnection,
  writeAgentConnection,
} from "../src/agent_connections.ts";
import {
  ROOT_CONFIG_FILE,
  folderWiring,
  inventoryRows,
  parseClaudeJson,
  parseMcpJson,
  type InventorySource,
} from "../src/agent_inventory.ts";
import { AGENT_CONFIG_FILE } from "../src/commands/deepseek.ts";
import {
  agentsVerdict,
  liveDoctorDeps,
  liveInventorySource,
  runChecks,
  type CheckResult,
  type DoctorDeps,
} from "../src/commands/doctor.ts";
import { CHANNEL_SERVER, TOOLS_SERVER, channelWsUrl, claudeJsonPath, toolsHttpUrl } from "../src/commands/init.ts";
import {
  AGENT_FIELDS,
  STATUS_FIELDS,
  renderStatusDocument,
  statusDocument,
  type StatusDocument,
} from "../src/commands/status.ts";
import { serializeConfig, emptyConfig } from "../src/config.ts";
import { configPath } from "../src/paths.ts";
import { rosterPath, serializeRoster, type RosterEntry } from "../src/roster.ts";
import { sessionNameFor } from "../src/tmux.ts";
import { listFiles } from "./leak-scan.ts";
import { cleanupCleanEnvs, createCleanEnv, stubsFor, type CleanEnv } from "./clean-env/fixture.ts";
import { canary, scanTexts, scanTree } from "./leak-scan.ts";

afterEach(cleanupCleanEnvs);

interface Agent {
  url: string;
  runtime: string;
  token: string;
}

function agents(): { A: Agent; B: Agent; C: Agent } {
  return {
    A: { url: "https://one.example.invalid", runtime: "rt-a-00000000", token: canary("tokA") },
    B: { url: "https://two.example.invalid", runtime: "rt-b-00000000", token: canary("tokB") },
    C: { url: "https://one.example.invalid", runtime: "rt-c-00000000", token: canary("tokC") },
  };
}

interface Box {
  fx: CleanEnv;
  a: string;
  b: string;
  c: string;
  elsewhere: string;
}

function box(): Box {
  const fx = createCleanEnv({ label: "inventory", bodies: stubsFor(["tmux"]) });
  const mk = (n: string): string => {
    const d = resolve(fx.root, "w", n);
    mkdirSync(d, { recursive: true });
    return canonicalDir(d);
  };
  return { fx, a: mk("a"), b: mk("b"), c: mk("c"), elsewhere: mk("elsewhere") };
}

function record(bx: Box, dir: string, agent: Agent): void {
  writeAgentConnection(bx.fx.env, dir, { suiteUrl: agent.url, runtimeId: agent.runtime, headerNames: [] }, {
    token: agent.token,
    headers: {},
  });
}

/** The two Suite entries `suite claude` writes, naming `agent`. Carries its token, as the real file does. */
function servers(agent: Agent): Record<string, unknown> {
  return {
    [CHANNEL_SERVER]: {
      type: "stdio",
      command: "bun",
      args: ["run", "/fixture/plugin/src/index.ts"],
      env: { SUITE_URL: channelWsUrl(agent.url), SUITE_RUNTIME_ID: agent.runtime, SUITE_TOKEN: agent.token },
    },
    [TOOLS_SERVER]: { type: "http", url: toolsHttpUrl(agent.url), headers: { Authorization: `Bearer ${agent.token}` } },
  };
}

function writeClaudeJson(bx: Box, projects: Record<string, Agent>, user: Agent | null = null): void {
  const body: Record<string, unknown> = {
    projects: Object.fromEntries(Object.entries(projects).map(([dir, ag]) => [dir, { mcpServers: servers(ag) }])),
  };
  if (user !== null) body.mcpServers = { [CHANNEL_SERVER]: (servers(user) as Record<string, unknown>)[CHANNEL_SERVER] };
  writeFileSync(claudeJsonPath(bx.fx.env), JSON.stringify(body, null, 2), { mode: 0o600 });
}

function writeMcpJson(dir: string, agent: Agent): void {
  writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers(agent) }, null, 2));
}

function writeLegacy(bx: Box, agent: Agent): void {
  mkdirSync(resolve(configPath(bx.fx.env), ".."), { recursive: true });
  writeFileSync(
    configPath(bx.fx.env),
    serializeConfig({ ...emptyConfig(), suiteUrl: agent.url, runtimeId: agent.runtime }),
  );
  writeFileSync(resolve(configPath(bx.fx.env), "..", "credentials.json"), JSON.stringify({ token: agent.token }), {
    mode: 0o600,
  });
}

function writeRoster(bx: Box, entries: RosterEntry[]): void {
  const path = rosterPath(bx.fx.home);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, serializeRoster(entries));
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** sha256 of ~/.claude.json and every file under the agent store. */
function fingerprints(bx: Box): Record<string, string> {
  const out: Record<string, string> = { claude: sha(claudeJsonPath(bx.fx.env)) };
  for (const f of listFiles(resolve(configPath(bx.fx.env), "..", "agents"))) out[f] = sha(f);
  return out;
}

/** Doctor deps over the scratch box: every argv recorded, no claude on PATH, the LIVE inventory. */
function doctorDeps(bx: Box, cwd: string): DoctorDeps & { lines: string[]; argvs: string[][] } {
  const lines: string[] = [];
  const argvs: string[][] = [];
  const run = async (argv: string[]) => {
    argvs.push([...argv]);
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const own = readAgentConnection(bx.fx.env, cwd).connection;
  return {
    env: bx.fx.env,
    cwd,
    run,
    probe: async () => {
      throw new Error("no probe in this test");
    },
    which: () => null,
    exists: () => false,
    config: own === null ? null : { ...emptyConfig(), suiteUrl: own.record.suiteUrl, runtimeId: own.record.runtimeId },
    configFile: "/fixture",
    inventory: () => liveInventorySource(bx.fx.env),
    tmux: { env: {}, which: () => null, run },
    color: false,
    utf8: true,
    lines,
    argvs,
    out: (line) => void lines.push(line),
  };
}

function byId(checks: CheckResult[], id: string): CheckResult {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no ${id} check`);
  return c;
}

function failText(c: CheckResult): string {
  if (c.status !== "fail") return "";
  return [c.value, c.detail ?? "", ...c.consequence, c.remedy].join("\n");
}

/* ------------------------------------------------------------------------- */
/* doctor                                                                     */
/* ------------------------------------------------------------------------- */

describe("doctor: the agents check", () => {
  test("flags rock's state: a/ recorded A, a/ entries name B, a/.mcp.json names A, plus a user-scope entry", async () => {
    const bx = box();
    const { A, B } = agents();
    record(bx, bx.a, A);
    record(bx, bx.b, B);
    writeClaudeJson(bx, { [bx.a]: B, [bx.b]: B }, B);
    writeMcpJson(bx.a, A);
    const before = fingerprints(bx);

    const deps = doctorDeps(bx, bx.a);
    const checks = await runChecks(deps);
    const agentsCheck = byId(checks, "agents");
    expect(agentsCheck.status).toBe("fail");
    const text = failText(agentsCheck);
    expect(text).toContain("cross-wired");
    expect(text).toContain(bx.a);
    // Both ids named, by which source names them.
    expect(text).toContain(`recorded ${A.runtime}`);
    expect(text).toContain(`entry ${B.runtime}`);
    expect(text).toContain(`.mcp.json ${A.runtime}`);
    expect(text).toContain(`user-scope ${CHANNEL_SERVER} names ${B.runtime}`);
    expect(agentsCheck.status === "fail" && agentsCheck.remedy).toBe(`cd ${bx.a} && suite init --from-mcp-json`);
    // b/ is wired as itself and is not reported as cross-wired.
    expect(text).not.toContain(`${bx.b}:`);

    // Read-only: no byte changed, nothing was run — so no `claude mcp add`, and no `claude mcp get/list` either.
    expect(fingerprints(bx)).toEqual(before);
    expect(deps.argvs.filter((a) => a.includes("add"))).toEqual([]);
    expect(deps.argvs.filter((a) => a.some((w) => w.endsWith("claude")))).toEqual([]);
    // I1: no token in any output line, and none inside an agent folder other than the .mcp.json the test wrote.
    const out = deps.lines.join("\n");
    for (const ag of [A, B]) {
      expect(scanTexts({ doctor: out, check: text }, ag.token)).toEqual([]);
      expect(scanTree(bx.b, ag.token)).toEqual([]);
      expect(scanTree(bx.a, ag.token, { exclude: [resolve(bx.a, ".mcp.json")] })).toEqual([]);
    }
  });

  test("from b/, the user-scope entry is still reported and b/ is not called cross-wired", async () => {
    const bx = box();
    const { A, B } = agents();
    record(bx, bx.a, A);
    record(bx, bx.b, B);
    writeClaudeJson(bx, { [bx.a]: A, [bx.b]: B }, B);
    const c = byId(await runChecks(doctorDeps(bx, bx.b)), "agents");
    expect(c.status).toBe("fail");
    expect(c.status === "fail" && c.value).toBe("user-scope entry");
    expect(failText(c)).not.toContain(`${bx.b}:`);
  });

  test("a clean two-agent box passes", async () => {
    const bx = box();
    const { A, B } = agents();
    record(bx, bx.a, A);
    record(bx, bx.b, B);
    writeClaudeJson(bx, { [bx.a]: A, [bx.b]: B });
    writeMcpJson(bx.a, A);
    const c = byId(await runChecks(doctorDeps(bx, bx.a)), "agents");
    expect(c.status).toBe("pass");
    expect(c.status === "pass" && c.detail).toBe("2 folders, 2 recorded");
  });

  test("a host mismatch alone is cross-wiring, even with the right runtime id", async () => {
    const bx = box();
    const { A } = agents();
    record(bx, bx.a, A);
    writeClaudeJson(bx, { [bx.a]: { ...A, url: "https://elsewhere.example.invalid" } });
    const c = byId(await runChecks(doctorDeps(bx, bx.a)), "agents");
    expect(c.status === "fail" && c.value).toBe("cross-wired");
  });

  test("an unrecorded folder whose entries disagree with its own .mcp.json is cross-wired too", async () => {
    const bx = box();
    const { A, B } = agents();
    writeClaudeJson(bx, { [bx.c]: B });
    writeMcpJson(bx.c, A);
    const c = byId(await runChecks(doctorDeps(bx, bx.c)), "agents");
    expect(c.status === "fail" && c.value).toBe("cross-wired");
    expect(failText(c)).toContain(bx.c);
  });

  test("an unreadable ~/.claude.json is a skip, never a pass", async () => {
    const bx = box();
    const { A } = agents();
    record(bx, bx.a, A);
    writeFileSync(claudeJsonPath(bx.fx.env), "{ not json");
    const c = byId(await runChecks(doctorDeps(bx, bx.a)), "agents");
    expect(c.status).toBe("skip");
  });

  test("with no inventory supplied the check is skipped, not guessed", async () => {
    const bx = box();
    const deps = doctorDeps(bx, bx.a);
    delete (deps as Partial<DoctorDeps>).inventory;
    expect(byId(await runChecks(deps), "agents").status).toBe("skip");
  });

  test("the LIVE doctor deps read the agent inventory, and this folder's record — never the legacy connection", async () => {
    const bx = box();
    const { A, B } = agents();
    writeLegacy(bx, B);
    record(bx, bx.a, A);
    writeClaudeJson(bx, { [bx.a]: B });
    const live = await liveDoctorDeps(bx.fx.env, bx.a);
    expect(live.inventory).toBeDefined();
    expect(live.config?.runtimeId).toBe(A.runtime);
    expect(live.tokenSaved).toBe(true);
    // An unrecorded folder is NOT connected, whatever the legacy connection says.
    const elsewhere = await liveDoctorDeps(bx.fx.env, bx.elsewhere);
    expect(elsewhere.config?.runtimeId).toBe("");
    expect(elsewhere.tokenSaved).toBe(false);
    const quiet = { which: () => null, run: async () => ({ exitCode: 1, stdout: "", stderr: "" }), out: () => {} };
    const c = byId(await runChecks({ ...live, ...quiet }), "agents");
    expect(c.status === "fail" && c.value).toBe("cross-wired");
  });

  test("agentsVerdict is fail on cross-wiring and pass on match, from rows alone", () => {
    const row = (wiring: "match" | "cross_wired") => ({
      session: "s",
      kind: null,
      root: "/fixture/x",
      runtime_id: "rt-x",
      suite_url: null,
      state: "none" as const,
      channel: "unknown" as const,
      verdict: null,
      recorded: true,
      wiring,
      claims: [],
    });
    expect(agentsVerdict([row("match")], [], false).status).toBe("pass");
    expect(agentsVerdict([row("cross_wired")], [], false).status).toBe("fail");
  });
});

/* ------------------------------------------------------------------------- */
/* status --json                                                              */
/* ------------------------------------------------------------------------- */

async function doc(bx: Box, dir: string): Promise<StatusDocument> {
  return statusDocument({
    source: liveInventorySource(bx.fx.env),
    connection: readAgentConnection(bx.fx.env, dir).connection,
    legacy: legacyConnection(bx.fx.env),
    detect: async () => "none",
  });
}

describe("status --json", () => {
  test("two agents across two installs: both listed, distinct runtime ids and suite urls, string sessions", async () => {
    const bx = box();
    const { A, B } = agents();
    record(bx, bx.a, A);
    record(bx, bx.b, B);
    const d = await doc(bx, bx.a);
    expect(d.contract_version).toBe(1);
    expect(d.agents.map((r) => r.root)).toEqual([bx.a, bx.b]);
    expect(d.agents.map((r) => r.runtime_id)).toEqual([A.runtime, B.runtime]);
    expect(d.agents.map((r) => r.suite_url)).toEqual([A.url, B.url]);
    for (const r of d.agents) {
      expect(typeof r.session).toBe("string");
      expect(r.state).toBe("none");
      expect(r.recorded).toBe(true);
      expect(r.kind).toBeNull();
    }
    expect(d.agents[0]?.session).toBe(sessionNameFor({ naming: "cwd", cwd: bx.a }));
    expect(d.connection).toEqual({ dir: bx.a, suite_url: A.url, runtime_id: A.runtime });
    expect((await doc(bx, bx.elsewhere)).connection).toBeNull();
  });

  test("legacy only: legacy_connection is set and no row carries the legacy runtime id", async () => {
    const bx = box();
    const { A, B } = agents();
    const L: Agent = { url: "https://legacy.example.invalid", runtime: "rt-legacy-0000", token: canary("tokL") };
    writeLegacy(bx, L);
    // A folder with entries of its own, and a launched folder with nothing at all.
    writeClaudeJson(bx, { [bx.a]: A });
    writeRoster(bx, [{ session: "suite-b-x", command: ["tmux"], cwd: bx.b, kind: "claude", recordedAt: "" }]);
    const d = await doc(bx, bx.b);
    expect(d.legacy_connection).toEqual({ suite_url: L.url, runtime_id: L.runtime });
    expect(d.connection).toBeNull();
    expect(d.agents.length).toBe(2);
    expect(d.agents.some((r) => r.runtime_id === L.runtime)).toBe(false);
    expect(d.agents.some((r) => r.suite_url === L.url)).toBe(false);
    expect(d.agents.find((r) => r.root === bx.a)?.runtime_id).toBe(A.runtime);
    expect(d.agents.find((r) => r.root === bx.b)?.runtime_id).toBeNull();
    expect(d.agents.find((r) => r.root === bx.b)?.state).toBe("stale");
    void B;
  });

  test("a stamped agent's verdict and kind come from the roster; runtime from its own suite.json", async () => {
    const bx = box();
    writeFileSync(
      resolve(bx.c, ROOT_CONFIG_FILE),
      serializeConfig({ ...emptyConfig(), suiteUrl: "https://three.example.invalid", runtimeId: "rt-h-0000" }),
    );
    writeFileSync(resolve(bx.c, ".suite-stamp.json"), JSON.stringify({ verdict: "pass" }));
    writeRoster(bx, [{ session: "suite-h", command: ["tmux"], cwd: bx.c, kind: "hermes", recordedAt: "" }]);
    const d = await doc(bx, bx.c);
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0]).toMatchObject({ kind: "hermes", verdict: "pass", runtime_id: "rt-h-0000", recorded: false });
  });

  test("the CLI prints exactly one JSON document on stdout and no token anywhere", async () => {
    const bx = box();
    const { A, B, C } = agents();
    record(bx, bx.a, A);
    record(bx, bx.b, B);
    record(bx, bx.c, C);
    writeClaudeJson(bx, { [bx.a]: A });
    const cli = resolve(import.meta.dir, "..", "src", "cli.ts");
    const run = (cwd: string) =>
      Bun.spawnSync([process.execPath, cli, "status", "--json"], {
        cwd,
        env: { ...bx.fx.env, TMUX_TMPDIR: resolve(bx.fx.root, "tmux") } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
    const fromA = run(bx.a);
    const fromElsewhere = run(bx.elsewhere);
    for (const p of [fromA, fromElsewhere]) {
      expect(p.exitCode).toBe(0);
      const stdout = p.stdout.toString();
      // Exactly one document: it parses whole, and re-rendering it gives the same bytes.
      const parsed = JSON.parse(stdout) as StatusDocument;
      expect(renderStatusDocument(parsed)).toBe(stdout);
      expect(parsed.agents.map((r) => r.runtime_id)).toEqual([A.runtime, B.runtime, C.runtime]);
      expect(parsed.agents.every((r) => typeof r.session === "string")).toBe(true);
      for (const ag of [A, B, C]) {
        expect(scanTexts({ stdout, stderr: p.stderr.toString() }, ag.token)).toEqual([]);
      }
    }
    expect((JSON.parse(fromA.stdout.toString()) as StatusDocument).connection?.runtime_id).toBe(A.runtime);
    expect((JSON.parse(fromElsewhere.stdout.toString()) as StatusDocument).connection).toBeNull();
  });

  test("--dir names the connection from an unrelated working directory", async () => {
    const bx = box();
    const { A } = agents();
    record(bx, bx.a, A);
    const cli = resolve(import.meta.dir, "..", "src", "cli.ts");
    const p = Bun.spawnSync([process.execPath, cli, "status", "--json", "--dir", bx.a], {
      cwd: bx.elsewhere,
      env: { ...bx.fx.env, TMUX_TMPDIR: resolve(bx.fx.root, "tmux") } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((JSON.parse(p.stdout.toString()) as StatusDocument).connection?.runtime_id).toBe(A.runtime);
  });

  test("the emitted field lists are exactly STATUS_FIELDS and AGENT_FIELDS, and carry no token field", async () => {
    const bx = box();
    record(bx, bx.a, agents().A);
    const parsed = JSON.parse(renderStatusDocument(await doc(bx, bx.a))) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...STATUS_FIELDS]);
    expect(Object.keys((parsed.agents as Record<string, unknown>[])[0] ?? {})).toEqual([...AGENT_FIELDS]);
    for (const k of [...STATUS_FIELDS, ...AGENT_FIELDS]) expect(k).not.toMatch(/token/);
  });
});

/* ------------------------------------------------------------------------- */
/* Pure pieces                                                                */
/* ------------------------------------------------------------------------- */

describe("inventory primitives", () => {
  test("parseClaudeJson and parseMcpJson keep identity and drop every token", () => {
    const { A, B } = agents();
    const view = parseClaudeJson(
      JSON.stringify({ projects: { "/x": { mcpServers: servers(A) } }, mcpServers: { [CHANNEL_SERVER]: servers(B)[CHANNEL_SERVER] } }),
    );
    const text = JSON.stringify(view);
    expect(view?.projects["/x"]?.runtimeId).toBe(A.runtime);
    expect(view?.userScope).toEqual([{ name: CHANNEL_SERVER, runtimeId: B.runtime }]);
    expect(scanTexts({ view: text }, A.token)).toEqual([]);
    expect(scanTexts({ view: text }, B.token)).toEqual([]);
    const mcp = JSON.stringify(parseMcpJson(JSON.stringify({ mcpServers: servers(A) })));
    expect(scanTexts({ mcp }, A.token)).toEqual([]);
  });

  test("folderWiring: agreement is match, any disagreement is cross_wired, no record is unrecorded", () => {
    const rec = { dir: "/x", suiteUrl: "https://one.example.invalid", runtimeId: "rt-a", headerNames: [] };
    const id = (runtimeId: string, host: string) => ({
      runtimeId,
      channelUrl: `wss://${host}/runtime/ws`,
      toolsUrl: `https://${host}/mcp`,
    });
    expect(folderWiring(rec, id("rt-a", "one.example.invalid"), null).wiring).toBe("match");
    expect(folderWiring(rec, id("rt-b", "one.example.invalid"), null).wiring).toBe("cross_wired");
    expect(folderWiring(rec, id("rt-a", "two.example.invalid"), null).wiring).toBe("cross_wired");
    expect(folderWiring(rec, id("rt-a", "one.example.invalid"), id("rt-b", "one.example.invalid")).wiring).toBe("cross_wired");
    expect(folderWiring(null, id("rt-a", "one.example.invalid"), null).wiring).toBe("unrecorded");
    expect(folderWiring(rec, null, null).wiring).toBe("unknown");
    expect(folderWiring(rec, undefined, null).wiring).toBe("unknown");
  });

  test("a folder whose entries live under its git root is one row, not two", async () => {
    const src: InventorySource = {
      records: [{ record: { dir: "/repo/sub", suiteUrl: "https://one.example.invalid", runtimeId: "rt-a", headerNames: [] }, path: "/p" }],
      roster: [],
      claudeJson: { projects: { "/repo": { runtimeId: "rt-a", channelUrl: null, toolsUrl: "https://one.example.invalid/mcp" } }, userScope: [] },
      sessionNaming: "cwd",
      readFile: () => null,
      keysFor: (d) => (d === "/repo/sub" ? ["/repo/sub", "/repo"] : [d]),
    };
    const rows = await inventoryRows(src, async () => "none");
    expect(rows.map((r) => [r.root, r.wiring])).toEqual([["/repo/sub", "match"]]);
  });

  test("ROOT_CONFIG_FILE is deepseek's AGENT_CONFIG_FILE", () => {
    expect(ROOT_CONFIG_FILE).toBe(AGENT_CONFIG_FILE);
  });

  test("listAgentConnections and the inventory agree on the recorded folders", async () => {
    const bx = box();
    const { A, B } = agents();
    record(bx, bx.a, A);
    record(bx, bx.b, B);
    const rows = await inventoryRows(liveInventorySource(bx.fx.env), async () => "none");
    expect(rows.filter((r) => r.recorded).map((r) => r.root)).toEqual(listAgentConnections(bx.fx.env).map((c) => c.record.dir));
  });
});
