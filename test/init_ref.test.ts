/**
 * `suite init --suite-url --runtime-id --token-ref [--keychain-service] --json`
 * (task 01a0d6b9 stage 1): the non-interactive init the Mac app runs.
 *
 * A stub Suite answers `/mcp` over real HTTP (Bun.serve on 127.0.0.1), and
 * the live probe — in-process fetch, exactly what ships — talks to it. The
 * keychain is a fake `security` behind the injected exec seam. Every run has
 * its own HOME and XDG dirs, named with 01a0d6b9.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INIT_RESULT_FIELDS,
  isNonInteractiveInit,
  liveInitRefDeps,
  runInitRef,
  type InitRefDeps,
} from "../src/commands/init_ref.ts";
import { canary, scanTexts, scanTree } from "./leak-scan.ts";

let server: ReturnType<typeof Bun.serve>;
let goodToken = "";
const seen: Array<{ auth: string | null }> = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      const auth = req.headers.get("authorization");
      seen.push({ auth });
      if (auth !== `Bearer ${goodToken}`) {
        return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unauthorized" } }, { status: 401 });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }, { name: "b" }] } });
    },
  });
});
afterAll(() => server.stop(true));

let home: string;
let env: Record<string, string | undefined>;
let tmuxBin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), `suite-initref-01a0d6b9-${process.pid}-`));
  tmuxBin = join(home, "bin");
  mkdirSync(tmuxBin);
  writeFileSync(join(tmuxBin, "tmux"), "#!/bin/sh\necho 'tmux 3.5a'\n");
  chmodSync(join(tmuxBin, "tmux"), 0o755);
  env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    PATH: tmuxBin,
  };
  goodToken = canary("tok");
  seen.length = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const url = () => `http://127.0.0.1:${server.port}`;

/** A keychain that answers `goodToken` for the item, or exits `exit`. */
function keychain(answer: () => string, exit = 0) {
  const calls: string[][] = [];
  return {
    calls,
    resolve: {
      platform: "darwin" as const,
      exec: async (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        return exit === 0 ? { exitCode: 0, stdout: `${answer()}\n` } : { exitCode: exit, stdout: "" };
      },
    },
  };
}

function deps(over: Partial<InitRefDeps> = {}, kc = keychain(() => goodToken)): InitRefDeps & { kc: typeof kc } {
  return {
    ...liveInitRefDeps(env),
    platform: "darwin",
    resolve: kc.resolve,
    stdin: async () => "none",
    ...over,
    kc,
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) };
}

const ARGS = (extra: string[] = []) => [
  "--suite-url",
  url(),
  "--runtime-id",
  "rt-01a0d6b9",
  "--token-ref",
  "keychain:RUNTIME_TOKEN.rt-01a0d6b9",
  "--keychain-service",
  "suite-cli",
  "--json",
  "--no-supervisor",
  ...extra,
];

async function run(args: string[], d = deps()) {
  const sink = io();
  const code = await runInitRef(args, d, sink);
  const stdout = sink.out.join("");
  return { code, stdout, stderr: sink.err.join(""), doc: JSON.parse(stdout) as Record<string, any>, d };
}

const cfgPath = () => join(home, "config", "suite", "config.json");
const credPath = () => join(home, "config", "suite", "credentials.json");

describe("suite init --token-ref --json", () => {
  test("ok: one document, exit 0, config records the ref, the probe used the resolved token", async () => {
    const r = await run(ARGS());
    expect(r.code).toBe(0);
    expect(Object.keys(r.doc)).toEqual([...INIT_RESULT_FIELDS]);
    expect(r.doc).toMatchObject({
      contract_version: 1,
      ok: true,
      changed: true,
      connection: {
        suite_url: url(),
        runtime_id: "rt-01a0d6b9",
        token_ref: "keychain:RUNTIME_TOKEN.rt-01a0d6b9",
        keychain_service: "suite-cli",
      },
      watchdog: { requested: false, installed: null },
      human_steps: [],
      error: null,
    });
    expect(r.doc.deps.tmux).toEqual({ present: true, version: "3.5a", path: join(tmuxBin, "tmux") });
    expect(r.doc.deps.bun.present).toBe(true);
    expect(JSON.parse(readFileSync(cfgPath(), "utf8"))).toMatchObject({
      suiteUrl: url(),
      runtimeId: "rt-01a0d6b9",
      tokenRef: "keychain:RUNTIME_TOKEN.rt-01a0d6b9",
      keychainService: "suite-cli",
    });
    // The authenticated call happened, with the RESOLVED token, in memory.
    expect(seen.map((s) => s.auth === `Bearer ${goodToken}`)).toEqual([true]);
    expect(r.d.kc.calls).toEqual([
      ["/usr/bin/security", "find-generic-password", "-s", "suite-cli", "-a", "RUNTIME_TOKEN.rt-01a0d6b9", "-w"],
    ]);
  });

  test("ref mode writes NO token: byte check of credentials.json and a leak scan of every file, stream and argv", async () => {
    // A machine set up by an older init has a literal token saved. Ref mode must remove it.
    mkdirSync(join(home, "config", "suite"), { recursive: true });
    const old = canary("old");
    writeFileSync(credPath(), `${JSON.stringify({ token: old, headers: {} })}\n`, { mode: 0o600 });
    const r = await run(ARGS());
    expect(r.code).toBe(0);
    const bytes = readFileSync(credPath(), "utf8");
    expect(bytes).toBe(`${JSON.stringify({ token: "", headers: {} }, null, 2)}\n`);
    expect(bytes.includes(goodToken)).toBe(false);
    expect(bytes.includes(old)).toBe(false);
    const hits = [
      ...scanTree(home, goodToken),
      ...scanTexts({ stdout: r.stdout, stderr: r.stderr, argv: r.d.kc.calls.flat().join(" ") }, goodToken),
    ];
    expect(hits).toEqual([]);
    // Positive control: the same scan finds a planted copy.
    writeFileSync(join(home, "planted-01a0d6b9"), `x${goodToken}x`);
    expect(scanTree(home, goodToken).map((h) => h.where)).toEqual([join(home, "planted-01a0d6b9")]);
  });

  test("a second identical run reports changed: false and rewrites nothing", async () => {
    expect((await run(ARGS())).code).toBe(0);
    const before = readFileSync(cfgPath(), "utf8");
    const again = await run(ARGS());
    expect(again.code).toBe(0);
    expect(again.doc.changed).toBe(false);
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
  });

  test("credential rejected: exit 1, credential_rejected, config.json byte-identical", async () => {
    expect((await run(ARGS())).code).toBe(0);
    const before = readFileSync(cfgPath(), "utf8");
    const wrong = canary("wrong");
    const r = await run(
      ARGS().map((a) => (a === "rt-01a0d6b9" ? "rt-other-01a0d6b9" : a)),
      deps({}, keychain(() => wrong)),
    );
    expect(r.code).toBe(1);
    expect(r.doc.ok).toBe(false);
    expect(r.doc.error.code).toBe("credential_rejected");
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, wrong)).toEqual([]);
  });

  test("unreachable: exit 1 with a DIFFERENT code, and nothing is written", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    const r = await run(ARGS().map((a) => (a === url() ? `http://127.0.0.1:${port}` : a)));
    expect(r.code).toBe(1);
    expect(r.doc.error.code).toBe("suite_unreachable");
    expect(existsSync(cfgPath())).toBe(false);
  });

  test("keychain locked: exit 3, keychain_unlock with a command and a URL; nothing written, no probe", async () => {
    const r = await run(ARGS(), deps({}, keychain(() => "", 36)));
    expect(r.code).toBe(3);
    expect(r.doc.error.code).toBe("keychain_unavailable");
    expect(r.doc.human_steps).toEqual([
      expect.objectContaining({ kind: "keychain_unlock", command: expect.any(String), url: expect.stringMatching(/^https:\/\//) }),
    ]);
    expect(existsSync(cfgPath())).toBe(false);
    expect(seen).toEqual([]);
  });

  test("keychain item missing: exit 3, keychain_item_missing naming the put command", async () => {
    const r = await run(ARGS(), deps({}, keychain(() => "", 44)));
    expect(r.code).toBe(3);
    expect(r.doc.human_steps[0].kind).toBe("keychain_item_missing");
    expect(r.doc.human_steps[0].command).toBe("suite secret put --keychain-service suite-cli --item RUNTIME_TOKEN.rt-01a0d6b9");
  });

  test("a literal is refused with exit 2 in every spelling, before anything is read or written", async () => {
    const literal = canary("lit");
    const spellings = [
      [...ARGS(), "--token", literal],
      [...ARGS(), `--token=${literal}`],
      [...ARGS(), "--token-stdin"],
      ARGS().map((a) => (a === "keychain:RUNTIME_TOKEN.rt-01a0d6b9" ? literal : a)),
    ];
    for (const args of spellings) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(["literal_token_refused", "stdin_token_refused"]).toContain(r.doc.error.code);
      expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, literal)).toEqual([]);
      expect(r.d.kc.calls).toEqual([]);
    }
    // Data on stdin is refused too.
    const piped = await run(ARGS(), deps({ stdin: async () => "data" }));
    expect(piped.code).toBe(2);
    expect(piped.doc.error.code).toBe("stdin_token_refused");
    expect(existsSync(cfgPath())).toBe(false);
    expect(seen).toEqual([]);
  });

  test("tmux missing: exit 3 with install_tmux (command + official URL); init runs no package manager", async () => {
    env.PATH = join(home, "no-such-bin");
    const r = await run(ARGS());
    expect(r.code).toBe(3);
    expect(r.doc.error.code).toBe("tmux_missing");
    expect(r.doc.human_steps).toEqual([
      expect.objectContaining({ kind: "install_tmux", command: "brew install tmux", url: "https://github.com/tmux/tmux/wiki/Installing" }),
    ]);
    expect(r.doc.deps.tmux.present).toBe(false);
    expect(existsSync(cfgPath())).toBe(false);
  });

  test("missing flags and a bad URL are refused (exit 2)", async () => {
    expect((await run(["--json", "--runtime-id", "r", "--token-ref", "file:/x"])).doc.error.code).toBe("suite_url_required");
    expect((await run(["--json", "--suite-url", url(), "--token-ref", "file:/x"])).doc.error.code).toBe("runtime_id_required");
    expect((await run(["--json", "--suite-url", url(), "--runtime-id", "r"])).doc.error.code).toBe("token_ref_required");
    const bad = await run(["--json", "--suite-url", "ftp://x", "--runtime-id", "r", "--token-ref", "file:/x"]);
    expect(bad.code).toBe(2);
    expect(bad.doc.error.code).toBe("suite_url_invalid");
  });

  test("a file: ref works the same, with no keychain at all", async () => {
    const tokenFile = join(home, "runtime.token");
    writeFileSync(tokenFile, `${goodToken}\n`);
    chmodSync(tokenFile, 0o600);
    const args = ["--suite-url", url(), "--runtime-id", "rt-01a0d6b9", "--token-ref", `file:${tokenFile}`, "--json", "--no-supervisor"];
    const r = await run(args, deps({ platform: "linux" }, keychain(() => "unused")));
    expect(r.code).toBe(0);
    expect(r.doc.connection.keychain_service).toBeNull();
    expect(r.d.kc.calls).toEqual([]);
    expect(JSON.parse(readFileSync(cfgPath(), "utf8")).keychainService).toBeUndefined();
  });

  test("--install-bun on its own reports the deps and exits 0 (the launcher has installed bun)", async () => {
    const r = await run(["--install-bun", "--json"]);
    expect(r.code).toBe(0);
    expect(r.doc.ok).toBe(true);
    expect(r.doc.deps.bun.present).toBe(true);
    expect(existsSync(cfgPath())).toBe(false);
  });

  test("the prompt mode is still the default: only machine flags select this path", () => {
    expect(isNonInteractiveInit([])).toBe(false);
    expect(isNonInteractiveInit(["--no-supervisor"])).toBe(false);
    expect(isNonInteractiveInit(["--token-from-env", "SUITE_TOKEN"])).toBe(false);
    expect(isNonInteractiveInit(["--json"])).toBe(true);
    expect(isNonInteractiveInit(["--token=x"])).toBe(true);
    expect(isNonInteractiveInit(["--token-ref", "file:/x"])).toBe(true);
  });
});
