/**
 * `suite status --json` (task 01a0d6b9 stage 1): fixtures for every row shape
 * the Mac app renders — a live Claude agent whose channel is connected, a
 * stale one, a Hermes agent (token in a 0600 file), a codex agent (token in a
 * child's environment), an OpenClaw agent on a keychain ref — plus the
 * contract's field order. Nothing here touches a real tmux or HOME.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_FIELDS,
  STATUS_FIELDS,
  atRestOf,
  channelFromState,
  channelStatePath,
  renderStatusDocument,
  statusDocument,
  type StatusJsonDeps,
} from "../src/commands/status_json.ts";
import type { SuiteConfig } from "../src/config.ts";
import { rosterPath } from "../src/roster.ts";
import type { RunResult } from "../src/tmux.ts";
import { VERSION } from "../src/version.ts";

const HOME = "/fixture/home-01a0d6b9";
const ENV = { HOME, XDG_CONFIG_HOME: `${HOME}/.config`, XDG_STATE_HOME: `${HOME}/.local/state` };
const LIVE_PID = 4242;

const MACHINE: SuiteConfig = {
  suiteUrl: "https://suite.example.invalid",
  runtimeId: "rt-machine-01a0d6b9",
  headerNames: [],
  sessionNaming: "cwd",
  tokenRef: "keychain:RUNTIME_TOKEN.rt-machine-01a0d6b9",
  keychainService: "suite-cli",
};

const roster = {
  version: 1,
  agents: [
    { session: "suite-quasar", command: ["tmux"], cwd: "/agents/quasar", kind: "claude", recordedAt: "2026-10-05T00:00:00Z" },
    { session: "suite-nebula", command: ["tmux"], cwd: "/agents/nebula", kind: "claude", recordedAt: "2026-10-05T00:00:00Z" },
    { session: "suite-herm", command: ["tmux"], cwd: "/agents/herm", kind: "hermes", recordedAt: "2026-10-05T00:00:00Z" },
    { session: "suite-cdx", command: ["tmux"], cwd: "/agents/cdx", kind: "codex", recordedAt: "2026-10-05T00:00:00Z" },
    { session: "suite-oc", command: ["tmux"], cwd: "/agents/oc", kind: "openclaw", recordedAt: "2026-10-05T00:00:00Z" },
  ],
};

const claudeJson = {
  projects: {
    "/agents/quasar": {
      mcpServers: {
        "suite-channel": { env: { SUITE_RUNTIME_ID: "rt-quasar", SUITE_TOKEN: "keychain:RUNTIME_TOKEN.rt-quasar" } },
      },
    },
    "/agents/nebula": {
      mcpServers: { "suite-channel": { env: { SUITE_RUNTIME_ID: "rt-nebula", SUITE_TOKEN: "tok_literal_fixture_0000" } } },
    },
  },
};

const files: Record<string, string> = {
  [rosterPath(HOME)]: JSON.stringify(roster),
  [`${HOME}/.claude.json`]: JSON.stringify(claudeJson),
  [channelStatePath(ENV, "rt-quasar")]: JSON.stringify({ state: "joined", pid: LIVE_PID, at: "x" }),
  [channelStatePath(ENV, "rt-nebula")]: JSON.stringify({ state: "joined", pid: 999_999, at: "x" }),
  "/agents/herm/suite.json": JSON.stringify({ suiteUrl: "u", runtimeId: "rt-herm", headerNames: [], tokenRef: "keychain:RUNTIME_TOKEN.rt-herm" }),
  "/agents/herm/.suite-stamp.json": JSON.stringify({ verdict: "pass" }),
  "/agents/oc/suite.json": JSON.stringify({ suiteUrl: "u", runtimeId: "rt-oc", headerNames: [], tokenRef: "keychain:RUNTIME_TOKEN.rt-oc" }),
  "/agents/oc/.suite-stamp.json": JSON.stringify({ verdict: "fail" }),
  [`${HOME}/Library/LaunchAgents/technology.milvenan.suite-watch.plist`]: "<plist/>",
};

/** quasar, herm and oc are live; nebula and cdx have died (stale). */
function tmux() {
  const live: Record<string, string> = { "suite-quasar": "claude", "suite-herm": "hermes", "suite-oc": "openclaw-gateway" };
  const run = async (argv: string[]): Promise<RunResult> => {
    if (argv[1] === "list-panes") {
      const rows = Object.keys(live).map((s, i) => `${s}\t${100 + i}\t-sh`);
      rows.push("suite-nebula\t200\t-sh", "suite-cdx\t201\t-sh");
      return { exitCode: 0, stdout: rows.join("\n"), stderr: "" };
    }
    if (argv[0] === "ps") {
      const procs = Object.values(live).map((name, i) => `  ${300 + i}  ${100 + i} ${name} ${name}`);
      return { exitCode: 0, stdout: `  100 1 sh -sh\n${procs.join("\n")}`, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  return { env: {}, which: (n: string) => `/fixture/bin/${n}`, run };
}

function deps(over: Partial<StatusJsonDeps> = {}): StatusJsonDeps {
  return {
    env: ENV,
    platform: "darwin",
    home: HOME,
    config: MACHINE,
    tmux: tmux(),
    readFile: (p) => files[p] ?? null,
    watchdogLoaded: async () => true,
    pidAlive: (pid) => pid === LIVE_PID,
    ...over,
  };
}

describe("suite status --json", () => {
  test("the document: contract fields in order, the machine connection on a keychain ref, the watchdog", async () => {
    const doc = await statusDocument(deps());
    const parsed = JSON.parse(renderStatusDocument(doc));
    expect(Object.keys(parsed)).toEqual([...STATUS_FIELDS]);
    expect(parsed.contract_version).toBe(1);
    expect(parsed.suite_version).toBe(VERSION);
    expect(parsed.connection).toEqual({
      suite_url: "https://suite.example.invalid",
      runtime_id: "rt-machine-01a0d6b9",
      token_ref: "keychain:RUNTIME_TOKEN.rt-machine-01a0d6b9",
      token_at_rest: "keychain",
    });
    expect(parsed.watchdog).toEqual({ installed: true, loaded: true });
    for (const a of parsed.agents) expect(Object.keys(a)).toEqual([...AGENT_FIELDS]);
  });

  test("every row shape", async () => {
    const byName = Object.fromEntries((await statusDocument(deps())).agents.map((a) => [a.session, a]));
    expect(byName["suite-quasar"]).toEqual({
      session: "suite-quasar",
      kind: "claude",
      root: "/agents/quasar",
      runtime_id: "rt-quasar",
      state: "live",
      channel: "connected",
      verdict: null,
      token_at_rest: "keychain",
      token_in_child_env: false,
    });
    // Stale: its channel file says joined, but the pid is dead -> not connected.
    // Literal SUITE_TOKEN: inline at rest AND in the channel child's env.
    expect(byName["suite-nebula"]).toMatchObject({ state: "stale", channel: "not_connected", token_at_rest: "inline", token_in_child_env: true });
    // v3 architect note 2: Hermes's token is a 0600 file, whatever ref it was stamped with.
    expect(byName["suite-herm"]).toMatchObject({ kind: "hermes", runtime_id: "rt-herm", state: "live", verdict: "pass", token_at_rest: "file", token_in_child_env: false, channel: "unknown" });
    // codex: the bridge hands the token to app-server's env (0.7.0 design).
    expect(byName["suite-cdx"]).toMatchObject({ kind: "codex", runtime_id: "rt-machine-01a0d6b9", state: "stale", token_at_rest: "keychain", token_in_child_env: true });
    expect(byName["suite-oc"]).toMatchObject({ kind: "openclaw", runtime_id: "rt-oc", verdict: "fail", token_at_rest: "keychain", token_in_child_env: false });
  });

  test("no roster, no connection: an empty, still well-formed document", async () => {
    const doc = await statusDocument(deps({ config: null, readFile: () => null, watchdogLoaded: async () => false }));
    expect(doc.agents).toEqual([]);
    expect(doc.connection).toEqual({ suite_url: "", runtime_id: "", token_ref: null, token_at_rest: "none" });
    expect(doc.watchdog).toEqual({ installed: false, loaded: false });
  });

  test("token_at_rest is decided by shape and never keeps a value", () => {
    expect(atRestOf("keychain:x")).toBe("keychain");
    expect(atRestOf("file:/x")).toBe("file");
    expect(atRestOf("${SUITE_TOKEN}")).toBe("env");
    expect(atRestOf("anything-else")).toBe("inline");
    expect(atRestOf("")).toBe("none");
    expect(atRestOf(undefined)).toBe("none");
  });

  test("channel: connected only for joined + live pid; unreadable is unknown", () => {
    const alive = (p: number) => p === 1;
    expect(channelFromState(JSON.stringify({ state: "joined", pid: 1 }), alive)).toBe("connected");
    expect(channelFromState(JSON.stringify({ state: "disconnected", pid: 1 }), alive)).toBe("not_connected");
    expect(channelFromState(JSON.stringify({ state: "joined", pid: 2 }), alive)).toBe("not_connected");
    expect(channelFromState(null, alive)).toBe("unknown");
    expect(channelFromState("{nope", alive)).toBe("unknown");
  });

  test("the document carries no token value even when a literal sits in ~/.claude.json", async () => {
    const text = renderStatusDocument(await statusDocument(deps()));
    expect(text).not.toContain("tok_literal_fixture_0000");
    // Positive control: the literal IS in what status read.
    expect(files[`${HOME}/.claude.json`]).toContain("tok_literal_fixture_0000");
  });
});
