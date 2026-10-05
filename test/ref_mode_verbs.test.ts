/**
 * How each verb treats a REF-MODE machine connection (task 01a0d6b9 stage 1):
 *
 *   hermes / openclaw   --token-ref defaults to the machine's ref, for the
 *                       machine's own runtime only (stamp.ts machineFallback)
 *   deepseek            refused, exit 2, token_ref_unsupported (a follow-up)
 *   codex               resolves the ref in memory (loadCredentials)
 *   doctor              compares REFS in the token-match check, and probes
 *                       the tools endpoint with the ref resolved in memory
 *   install.sh          SUITE_CLI_REF=<40-hex sha> fetches the codeload
 *                       tarball BY COMMIT (suite-cli has no tags)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks, type DoctorDeps } from "../src/commands/doctor.ts";
import { loadCredentials, runDeepseek, TOKEN_REF_UNSUPPORTED_EXIT, type DeepseekDeps } from "../src/commands/deepseek.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "../src/commands/init.ts";
import type { SuiteConfig } from "../src/config.ts";
import { TOKEN_KEY } from "../src/secrets.ts";
import { machineFallback, readMachineConnection } from "../src/stamp.ts";
import { canary } from "./leak-scan.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-refverbs-01a0d6b9-${process.pid}-`));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MACHINE = { suiteUrl: "https://suite.example.invalid", runtimeId: "rt-machine", tokenRef: "keychain:RUNTIME_TOKEN.rt-machine", keychainService: "suite-cli" };

describe("hermes/openclaw: --token-ref defaults to the machine ref", () => {
  test("no flag, nothing recorded: the machine connection is the default", () => {
    expect(machineFallback({ machine: MACHINE }, null)).toEqual(MACHINE);
    expect(machineFallback({ machine: MACHINE, runtimeId: "rt-machine" }, null)).toEqual(MACHINE);
  });

  test("an explicit --token-ref, a ref the root records, or ANOTHER runtime id: no fallback", () => {
    expect(machineFallback({ machine: MACHINE, tokenRef: "file:/x" }, null)).toBeNull();
    const recorded = { suiteUrl: "u", runtimeId: "rt-machine", headerNames: [], sessionNaming: "cwd" as const, tokenRef: "file:/root" };
    expect(machineFallback({ machine: MACHINE }, recorded)).toBeNull();
    // The machine's token is never handed to a different runtime.
    expect(machineFallback({ machine: MACHINE, runtimeId: "rt-other" }, null)).toBeNull();
    expect(machineFallback({ machine: MACHINE }, { ...recorded, tokenRef: undefined, runtimeId: "rt-other" })).toBeNull();
    expect(machineFallback({ machine: null }, null)).toBeNull();
  });

  test("readMachineConnection reads only a ref-mode config, and never throws without HOME", async () => {
    expect(await readMachineConnection({})).toBeNull();
    const cfgDir = join(dir, "suite");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ ...MACHINE, headerNames: [] }));
    expect(await readMachineConnection({ HOME: dir, XDG_CONFIG_HOME: dir })).toEqual(MACHINE);
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ suiteUrl: "u", runtimeId: "r", headerNames: [] }));
    expect(await readMachineConnection({ HOME: dir, XDG_CONFIG_HOME: dir })).toBeNull();
  });
});

describe("deepseek in ref mode", () => {
  test("refused with exit 2, token_ref_unsupported, naming the ref", async () => {
    const root = join(dir, "agent");
    mkdirSync(root);
    writeFileSync(join(root, "suite.json"), JSON.stringify({ ...MACHINE, headerNames: [] }));
    let err = "";
    const code = await runDeepseek(["--root", root], {
      which: () => null,
      isTTY: () => false,
      run: async () => 0,
      exec: async () => 0,
      stderr: { write: (t: string) => void (err += t) },
    } as unknown as DeepseekDeps);
    expect(code).toBe(TOKEN_REF_UNSUPPORTED_EXIT);
    expect(code).toBe(2);
    expect(err).toContain("token_ref_unsupported");
    expect(err).toContain("keychain:RUNTIME_TOKEN.rt-machine");
  });
});

describe("codex in ref mode: loadCredentials resolves the ref in memory", () => {
  test("a file ref resolves to the token; nothing is read from credentials.json without header names", async () => {
    const token = canary("tok");
    const p = join(dir, "runtime.token");
    writeFileSync(p, `${token}\n`);
    chmodSync(p, 0o600);
    const config: SuiteConfig = { suiteUrl: "u", runtimeId: "r", headerNames: [], sessionNaming: "cwd", tokenRef: `file:${p}` };
    expect(await loadCredentials(config, {} as DeepseekDeps)).toEqual({ [TOKEN_KEY]: token });
  });

  test("a keychain ref goes through the injected security, names only in argv", async () => {
    const token = canary("tok");
    const calls: string[][] = [];
    const config: SuiteConfig = { ...MACHINE, headerNames: [], sessionNaming: "cwd" };
    const out = await loadCredentials(config, {} as DeepseekDeps, {
      platform: "darwin",
      exec: async (bin, args) => (calls.push([bin, ...args]), { exitCode: 0, stdout: `${token}\n` }),
    });
    expect(out[TOKEN_KEY]).toBe(token);
    expect(calls).toEqual([["/usr/bin/security", "find-generic-password", "-s", "suite-cli", "-a", "RUNTIME_TOKEN.rt-machine", "-w"]]);
  });
});

describe("doctor in ref mode", () => {
  const REF = "keychain:RUNTIME_TOKEN.rt-machine";
  const HELPER = `'/bun' '/cli.ts' 'mcp-headers' '--token-ref' '${REF}' '--keychain-service' 'suite-cli'`;

  function deps(over: { channelToken?: string; helper?: string | null; inlineAuth?: boolean; resolved?: string | null } = {}) {
    const probes: Array<Record<string, string>> = [];
    const run = async (argv: string[]) => {
      const [bin, ...args] = argv;
      const name = (bin ?? "").split("/").pop();
      if (name === "claude" && args[0] === "mcp" && args[1] === "get" && args[2] === CHANNEL_SERVER) {
        return { exitCode: 0, stderr: "", stdout: `${CHANNEL_SERVER}:\n  Type: stdio\n  Command: bun\n  Args: /x/src/index.ts\n  Environment:\n    SUITE_URL=wss://suite.example.invalid/runtime/ws\n    SUITE_TOKEN=${over.channelToken ?? REF}\n` };
      }
      if (name === "claude" && args[0] === "mcp" && args[1] === "get" && args[2] === TOOLS_SERVER) {
        const headers = over.inlineAuth ? "\n  Headers:\n    Authorization: Bearer leftover-literal" : "";
        return { exitCode: 0, stderr: "", stdout: `${TOOLS_SERVER}:\n  Type: http\n  URL: https://suite.example.invalid/mcp${headers}\n` };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const d: DoctorDeps = {
      env: {},
      cwd: "/agents/quasar",
      run,
      which: (n) => `/fixture/bin/${n}`,
      exists: () => true,
      config: { suiteUrl: "https://suite.example.invalid", runtimeId: "rt-machine", headerNames: [], sessionNaming: "cwd", tokenRef: REF, keychainService: "suite-cli" },
      configFile: "/fixture/config.json",
      tmux: { env: {}, which: (n) => `/fixture/bin/${n}`, run },
      probe: async (req) => {
        probes.push(req.headers);
        return req.headers.Authorization === "Bearer good"
          ? { status: 200, body: JSON.stringify({ result: { tools: [{ name: "x" }] } }), contentType: "application/json" }
          : { status: 401, body: JSON.stringify({ error: { code: -32000, message: "unauthorized" } }), contentType: "application/json" };
      },
      resolveRef: async () => {
        if (over.resolved === null) throw new Error("locked");
        return over.resolved ?? "good";
      },
      toolsHelper: () => (over.helper === undefined ? HELPER : over.helper),
      color: false,
      utf8: false,
      out: () => {},
    };
    return { d, probes };
  }

  const find = async (d: DoctorDeps, id: string) => (await runChecks(d)).find((c) => c.id === id);

  test("both entries naming the ref pass, and the probe authenticates with the ref resolved in memory", async () => {
    const { d, probes } = deps();
    expect(await find(d, "tokens")).toMatchObject({ status: "pass", value: "both entries use the ref", detail: REF });
    expect(await find(d, "tools")).toMatchObject({ status: "pass", value: "authenticated" });
    expect(probes.at(-1)?.Authorization).toBe("Bearer good");
  });

  test("a channel entry on another token, a missing helper, or a leftover inline bearer each fail", async () => {
    expect((await find(deps({ channelToken: "keychain:OTHER" }).d, "tokens"))?.status).toBe("fail");
    expect((await find(deps({ helper: null }).d, "tokens"))?.status).toBe("fail");
    expect((await find(deps({ inlineAuth: true }).d, "tokens"))?.status).toBe("fail");
  });

  test("an unresolvable ref fails the tools check without probing; a wrong one is rejected", async () => {
    const locked = deps({ resolved: null });
    expect(await find(locked.d, "tools")).toMatchObject({ status: "fail", value: "token ref unresolved" });
    expect(locked.probes).toEqual([]);
    expect(await find(deps({ resolved: "bad" }).d, "tools")).toMatchObject({ status: "fail", value: "credential rejected" });
  });
});

describe("install.sh SUITE_CLI_REF", () => {
  function fetchedUrl(ref: string): string {
    const bin = join(dir, `bin-${ref.length}`);
    mkdirSync(bin, { recursive: true });
    const log = join(dir, `url-${ref.length}.log`);
    // A curl that records the URL it was asked for, then fails the download.
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) printf '%s\\n' "$a" > '${log}';; esac; done\nexit 22\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const r = spawnSync("sh", [join(import.meta.dir, "..", "install.sh")], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, SUITE_CLI_REF: ref, GH_TOKEN: "" },
    });
    expect(r.status).not.toBe(0);
    return readFileSync(log, "utf8").trim();
  }

  test("a 40-hex commit sha fetches the codeload tarball by commit", () => {
    const sha = "450346c7d85c3b7084acba57f60f275acc0f556c";
    expect(fetchedUrl(sha)).toBe(`https://codeload.github.com/Startup-Suite/suite-cli/tar.gz/${sha}`);
  });

  test("positive control: a branch name goes through refs/heads", () => {
    expect(fetchedUrl("main")).toBe("https://codeload.github.com/Startup-Suite/suite-cli/tar.gz/refs/heads/main");
  });
});
